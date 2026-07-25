"""Build a committed WAL, simulating a crash after the commit marker was
flushed but before the checkpoint reached the .dat file.

Reopening the database must replay this WAL and expose the row.

Usage:  python tests/make_wal.py <out.wal> [id] [value] [tag] [content] [count]

Layout mirrors src/wal.inc:
    +0   8   magic  'ASMWAL01'
    +8   8   N      entry count
    +16  8   count  live-row count to store in the header
    +24  N * { 8 slot index ; REC_SIZE after-image }
    +..  8   marker 'COMMIT01'   (written and flushed last)
"""
import struct
import sys

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
    out = sys.argv[1]
    rid = int(sys.argv[2]) if len(sys.argv) > 2 else 42
    value = int(sys.argv[3]) if len(sys.argv) > 3 else 4242
    tag = sys.argv[4] if len(sys.argv) > 4 else 'wal'
    content = sys.argv[5] if len(sys.argv) > 5 else 'recovered from the write-ahead log'
    count = int(sys.argv[6]) if len(sys.argv) > 6 else 1

    idx = slot_index(rid)
    buf = bytearray()
    buf += b'ASMWAL01'                  # magic
    buf += struct.pack('<Q', 1)         # N entries
    buf += struct.pack('<Q', count)     # live-row count for the header
    buf += struct.pack('<Q', idx)       # entry: slot index
    buf += record(rid, value, tag, content)
    buf += b'COMMIT01'                  # commit marker (flushed last)

    with open(out, 'wb') as f:
        f.write(buf)
    print(f'wrote {out}: id={rid} value={value} tag={tag} slot={idx} '
          f'count={count} bytes={len(buf)}')


if __name__ == '__main__':
    main()
