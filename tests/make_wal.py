"""Build a committed WAL, simulating a crash after the commit marker was
flushed but before the checkpoint reached the .dat file.

Reopening the database must replay this WAL and expose the row.

Usage:
    python tests/make_wal.py <out.wal> [id] [value] [tag] [content] [count]
                             [--legacy | --badcrc]

    (default)   emit a current 'ASMWAL02' frame with a valid CRC32
    --legacy    emit an old 'ASMWAL01' frame with no checksum, to prove such a
                frame written by an older binary is still replayed on upgrade
    --badcrc    emit an 'ASMWAL02' frame whose payload was corrupted after the
                checksum was computed, to prove corruption is detected

Layout mirrors src/wal.inc:
    +0   8   magic  'ASMWAL01' (legacy) or 'ASMWAL02'
    +8   8   N      entry count
    +16  8   count  live-row count to store in the header
    +24  N * { 8 slot index ; REC_SIZE after-image }
    +M   8   marker 'COMMIT01'
    +M+8 8   crc32 of bytes [0, M)      -- 'ASMWAL02' only
The marker and the checksum are written and flushed together, so a frame can
never be committed without a checksum describing it.
"""
import struct
import sys
import zlib

# ---- must match src/asmdb.inc ----
GOLDEN = 0x9E3779B97F4A7C15
CAPACITY = 4194304          # 2^22 slots
CAP_SHIFT = 42              # 64 - log2(CAPACITY)
REC_SIZE = 256
REC_ID, REC_STATUS, REC_KIND, REC_CLEN = 0, 8, 9, 12
REC_CREATED, REC_UPDATED, REC_VALUE = 16, 24, 32
REC_TAG, REC_CONTENT = 40, 80
TAG_MAX, CONTENT_MAX = 40, 176
ST_OCCUPIED = 1


def slot_index(key: int) -> int:
    return ((key * GOLDEN) & 0xFFFFFFFFFFFFFFFF) >> CAP_SHIFT


def record(rid: int, value: int, tag: str, content: str, ts: int = 1) -> bytes:
    r = bytearray(REC_SIZE)
    struct.pack_into('<Q', r, REC_ID, rid)
    r[REC_STATUS] = ST_OCCUPIED
    r[REC_KIND] = 0
    cb = content.encode('ascii')[:CONTENT_MAX]
    struct.pack_into('<I', r, REC_CLEN, len(cb))
    struct.pack_into('<q', r, REC_CREATED, ts)
    struct.pack_into('<q', r, REC_UPDATED, ts)
    struct.pack_into('<q', r, REC_VALUE, value)
    tb = tag.encode('ascii')[:TAG_MAX]
    r[REC_TAG:REC_TAG + len(tb)] = tb
    r[REC_CONTENT:REC_CONTENT + len(cb)] = cb
    return bytes(r)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    legacy = '--legacy' in flags
    badcrc = '--badcrc' in flags

    out = args[0]
    rid = int(args[1]) if len(args) > 1 else 42
    value = int(args[2]) if len(args) > 2 else 4242
    tag = args[3] if len(args) > 3 else 'wal'
    content = args[4] if len(args) > 4 else 'recovered from the write-ahead log'
    count = int(args[5]) if len(args) > 5 else 1

    idx = slot_index(rid)
    buf = bytearray()
    buf += b'ASMWAL01' if legacy else b'ASMWAL02'
    buf += struct.pack('<Q', 1)         # N entries
    buf += struct.pack('<Q', count)     # live-row count for the header
    buf += struct.pack('<Q', idx)       # entry: slot index
    buf += record(rid, value, tag, content)

    marker_at = len(buf)
    buf += b'COMMIT01'
    if not legacy:
        crc = zlib.crc32(bytes(buf[:marker_at])) & 0xFFFFFFFF
        buf += struct.pack('<Q', crc)
        if badcrc:
            buf[marker_at - 1] ^= 0x01   # corrupt the payload after checksumming

    with open(out, 'wb') as f:
        f.write(buf)
    kind = 'legacy v01' if legacy else ('v02 BAD crc' if badcrc else 'v02')
    print(f'wrote {out}: {kind} id={rid} value={value} tag={tag} slot={idx} '
          f'count={count} bytes={len(buf)}')


if __name__ == '__main__':
    main()
