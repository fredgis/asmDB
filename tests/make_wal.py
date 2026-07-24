import struct, sys

# Build a committed WAL that inserts one row, simulating a crash after the
# commit marker was flushed but before the checkpoint reached asmdb.dat.
GOLDEN = 0x9E3779B97F4A7C15
CAP_SHIFT = 52
HDR_SIZE = 512

def slot_index(key):
    return ((key * GOLDEN) & 0xFFFFFFFFFFFFFFFF) >> CAP_SHIFT

def record(rid, value, name):
    r = bytearray(64)
    struct.pack_into('<Q', r, 0, rid)       # REC_ID
    r[8] = 1                                 # REC_STATUS = OCCUPIED
    struct.pack_into('<q', r, 16, value)     # REC_VALUE
    nb = name.encode('ascii')[:40]
    r[24:24+len(nb)] = nb                    # REC_NAME
    return bytes(r)

rid, value, name = 42, 4242, 'recovered'
idx = slot_index(rid)

buf = bytearray()
buf += b'ASMWAL01'                 # magic
buf += struct.pack('<Q', 1)        # N entries
buf += struct.pack('<Q', 1)        # new live count
buf += struct.pack('<Q', idx)      # entry: slot index
buf += record(rid, value, name)    # entry: 64-byte after-image
buf += b'COMMIT01'                 # commit marker (flushed last)

with open(sys.argv[1], 'wb') as f:
    f.write(buf)
print(f'wrote {sys.argv[1]}: id={rid} value={value} name={name} slot={idx} bytes={len(buf)}')
