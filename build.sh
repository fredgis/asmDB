#!/usr/bin/env bash
# build.sh - Build asmdb for Linux with NASM alone (no linker, no CRT).
#
#   ./build.sh          # assemble src/main.asm -> build/asmdb  (hand-built ELF64)
#   ./build.sh --run    # build then run
#
# The Windows PE64 is built with build.ps1; this script cross-assembles the
# ELF64 image by defining LINUX (main.asm then includes elf.inc + os_linux.inc).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nasm="${NASM:-nasm}"
command -v "$nasm" >/dev/null 2>&1 || {
    echo "nasm not found. Install with: sudo apt-get install -y nasm" >&2
    exit 1
}
src="$root/src/main.asm"
out="$root/build/asmdb"
mkdir -p "$root/build"
echo "[asmdb] using nasm: $(command -v "$nasm")"
echo "[asmdb] assembling $src (ELF64)"
( cd "$root/src" && "$nasm" -f bin -dLINUX main.asm -o "$out" )
chmod +x "$out"
sz=$(wc -c < "$out")
echo "[asmdb] built $out ($sz bytes)"
if [[ "${1:-}" == "--run" ]]; then
    echo "[asmdb] running $out"
    "$out"
fi
