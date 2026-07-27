import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ASMDB_SYNC_TEMPLATE } from "../services/notebook-template.js";

// The sync logic lives in workload/notebooks/sync_template.py and is embedded
// here as a string, because the backend's deployed payload does not include
// that directory. Two copies of anything drift, and this particular logic has
// been reasoned about carefully: MERGE before the watermark so a crash replays
// rather than skips, notebookutils rather than DefaultAzureCredential which
// Fabric does not support, and an automatic reseed when the change log cannot
// serve the requested position.
//
// A silent divergence would mean the notebook we generate is not the notebook
// that was reviewed and tested. This test makes that divergence loud.
describe("embedded notebook template", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourcePath = resolve(here, "../../../notebooks/sync_template.py");

  it("is identical to workload/notebooks/sync_template.py", () => {
    const onDisk = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
    const embedded = ASMDB_SYNC_TEMPLATE.replace(/\r\n/g, "\n");
    expect(embedded).toBe(onDisk);
  });

  it("still carries the guarantees the notebook was reviewed for", () => {
    expect(ASMDB_SYNC_TEMPLATE).toContain("notebookutils.credentials.getSecret");
    expect(ASMDB_SYNC_TEMPLATE).not.toContain("DefaultAzureCredential");
    expect(ASMDB_SYNC_TEMPLATE).toContain("MERGE INTO");
    expect(ASMDB_SYNC_TEMPLATE).toContain("incremental_write_plan");
  });
});
