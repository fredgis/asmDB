#!/bin/sh
# /data is an Azure Files NFS share mounted by the platform, not a directory
# from the image: whatever the image said about its ownership is replaced at
# mount time, and the mount arrives owned by root. The engine runs
# unprivileged, so take ownership once here — the only moment we still have
# the rights to do it — and then drop straight back down.
#
# Failure is not fatal: if the platform already hands the directory over with
# the right owner, chown is redundant rather than required, and refusing to
# boot over it would be worse than trying.
set -e

: "${ASMDB_DATA:=/data}"

if [ -d "$ASMDB_DATA" ]; then
    chown asmdb:asmdb "$ASMDB_DATA" 2>/dev/null || \
        echo "sidecar: could not chown $ASMDB_DATA, continuing as-is" >&2
fi

exec su-exec asmdb:asmdb /app/sidecar "$@"
