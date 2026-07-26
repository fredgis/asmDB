package main

import (
	"testing"
	"time"
)

// The engine used to get five seconds to open its database and print a banner.
// On the hosted service the data is on Azure Files NFS, the .dat is a gigabyte
// and not sparse there, and an open following an abrupt kill must first finish
// an interrupted whole-table operation. Five seconds was never enough for that,
// and because Container Apps never revives a revision that failed to become
// healthy, a database needing recovery was permanently unstartable. These tests
// pin the budget and its override so that cannot silently regress.
func TestEngineStartTimeoutDefaultsGenerously(t *testing.T) {
	t.Setenv("ASMDB_START_TIMEOUT", "")
	got := engineStartTimeout()
	if got != defaultEngineStartTimeout {
		t.Fatalf("engineStartTimeout() = %s, want %s", got, defaultEngineStartTimeout)
	}
	// Recovery over network storage is minutes-scale; anything short enough to
	// expire during it would brick the instance rather than merely slow it.
	if got < time.Minute {
		t.Fatalf("engineStartTimeout() = %s, too short for recovery on network storage", got)
	}
}

func TestEngineStartTimeoutHonoursOverride(t *testing.T) {
	t.Setenv("ASMDB_START_TIMEOUT", "90s")
	if got := engineStartTimeout(); got != 90*time.Second {
		t.Fatalf("engineStartTimeout() = %s, want 90s", got)
	}
}

func TestEngineStartTimeoutRejectsNonsense(t *testing.T) {
	for _, v := range []string{"banana", "0s", "-1m"} {
		t.Setenv("ASMDB_START_TIMEOUT", v)
		if got := engineStartTimeout(); got != defaultEngineStartTimeout {
			t.Fatalf("ASMDB_START_TIMEOUT=%q gave %s, want the default %s", v, got, defaultEngineStartTimeout)
		}
	}
}
