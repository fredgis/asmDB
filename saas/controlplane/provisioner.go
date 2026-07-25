package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/to"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appcontainers/armappcontainers/v3"
)

type liveState struct {
	State string
	Error string
}

type provisioner interface {
	Create(context.Context, instance, string) (string, error)
	GetState(context.Context, instance) (liveState, error)
	Delete(context.Context, instance) error
	Endpoint(instance) string
}

type tierSpec struct {
	CPU         float64
	Memory      string
	MinReplicas int32
	MaxReplicas int32
	Quota       int
}

var tierSpecs = map[string]tierSpec{
	"free":     {CPU: 0.25, Memory: "0.5Gi", MinReplicas: 0, MaxReplicas: 1, Quota: 3},
	"standard": {CPU: 0.5, Memory: "1Gi", MinReplicas: 0, MaxReplicas: 1, Quota: 20},
	"premium":  {CPU: 1.0, Memory: "2Gi", MinReplicas: 1, MaxReplicas: 1, Quota: 100},
}

type azureProvisioner struct {
	apps           *armappcontainers.ContainerAppsClient
	resourceGroup  string
	location       string
	environmentID  string
	environmentDNS string
	image          string
	registryServer string
	identityID     string
}

func newAzureProvisioner(ctx context.Context, cfg config, cred azcore.TokenCredential) (*azureProvisioner, error) {
	apps, err := armappcontainers.NewContainerAppsClient(cfg.SubscriptionID, cred, nil)
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

	identityID := fmt.Sprintf("/subscriptions/%s/resourceGroups/%s/providers/Microsoft.ManagedIdentity/userAssignedIdentities/asmdb-mi", cfg.SubscriptionID, cfg.ResourceGroup)
	return &azureProvisioner{
		apps:           apps,
		resourceGroup:  cfg.ResourceGroup,
		location:       cfg.Location,
		environmentID:  *envResp.ID,
		environmentDNS: *envResp.Properties.DefaultDomain,
		image:          cfg.Image,
		registryServer: registryServer(cfg.Image),
		identityID:     identityID,
	}, nil
}

func (p *azureProvisioner) Create(ctx context.Context, in instance, token string) (string, error) {
	spec, ok := tierSpecs[in.Tier]
	if !ok {
		return "", fmt.Errorf("unknown tier %q", in.Tier)
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
						Env: []*armappcontainers.EnvironmentVar{
							{Name: to.Ptr("ASMDB_TOKEN"), Value: to.Ptr(token)},
							{Name: to.Ptr("ASMDB_NAME"), Value: to.Ptr("main")},
							{Name: to.Ptr("ASMDB_DATA"), Value: to.Ptr("/data")},
							{Name: to.Ptr("PORT"), Value: to.Ptr("8080")},
						},
						Resources: &armappcontainers.ContainerResources{
							CPU:    to.Ptr(spec.CPU),
							Memory: to.Ptr(spec.Memory),
						},
					},
				},
				Scale: &armappcontainers.Scale{
					MinReplicas: to.Ptr(spec.MinReplicas),
					MaxReplicas: to.Ptr(spec.MaxReplicas),
				},
			},
		},
	}

	_, err := p.apps.BeginCreateOrUpdate(ctx, p.resourceGroup, in.ContainerAppName, app, nil)
	if err != nil {
		return "", err
	}
	return "https://" + in.ContainerAppName + "." + p.environmentDNS, nil
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

func (p *azureProvisioner) Endpoint(in instance) string {
	return "https://" + in.ContainerAppName + "." + p.environmentDNS
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
