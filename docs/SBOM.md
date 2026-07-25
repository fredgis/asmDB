# Software Bill of Materials

This repository tracks two different dependency stories:

1. **Engine:** the `asmdb` binary is assembled directly with NASM using
   `nasm -f bin`. It links no libraries, uses no CRT and has no engine runtime
   package dependencies. CI installs NASM from the runner package manager, so the
   NASM version is **not pinned**.
2. **MCP server:** `mcp/package-lock.json` pins the Node dependency graph used
   by the Model Context Protocol server.
3. **Example clients and test tooling:** the Python client and Python test tools
   import only the Python standard library. The C and C# examples use platform /
   framework APIs and do not declare package dependencies.

The machine-readable SBOM is `sbom.json` in the repository root. It uses a
CycloneDX-style JSON structure so automated tooling can verify the "zero
third-party engine dependencies" claim separately from the MCP server's Node
dependencies.

## Regenerating

The SBOM is generated from files already in the repository:

```powershell
python -c "import json; lock=json.load(open('mcp/package-lock.json')); print(len(lock['packages']))"
```

When `mcp/package-lock.json` changes, regenerate `sbom.json` from the lockfile
instead of editing dependency versions by hand. Do not invent versions or hashes:
if a tool version is not pinned by the repository or CI, record it as
`not pinned`.

## MCP dependency summary

Direct dependencies from `mcp/package.json`:

| Package | Requested range | Locked version |
|---|---:|---:|
| `@modelcontextprotocol/sdk` | `^1.12.0` | `1.29.0` |
| `zod` | `^3.23.8` | `3.25.76` |

All transitive package versions are listed in `sbom.json`.
