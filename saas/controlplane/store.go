package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/bloberror"
)

var errNotFound = errors.New("not found")

type instance struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	Tier             string     `json:"tier"`
	Image            string     `json:"image,omitempty"`
	Engine           string     `json:"engine,omitempty"`
	EngineSource     string     `json:"engine_source,omitempty"`
	StorageFormat    string     `json:"storage_format,omitempty"`
	Operation        *operation `json:"operation,omitempty"`
	TokenHash        string     `json:"token_hash"`
	CreatedAt        time.Time  `json:"created_at"`
	ContainerAppName string     `json:"container_app_name"`
}

type operation struct {
	Type         string    `json:"type"`
	State        string    `json:"state"`
	StartedAt    time.Time `json:"started_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	Error        string    `json:"error,omitempty"`
	PendingToken string    `json:"pendingToken,omitempty"`
}

type store interface {
	Save(context.Context, instance) error
	Get(context.Context, string) (instance, error)
	List(context.Context) ([]instance, error)
	Delete(context.Context, string) error
}

func newStore(ctx context.Context, cfg config, cred azcore.TokenCredential) (store, error) {
	if cfg.StorageAccount == "" {
		return newMemoryStore(), nil
	}
	return newBlobStore(ctx, cfg.StorageAccount, cred)
}

type memoryStore struct {
	mu        sync.RWMutex
	instances map[string]instance
}

func newMemoryStore() *memoryStore {
	return &memoryStore{instances: map[string]instance{}}
}

func (s *memoryStore) Save(_ context.Context, in instance) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.instances[in.ID] = in
	return nil
}

func (s *memoryStore) Get(_ context.Context, id string) (instance, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	in, ok := s.instances[id]
	if !ok {
		return instance{}, errNotFound
	}
	return in, nil
}

func (s *memoryStore) List(_ context.Context) ([]instance, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]instance, 0, len(s.instances))
	for _, in := range s.instances {
		out = append(out, in)
	}
	return out, nil
}

func (s *memoryStore) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.instances, id)
	return nil
}

type blobStore struct {
	client    *azblob.Client
	container string
}

func newBlobStore(ctx context.Context, account string, cred azcore.TokenCredential) (*blobStore, error) {
	client, err := azblob.NewClient(fmt.Sprintf("https://%s.blob.core.windows.net/", account), cred, nil)
	if err != nil {
		return nil, err
	}
	s := &blobStore{client: client, container: "instances"}

	// The container is created by the infrastructure template, so this is a
	// convenience for local runs against a bare account — not a requirement.
	// Startup must not die because the identity is allowed to write blobs but
	// not to create containers, or because a role assignment has not finished
	// propagating: the first real write will surface the problem with a far
	// better error than "the service would not start".
	if _, err := client.CreateContainer(ctx, s.container, nil); err != nil {
		if !bloberror.HasCode(err, bloberror.ContainerAlreadyExists) {
			log.Printf("blob store: container %q not created (%v); assuming it already exists", s.container, err)
		}
	}
	return s, nil
}

func (s *blobStore) Save(ctx context.Context, in instance) error {
	body, err := json.MarshalIndent(in, "", "  ")
	if err != nil {
		return err
	}
	_, err = s.client.UploadBuffer(ctx, s.container, blobName(in.ID), body, nil)
	return err
}

func (s *blobStore) Get(ctx context.Context, id string) (instance, error) {
	resp, err := s.client.DownloadStream(ctx, s.container, blobName(id), nil)
	if bloberror.HasCode(err, bloberror.BlobNotFound, bloberror.ContainerNotFound) {
		return instance{}, errNotFound
	}
	if err != nil {
		return instance{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return instance{}, err
	}
	var in instance
	if err := json.Unmarshal(data, &in); err != nil {
		return instance{}, err
	}
	return in, nil
}

func (s *blobStore) List(ctx context.Context) ([]instance, error) {
	pager := s.client.NewListBlobsFlatPager(s.container, nil)
	var out []instance
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if bloberror.HasCode(err, bloberror.ContainerNotFound) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		for _, item := range page.Segment.BlobItems {
			if item.Name == nil {
				continue
			}
			resp, err := s.client.DownloadStream(ctx, s.container, *item.Name, nil)
			if err != nil {
				return nil, err
			}
			data, err := io.ReadAll(resp.Body)
			closeErr := resp.Body.Close()
			if err != nil {
				return nil, err
			}
			if closeErr != nil {
				return nil, closeErr
			}
			var in instance
			if err := json.NewDecoder(bytes.NewReader(data)).Decode(&in); err != nil {
				return nil, err
			}
			out = append(out, in)
		}
	}
	return out, nil
}

func (s *blobStore) Delete(ctx context.Context, id string) error {
	_, err := s.client.DeleteBlob(ctx, s.container, blobName(id), nil)
	if bloberror.HasCode(err, bloberror.BlobNotFound, bloberror.ContainerNotFound) {
		return nil
	}
	return err
}

func blobName(id string) string {
	return id + ".json"
}
