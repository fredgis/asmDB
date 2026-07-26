package main

import (
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/to"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/appcontainers/armappcontainers/v3"
)

// A real upgrade failed with:
//
//	Field 'template.revisionsuffix' is invalid with details:
//	'Invalid value: "v160182757": revision with suffix v160182757 already exists.'
//
// The control plane never sets a suffix, but it reads the app, changes the image
// and writes it back, so one left behind by an out-of-band update travelled with
// every subsequent write and made upgrades fail permanently — with an error
// naming a field this code does not touch, which made it hard to attribute.
func TestClearInheritedRevisionSuffix(t *testing.T) {
	app := armappcontainers.ContainerApp{
		Properties: &armappcontainers.ContainerAppProperties{
			Template: &armappcontainers.Template{
				RevisionSuffix: to.Ptr("v160182757"),
				Containers: []*armappcontainers.Container{
					{Name: to.Ptr("asmdb"), Image: to.Ptr("reg.azurecr.io/asmdb-instance:1.6.1")},
				},
			},
		},
	}

	got := clearInheritedRevisionSuffix(app)

	if got.Properties.Template.RevisionSuffix != nil {
		t.Fatalf("revision suffix = %q, want nil so Azure allocates a fresh one",
			*got.Properties.Template.RevisionSuffix)
	}
	// Clearing the suffix must not disturb anything else in the template.
	if len(got.Properties.Template.Containers) != 1 ||
		*got.Properties.Template.Containers[0].Image != "reg.azurecr.io/asmdb-instance:1.6.1" {
		t.Fatal("clearing the revision suffix altered the rest of the template")
	}
}

func TestClearInheritedRevisionSuffixToleratesSparseTemplates(t *testing.T) {
	// These paths are also reached on rollback, where a partially built app is
	// plausible. A nil dereference here would turn a recoverable failure into a
	// crashed control plane.
	for name, app := range map[string]armappcontainers.ContainerApp{
		"no properties": {},
		"no template":   {Properties: &armappcontainers.ContainerAppProperties{}},
	} {
		t.Run(name, func(t *testing.T) {
			_ = clearInheritedRevisionSuffix(app)
		})
	}
}
