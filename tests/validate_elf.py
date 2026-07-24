#!/usr/bin/env python3
"""validate_elf.py - statically validate the hand-built asmdb ELF64 image.

Usage: python3 tests/validate_elf.py [path]   (default: build/asmdb)

Checks the ELF identification, the single PT_LOAD program header and the
invariants asmdb relies on (fixed load base 0x400000, RWX segment mapped from
file offset 0, no BSS so p_filesz == p_memsz == file length). Exits non-zero on
the first failed invariant so CI fails loudly.
"""
import struct
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "build/asmdb"
data = open(path, "rb").read()
n = len(data)
ok = True


def chk(name, got, exp):
    global ok
    good = exp(got) if callable(exp) else got == exp
    ok = ok and good
    shown = got if not isinstance(got, int) else hex(got)
    print(f"  [{'OK ' if good else 'ERR'}] {name}: {shown}")


chk("magic", data[:4], b"\x7fELF")
chk("EI_CLASS=ELFCLASS64", data[4], 2)
chk("EI_DATA=LSB", data[5], 1)
chk("EI_VERSION", data[6], 1)

e_type, e_machine, e_version, e_entry, e_phoff, _e_shoff = struct.unpack_from("<HHIQQQ", data, 16)
chk("e_type=ET_EXEC", e_type, 2)
chk("e_machine=x86-64", e_machine, 0x3E)
chk("e_version", e_version, 1)
chk("e_entry in image", e_entry, lambda v: 0x400000 <= v < 0x400000 + n)
chk("e_phoff=64", e_phoff, 64)

e_ehsize, e_phentsize, e_phnum = struct.unpack_from("<HHH", data, 52)
chk("e_ehsize=64", e_ehsize, 64)
chk("e_phentsize=56", e_phentsize, 56)
chk("e_phnum=1", e_phnum, 1)

(p_type, p_flags, p_offset, p_vaddr, _p_paddr,
 p_filesz, p_memsz, p_align) = struct.unpack_from("<IIQQQQQQ", data, 64)
chk("p_type=PT_LOAD", p_type, 1)
chk("p_flags=RWX(7)", p_flags, 7)
chk("p_offset=0", p_offset, 0)
chk("p_vaddr=0x400000", p_vaddr, 0x400000)
chk("p_filesz==filelen", p_filesz, n)
chk("p_memsz==p_filesz", p_memsz, p_filesz)
chk("p_align=0x1000", p_align, 0x1000)

print(f"  entry file offset = {hex(e_entry - 0x400000)}, image size = {n} bytes")
print("RESULT:", "ALL OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
