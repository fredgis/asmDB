package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/to"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appcontainers/armappcontainers/v3"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/monitor/armmonitor"
)

type liveState struct {
	State string
	Error string
}

type provisioner interface {
	Create(context.Context, instance, string) (string, error)
	GetState(context.Context, instance) (liveState, error)
	Delete(context.Context, instance) error
	RotateToken(context.Context, instance, string, func(string)) error
	UpgradeImage(context.Context, instance, string, func(string)) error
	ReplicaAverages(context.Context, instance, time.Time, time.Time, time.Duration) ([]replicaSample, error)
	Endpoint(instance) string
	InternalEndpoint(instance) string
}

type replicaSample struct {
	Timestamp time.Time
	Average   float64
}

type tierSpec struct {
	CPU         float64
	Memory      string
	MinReplicas int32
	MaxReplicas int32
	Quota       int
	// Capacity names the engine's slot-table size. The table is anonymous
	// memory, not a file mapping, so its size is charged against the tier's
	// memory allowance: a 2^22-slot table is exactly 1 GiB of RAM. Sizing it
	// per tier is what keeps the smallest tier from allocating a table larger
	// than the memory it was given.
	Capacity string
	// MaxRows is the usable row count, which is the slot count capped by the
	// 0.75 load factor the engine enforces. It is published to customers, so
	// it must match what the engine actually refuses to exceed.
	MaxRows int
}

// Quota is a per-account cap. It is bounded by what the platform can actually
// serve, not by what sounds generous: every instance keeps its own file on the
// shared NFS volume, and Azure Files NFS does not honour sparseness, so a
// database occupies its full table size on disk from the day it is created.
// With a 100 GiB share that is roughly 800 free, 200 standard or 100 premium
// databases in total — across every account. A per-account premium cap of 100
// would therefore let a single customer consume the entire platform, which is a
// promise the service cannot keep. Raising these caps requires growing the
// share first.
var tierSpecs = map[string]tierSpec{
	"free":     {CPU: 0.25, Memory: "0.5Gi", MinReplicas: 0, MaxReplicas: 1, Quota: 3, Capacity: "small", MaxRows: 393216},
	"standard": {CPU: 0.5, Memory: "1Gi", MinReplicas: 0, MaxReplicas: 1, Quota: 20, Capacity: "medium", MaxRows: 1572864},
	"premium":  {CPU: 1.0, Memory: "2Gi", MinReplicas: 1, MaxReplicas: 1, Quota: 10, Capacity: "large", MaxRows: 3145728},
}

type azureProvisioner struct {
	apps           *armappcontainers.ContainerAppsClient
	revisions      *armappcontainers.ContainerAppsRevisionsClient
	metrics        *armmonitor.MetricsClient
	resourceGroup  string
	subscriptionID string
	location       string
	environmentID  string
	environmentDNS string
	image          string
	registryServer string
	identityID     string
	envStorage     string
	publicBase     string
	platformSecret string
}

func newAzureProvisioner(ctx context.Context, cfg config, cred azcore.TokenCredential) (*azureProvisioner, error) {
	// Checked before anything else: without a volume the engine writes to the
	// container's own filesystem, which Container Apps discards on every restart
	// and on every scale to zero. Refusing to start is the only safe answer — a
	// database service that silently loses data is worse than one that will not
	// boot.
	if cfg.EnvStorage == "" {
		return nil, errors.New("ASMDB_ENV_STORAGE is empty: instances would have no durable volume")
	}
	apps, err := armappcontainers.NewContainerAppsClient(cfg.SubscriptionID, cred, nil)
	if err != nil {
		return nil, err
	}
	revisions, err := armappcontainers.NewContainerAppsRevisionsClient(cfg.SubscriptionID, cred, nil)
	if err != nil {
		return nil, err
	}
	metrics, err := armmonitor.NewMetricsClient(cfg.SubscriptionID, cred, nil)
	if err != nil {
		return nil, err
	}
	envs, err := armappcontainers.NewManagedEnvironmentsClient(cfg.SubscriptionID, cred, nil)
	if err != nil {
		return nil, err
	}
	envResp, err := envs.Get(ctx, cfg.ResourceGroup, cfg.Environment, nil)
	if err != nil {
		return nil, fmt.Errorf("read Container Apps environment %q: %w", cfg.Environment, err)
	}
	if envResp.ID == nil || envResp.Properties == nil || envResp.Properties.DefaultDomain == nil {
		return nil, fmt.Errorf("Container Apps environment %q has no id or default domain", cfg.Environment)
	}
	if cfg.PublicBase == "" {
		log.Printf("ASMDB_PUBLIC_BASE is empty; instance endpoints will use internal Container Apps DNS and will not be reachable by customers")
	}

	identityID := fmt.Sprintf("/subscriptions/%s/resourceGroups/%s/providers/Microsoft.ManagedIdentity/userAssignedIdentities/asmdb-mi", cfg.SubscriptionID, cfg.ResourceGroup)
	return &azureProvisioner{
		apps:           apps,
		revisions:      revisions,
		metrics:        metrics,
		resourceGroup:  cfg.ResourceGroup,
		subscriptionID: cfg.SubscriptionID,
		location:       cfg.Location,
		environmentID:  *envResp.ID,
		environmentDNS: *envResp.Properties.DefaultDomain,
		image:          cfg.Image,
		registryServer: registryServer(cfg.Image),
		identityID:     identityID,
		envStorage:     cfg.EnvStorage,
		publicBase:     strings.TrimRight(cfg.PublicBase, "/"),
		platformSecret: cfg.PlatformSecret,
	}, nil
}

func (p *azureProvisioner) Create(ctx context.Context, in instance, token string) (string, error) {
	app, err := p.buildContainerApp(in, token)
	if err != nil {
		return "", err
	}

	if _, err := p.apps.BeginCreateOrUpdate(ctx, p.resourceGroup, in.ContainerAppName, app, nil); err != nil {
		return "", err
	}
	return p.Endpoint(in), nil
}

// buildContainerApp is kept separate from Create so the shape of the app can be
// asserted in tests without an Azure subscription.
func (p *azureProvisioner) buildContainerApp(in instance, token string) (armappcontainers.ContainerApp, error) {
	spec, ok := tierSpecs[in.Tier]
	if !ok {
		return armappcontainers.ContainerApp{}, fmt.Errorf("unknown tier %q", in.Tier)
	}

	env := []*armappcontainers.EnvironmentVar{
		{Name: to.Ptr("ASMDB_TOKEN"), Value: to.Ptr(token)},
		{Name: to.Ptr("ASMDB_NAME"), Value: to.Ptr("main")},
		{Name: to.Ptr("ASMDB_DATA"), Value: to.Ptr("/data")},
		{Name: to.Ptr("PORT"), Value: to.Ptr("8080")},
		// Only consulted when the engine creates the database file; on every
		// later start the capacity recorded in the file header wins, so
		// changing this variable never silently reshapes an existing database.
		{Name: to.Ptr("ASMDB_CAPACITY"), Value: to.Ptr(spec.Capacity)},
	}
	if p.platformSecret != "" {
		env = append(env, &armappcontainers.EnvironmentVar{
			Name:  to.Ptr("ASMDB_PLATFORM_TOKEN"),
			Value: to.Ptr(derivePlatformToken(p.platformSecret, in.ID)),
		})
	}

	app := armappcontainers.ContainerApp{
		Location: to.Ptr(p.location),
		Identity: &armappcontainers.ManagedServiceIdentity{
			Type: to.Ptr(armappcontainers.ManagedServiceIdentityTypeUserAssigned),
			UserAssignedIdentities: map[string]*armappcontainers.UserAssignedIdentity{
				p.identityID: &armappcontainers.UserAssignedIdentity{},
			},
		},
		Properties: &armappcontainers.ContainerAppProperties{
			EnvironmentID: to.Ptr(p.environmentID),
			Configuration: &armappcontainers.Configuration{
				ActiveRevisionsMode: to.Ptr(armappcontainers.ActiveRevisionsModeSingle),
				Ingress: &armappcontainers.Ingress{
					External:   to.Ptr(true),
					TargetPort: to.Ptr[int32](8080),
					Transport:  to.Ptr(armappcontainers.IngressTransportMethodAuto),
				},
				Registries: []*armappcontainers.RegistryCredentials{
					{
						Server:   to.Ptr(p.registryServer),
						Identity: to.Ptr(p.identityID),
					},
				},
			},
			Template: &armappcontainers.Template{
				Containers: []*armappcontainers.Container{
					{
						Name:  to.Ptr("asmdb"),
						Image: to.Ptr(p.image),
						Env:   env,
						Resources: &armappcontainers.ContainerResources{
							CPU:    to.Ptr(spec.CPU),
							Memory: to.Ptr(spec.Memory),
						},
						VolumeMounts: []*armappcontainers.VolumeMount{
							{
								VolumeName: to.Ptr("data"),
								MountPath:  to.Ptr("/data"),
								SubPath:    to.Ptr(in.ID),
							},
						},
					},
				},
				// One NFS share is shared by every instance; the sub-path is the
				// instance id, so each database owns a directory and sees no other.
				Volumes: []*armappcontainers.Volume{
					{
						Name:        to.Ptr("data"),
						StorageType: to.Ptr(armappcontainers.StorageTypeNfsAzureFile),
						StorageName: to.Ptr(p.envStorage),
					},
				},
				Scale: &armappcontainers.Scale{
					MinReplicas: to.Ptr(spec.MinReplicas),
					MaxReplicas: to.Ptr(spec.MaxReplicas),
				},
			},
		},
	}

	return app, nil
}

func (p *azureProvisioner) GetState(ctx context.Context, in instance) (liveState, error) {
	resp, err := p.apps.Get(ctx, p.resourceGroup, in.ContainerAppName, nil)
	if err != nil {
		if isAzureNotFound(err) {
			return liveState{State: "deleting"}, nil
		}
		return liveState{}, err
	}
	return mapContainerAppState(resp.ContainerApp), nil
}

func (p *azureProvisioner) Delete(ctx context.Context, in instance) error {
	_, err := p.apps.BeginDelete(ctx, p.resourceGroup, in.ContainerAppName, nil)
	if isAzureNotFound(err) {
		return nil
	}
	return err
}

func (p *azureProvisioner) RotateToken(ctx context.Context, in instance, token string, progress func(string)) error {
	return p.updateContainerApp(ctx, in, progress, func(container *armappcontainers.Container) {
		setContainerEnv(container, "ASMDB_TOKEN", token)
	})
}

func (p *azureProvisioner) UpgradeImage(ctx context.Context, in instance, image string, progress func(string)) error {
	return p.updateContainerApp(ctx, in, progress, func(container *armappcontainers.Container) {
		container.Image = to.Ptr(image)
	})
}

func (p *azureProvisioner) updateContainerApp(ctx context.Context, in instance, progress func(string), update func(*armappcontainers.Container)) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Minute)
	defer cancel()
	return updateContainerAppStopThenStart(ctx, p, in, progress, update)
}

type containerAppUpdateBackend interface {
	GetContainerApp(context.Context, instance) (armappcontainers.ContainerApp, error)
	StopContainerApp(context.Context, instance) error
	CreateOrUpdateContainerApp(context.Context, instance, armappcontainers.ContainerApp) error
	StartContainerApp(context.Context, instance) error
	WaitContainerAppReady(context.Context, instance) error
}

func updateContainerAppStopThenStart(ctx context.Context, backend containerAppUpdateBackend, in instance, progress func(string), update func(*armappcontainers.Container)) error {
	previous, err := backend.GetContainerApp(ctx, in)
	if err != nil {
		return err
	}
	restore, err := cloneContainerApp(previous)
	if err != nil {
		return err
	}
	app, err := cloneContainerApp(previous)
	if err != nil {
		return err
	}
	if app.Properties == nil || app.Properties.Template == nil || len(app.Properties.Template.Containers) == 0 {
		return fmt.Errorf("container app %q has no container template", in.ContainerAppName)
	}

	// asmdb is a single-writer engine with an exclusive file lock and every
	// tier has maxReplicas=1. A rolling Container Apps revision can deadlock:
	// the replacement cannot open the database while the outgoing revision is
	// still alive, and the outgoing revision is not retired until the new one is
	// healthy. Stop first, then update, then start and wait for readiness.
	if !containerAppIsStopped(previous) {
		reportProgress(progress, "stopping")
		if err := backend.StopContainerApp(ctx, in); err != nil {
			return fmt.Errorf("stop instance before update: %w", err)
		}
	}

	container := app.Properties.Template.Containers[0]
	for _, candidate := range app.Properties.Template.Containers {
		if candidate.Name != nil && *candidate.Name == "asmdb" {
			container = candidate
			break
		}
	}
	update(container)

	if err := backend.CreateOrUpdateContainerApp(ctx, in, app); err != nil {
		return rollbackContainerAppUpdate(ctx, backend, in, restore, fmt.Errorf("apply instance update: %w", err))
	}
	reportProgress(progress, "starting")
	if err := backend.StartContainerApp(ctx, in); err != nil {
		return rollbackContainerAppUpdate(ctx, backend, in, restore, fmt.Errorf("start updated instance: %w", err))
	}
	reportProgress(progress, "verifying_health")
	if err := backend.WaitContainerAppReady(ctx, in); err != nil {
		return rollbackContainerAppUpdate(ctx, backend, in, restore, fmt.Errorf("updated instance did not become healthy: %w", err))
	}
	return nil
}

func reportProgress(progress func(string), state string) {
	if progress != nil {
		progress(state)
	}
}

func rollbackContainerAppUpdate(ctx context.Context, backend containerAppUpdateBackend, in instance, restore armappcontainers.ContainerApp, cause error) error {
	if err := backend.CreateOrUpdateContainerApp(ctx, in, restore); err != nil {
		return fmt.Errorf("%w; rollback apply failed: %v", cause, err)
	}
	if err := backend.StartContainerApp(ctx, in); err != nil {
		return fmt.Errorf("%w; rollback start failed: %v", cause, err)
	}
	if err := backend.WaitContainerAppReady(ctx, in); err != nil {
		return fmt.Errorf("%w; rollback did not become healthy: %v", cause, err)
	}
	return fmt.Errorf("%w; rolled back to the previous revision", cause)
}

func cloneContainerApp(app armappcontainers.ContainerApp) (armappcontainers.ContainerApp, error) {
	data, err := json.Marshal(app)
	if err != nil {
		return armappcontainers.ContainerApp{}, err
	}
	var cloned armappcontainers.ContainerApp
	if err := json.Unmarshal(data, &cloned); err != nil {
		return armappcontainers.ContainerApp{}, err
	}
	return cloned, nil
}

func containerAppIsStopped(app armappcontainers.ContainerApp) bool {
	return app.Properties != nil &&
		app.Properties.RunningStatus != nil &&
		*app.Properties.RunningStatus == armappcontainers.ContainerAppRunningStatusStopped
}

func (p *azureProvisioner) GetContainerApp(ctx context.Context, in instance) (armappcontainers.ContainerApp, error) {
	resp, err := p.apps.Get(ctx, p.resourceGroup, in.ContainerAppName, nil)
	if err != nil {
		return armappcontainers.ContainerApp{}, err
	}
	return resp.ContainerApp, nil
}

func (p *azureProvisioner) StopContainerApp(ctx context.Context, in instance) error {
	poller, err := p.apps.BeginStop(ctx, p.resourceGroup, in.ContainerAppName, nil)
	if err != nil {
		return err
	}
	if _, err := poller.PollUntilDone(ctx, nil); err != nil {
		return err
	}
	return p.waitContainerAppStatus(ctx, in, func(props *armappcontainers.ContainerAppProperties) (bool, error) {
		return props.RunningStatus != nil && *props.RunningStatus == armappcontainers.ContainerAppRunningStatusStopped, nil
	})
}

func (p *azureProvisioner) CreateOrUpdateContainerApp(ctx context.Context, in instance, app armappcontainers.ContainerApp) error {
	poller, err := p.apps.BeginCreateOrUpdate(ctx, p.resourceGroup, in.ContainerAppName, app, nil)
	if err != nil {
		return err
	}
	_, err = poller.PollUntilDone(ctx, nil)
	return err
}

func (p *azureProvisioner) StartContainerApp(ctx context.Context, in instance) error {
	poller, err := p.apps.BeginStart(ctx, p.resourceGroup, in.ContainerAppName, nil)
	if err != nil {
		return err
	}
	_, err = poller.PollUntilDone(ctx, nil)
	return err
}

func (p *azureProvisioner) WaitContainerAppReady(ctx context.Context, in instance) error {
	return p.waitContainerAppStatus(ctx, in, func(props *armappcontainers.ContainerAppProperties) (bool, error) {
		if props.ProvisioningState != nil && *props.ProvisioningState == armappcontainers.ContainerAppProvisioningStateFailed {
			return false, errors.New("container app provisioning failed")
		}
		if props.LatestRevisionName == nil || props.LatestReadyRevisionName == nil || *props.LatestRevisionName != *props.LatestReadyRevisionName {
			if props.LatestRevisionName != nil && p.revisions != nil {
				rev, err := p.revisions.GetRevision(ctx, p.resourceGroup, in.ContainerAppName, *props.LatestRevisionName, nil)
				if err == nil && rev.Properties != nil && rev.Properties.HealthState != nil && *rev.Properties.HealthState == armappcontainers.RevisionHealthStateUnhealthy {
					if rev.Properties.ProvisioningError != nil && *rev.Properties.ProvisioningError != "" {
						return false, fmt.Errorf("latest revision unhealthy: %s", *rev.Properties.ProvisioningError)
					}
					return false, errors.New("latest revision unhealthy")
				}
			}
			return false, nil
		}
		return props.RunningStatus != nil && (*props.RunningStatus == armappcontainers.ContainerAppRunningStatusRunning || *props.RunningStatus == armappcontainers.ContainerAppRunningStatusReady), nil
	})
}

func (p *azureProvisioner) waitContainerAppStatus(ctx context.Context, in instance, ready func(*armappcontainers.ContainerAppProperties) (bool, error)) error {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		resp, err := p.apps.Get(ctx, p.resourceGroup, in.ContainerAppName, nil)
		if err != nil {
			return err
		}
		if resp.Properties != nil {
			ok, err := ready(resp.Properties)
			if err != nil {
				return err
			}
			if ok {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (p *azureProvisioner) ReplicaAverages(ctx context.Context, in instance, from, toTime time.Time, grain time.Duration) ([]replicaSample, error) {
	timespan := from.UTC().Format(time.RFC3339) + "/" + toTime.UTC().Format(time.RFC3339)
	interval := iso8601Duration(grain)
	metricName := "Replicas"
	aggregation := "Average"
	namespace := "Microsoft.App/containerApps"
	resourceID := fmt.Sprintf("/subscriptions/%s/resourceGroups/%s/providers/Microsoft.App/containerApps/%s", p.subscriptionID, p.resourceGroup, in.ContainerAppName)
	resp, err := p.metrics.List(ctx, resourceID, &armmonitor.MetricsClientListOptions{
		Timespan:        &timespan,
		Interval:        &interval,
		Metricnames:     &metricName,
		Aggregation:     &aggregation,
		Metricnamespace: &namespace,
	})
	if err != nil {
		return nil, err
	}
	var samples []replicaSample
	for _, metric := range resp.Value {
		for _, series := range metric.Timeseries {
			for _, point := range series.Data {
				if point.TimeStamp == nil || point.Average == nil {
					continue
				}
				samples = append(samples, replicaSample{Timestamp: *point.TimeStamp, Average: *point.Average})
			}
		}
	}
	return samples, nil
}

func iso8601Duration(d time.Duration) string {
	if d%time.Hour == 0 {
		return fmt.Sprintf("PT%dH", int(d/time.Hour))
	}
	return fmt.Sprintf("PT%dM", int(d/time.Minute))
}

func setContainerEnv(container *armappcontainers.Container, name, value string) {
	for _, env := range container.Env {
		if env.Name != nil && *env.Name == name {
			env.Value = to.Ptr(value)
			return
		}
	}
	container.Env = append(container.Env, &armappcontainers.EnvironmentVar{
		Name:  to.Ptr(name),
		Value: to.Ptr(value),
	})
}

func (p *azureProvisioner) Endpoint(in instance) string {
	if p.publicBase == "" {
		return p.InternalEndpoint(in)
	}
	return strings.TrimRight(p.publicBase, "/") + "/" + instanceSuffix(in)
}

// InternalEndpoint is for control-plane-to-instance calls inside the VNet.
// Endpoint returns the customer-facing APIM URL, which must not be used by the
// exec proxy or it would loop out through the public gateway and back in.
func (p *azureProvisioner) InternalEndpoint(in instance) string {
	return "https://" + in.ContainerAppName + "." + p.environmentDNS
}

func instanceSuffix(in instance) string {
	return strings.TrimPrefix(in.ID, "db_")
}

func mapContainerAppState(app armappcontainers.ContainerApp) liveState {
	if app.Properties == nil {
		return liveState{State: "provisioning"}
	}
	props := app.Properties
	provisioning := ""
	if props.ProvisioningState != nil {
		provisioning = string(*props.ProvisioningState)
	}
	running := ""
	if props.RunningStatus != nil {
		running = string(*props.RunningStatus)
	}
	return mapAzureState(provisioning, running)
}

func mapAzureState(provisioning, running string) liveState {
	switch strings.ToLower(provisioning) {
	case "failed", "canceled":
		return liveState{State: "failed", Error: provisioning}
	case "deleting":
		return liveState{State: "deleting"}
	case "inprogress", "provisioning", "":
		return liveState{State: "provisioning"}
	case "succeeded":
		switch strings.ToLower(running) {
		case "running", "ready":
			return liveState{State: "running"}
		case "stopped", "suspended":
			return liveState{State: "stopped"}
		case "progressing", "":
			return liveState{State: "provisioning"}
		default:
			return liveState{State: "stopped"}
		}
	default:
		return liveState{State: "provisioning"}
	}
}

func generateInstanceID() (string, error) {
	var b [15]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:])
	return "db_" + strings.ToLower(encoded), nil
}

func generateAccessToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func derivePlatformToken(masterSecret, id string) string {
	mac := hmac.New(sha256.New, []byte(masterSecret))
	_, _ = mac.Write([]byte(id))
	return hex.EncodeToString(mac.Sum(nil))
}

func containerAppName(id string) string {
	return "db-" + strings.TrimPrefix(id, "db_")
}

func registryServer(image string) string {
	if idx := strings.IndexByte(image, '/'); idx > 0 {
		return image[:idx]
	}
	return image
}

func isAzureNotFound(err error) bool {
	var respErr *azcore.ResponseError
	return errors.As(err, &respErr) && respErr.StatusCode == 404
}
