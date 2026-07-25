# Security policy and threat model

This document describes the security posture asmdb has today. It is not a
claim of hardening.

## Supported versions

| Version | Supported for security reports |
|---|---|
| `main` | Yes, best effort |
| Released tags | Best effort for the latest release only |
| Older commits / forks | No |

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories for `fredgis/asmDB`. Do not open a public issue with exploit details.

There is no bug bounty. Triage, fixes and disclosure timing are best effort and
depend on maintainer availability.

## Trust boundary

asmdb is a local, single-binary database engine. It reads commands from stdin and
reads/writes files in the local filesystem. Anyone who can run the binary with a
database name, write commands to its stdin, or modify the adjacent files can
influence engine behaviour.

The sensitive files are:

- `<db>.dat` — primary data file;
- `<db>.wal` — write-ahead log used for recovery;
- `<db>.cdc` — change-data-capture log.

Anyone who can write any of those files is inside the trust boundary.

## Current security posture

- There is no authentication.
- There is no authorisation.
- There is no encryption at rest.
- There is no encryption in transit; the engine has no network protocol.
- There is no audit log.

Access control is entirely external: whoever can run the binary and read or
write the files has full access to the database.

## Executable hardening limitations

The engine is assembled directly with `nasm -f bin`; there is no linker, no C
runtime and no library loader for the engine itself.

The current executable images are not memory-hardened:

- Linux uses a hand-written ELF64 `ET_EXEC` image with one `PT_LOAD` segment
  mapped at `0x400000` with `PF_R | PF_W | PF_X`.
- Windows uses a hand-written PE64 image at `0x400000` with one section marked
  code, execute, read and write.

Consequences:

- There is no W^X separation: code and data share a readable, writable and
  executable image.
- There is no PIE/relocation model for the engine image, so there is no
  address-space randomisation of the engine itself.
- Any memory-corruption bug should be treated as directly exploitable.

This is a known limitation. The roadmap item is to split code and writable data
into separate non-RWX mappings and add a relocation/PIE strategy before treating
the engine as suitable for hostile inputs.

## File validation and corruption detection

asmdb validates several on-disk invariants:

- `.dat` header magic, storage format, record size, capacity and live-count
  limits are checked when opening a database.
- `.wal` frames use CRC32 checks around committed frames.
- `.cdc` has a header CRC32, per-frame CRC32, frame trailers and dense sequence
  checks.
- The `VERIFY` command scans the table and checks row status values, live row
  invariants, hash reachability and the header live count.

These checks detect accidental corruption, torn writes and incompatible files.
They are not an attacker model. CRC32 is not a MAC; anyone who can deliberately
rewrite the files can also recompute CRC32 values or craft internally
consistent malicious data.

## File permissions

On Linux, data files are created with mode `0600`. On Windows, files inherit the
directory ACL from the containing directory.

## Concurrency model

asmdb supports one writer plus any number of `--reader` sessions:

- Windows uses a byte-range `LockFileEx` writer lock.
- Linux uses `flock` with exclusive, non-blocking locking.

Linux `flock` is advisory. The model assumes cooperating processes use asmdb's
locking protocol; another process with filesystem access can ignore the lock and
modify the files.
