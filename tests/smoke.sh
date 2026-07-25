#!/usr/bin/env bash
# smoke.sh - Linux smoke test for asmdb: CRUD, transactions and persistence.
# Mirrors tests/smoke.ps1. Drives the ELF over stdin in a temp dir and asserts
# on the plain-text output (colour auto-disables when stdout is not a tty).
#
#   ./tests/smoke.sh              # build then test
#   ./tests/smoke.sh --no-build   # test the existing build/asmdb
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exe="$root/build/asmdb"

if [[ "${1:-}" != "--no-build" || ! -x "$exe" ]]; then
    "$root/build.sh"
fi
[[ -x "$exe" ]] || { echo "asmdb not found at $exe" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$exe" "$work/asmdb"
cd "$work"

fail=0
check() { # name, regex, haystack   (negate with leading '!')
    local name="$1" pat="$2" hay="$3" neg=0
    if [[ "$pat" == "!"* ]]; then neg=1; pat="${pat#!}"; fi
    if grep -Eq "$pat" <<< "$hay"; then hit=1; else hit=0; fi
    if { [[ $neg -eq 0 && $hit -eq 1 ]] || [[ $neg -eq 1 && $hit -eq 0 ]]; }; then
        echo "  [PASS] $name"
    else
        echo "  [FAIL] $name"; fail=$((fail+1))
    fi
}

# Run 1: autocommit + rollback + commit (schema: id value tag content)
r1="$(printf '%s\n' \
    'INSERT 1 100 alice first note about alice' \
    'BEGIN' 'INSERT 2 200 bob staged row' 'INSERT 3 300 carol staged row' 'COUNT' 'ROLLBACK' 'COUNT' \
    'BEGIN' 'INSERT 2 222 bob committed content' 'UPDATE 1 999 alice revised note' 'COMMIT' \
    'SELECT *' 'SELECT 1' 'FIND revised' 'COUNT' 'EXIT' | ./asmdb t)"

check 'insert acknowledged'          '1 row inserted'                      "$r1"
check 'transaction started'          'transaction started'                 "$r1"
check 'rollback reverts count 3->1'  'rolled back'                         "$r1"
check 'commit acknowledged'          'transaction committed'               "$r1"
check 'updated value persisted'      'alice[[:space:]]+\|[[:space:]]+999'  "$r1"
check 'committed insert present'     'bob[[:space:]]+\|[[:space:]]+222'    "$r1"
check 'detail view content'          'content[[:space:]]+:[[:space:]]+revised note' "$r1"
check 'detail view timestamps'       'created[[:space:]]+:[[:space:]]+[0-9]+ ms'    "$r1"
check 'FIND matches content'         'alice[[:space:]]+\|[[:space:]]+999[[:space:]]+\|[[:space:]]+revised note' "$r1"

# Run 2: reopen -> committed survives, rolled-back does not
r2="$(printf '%s\n' 'SELECT *' 'COUNT' 'EXIT' | ./asmdb t)"
check 'persistence: alice/999'       'alice[[:space:]]+\|[[:space:]]+999'  "$r2"
check 'persistence: bob/222'         'bob[[:space:]]+\|[[:space:]]+222'    "$r2"
check 'persistence: 2 rows'          '\[ OK \] 2 row\(s\)'                 "$r2"
check 'rolled-back carol absent'     '!carol'                              "$r2"

# Run 3: CHECK constraint, RANGE access path, BACKUP/RESTORE (fresh db 'r7')
r3="$(printf '%s\n' \
    'INSERT 10 100 xx aaa' 'INSERT 20 250 yy bbb' 'INSERT 30 500 zz ccc' \
    'INSERT 0 1 bad reserved-key' \
    'RANGE 100 300' \
    'BACKUP snap.bak' \
    'DELETE 10' 'DELETE 20' 'DELETE 30' 'COUNT' \
    'RESTORE snap.bak' 'COUNT' 'EXIT' | ./asmdb r7)"
check 'CHECK rejects id 0'           'id must be >= 1'                     "$r3"
check 'RANGE includes in-range row'  'yy[[:space:]]+\|[[:space:]]+250'    "$r3"
check 'RANGE excludes out-of-range'  '!zz[[:space:]]+\|[[:space:]]+500'   "$r3"
check 'BACKUP acknowledged'          'backup written'                     "$r3"
check 'emptied before restore'       '\[ OK \] 0 row\(s\)'                "$r3"
check 'RESTORE acknowledged'         'database restored'                  "$r3"
check 'RESTORE recovers 3 rows'      '\[ OK \] 3 row\(s\)'                "$r3"

# ---------------------------------------------------------------------------
# Hardening checks (mirror of tests/smoke.ps1)
# ---------------------------------------------------------------------------

# Run 4: undo-log dedup. A slot is captured at most once per transaction, so far
# more than UNDO_MAX (4096) writes to the same rows must still fit, and ROLLBACK
# must restore the ORIGINAL image rather than an intermediate one.
{
    printf '%s\n' 'INSERT 1 100 alpha original-one' \
                  'INSERT 2 200 beta original-two' \
                  'INSERT 3 300 gamma original-three' 'BEGIN'
    for i in $(seq 1 1500); do
        printf 'UPDATE 1 %s alpha churn-%s\nUPDATE 2 %s beta churn-%s\nUPDATE 3 %s gamma churn-%s\n' \
               "$i" "$i" "$i" "$i" "$i" "$i"
    done                                  # 4500 writes over only 3 distinct slots
    printf '%s\n' 'SELECT 1' 'ROLLBACK' 'SELECT *' 'COUNT' 'EXIT'
} > churn.txt
r4="$(./asmdb t4 < churn.txt)"
after4="${r4##*rolled back}"
check 'undo dedup: 4500 writes, no overflow' '!transaction too large'      "$r4"
check 'undo dedup: in-txn value visible'     'value[[:space:]]+:[[:space:]]+1500' "$r4"
check 'undo dedup: rollback -> original 1'   'alpha[[:space:]]+\|[[:space:]]+100[[:space:]]+\|[[:space:]]+original-one'   "$after4"
check 'undo dedup: rollback -> original 2'   'beta[[:space:]]+\|[[:space:]]+200[[:space:]]+\|[[:space:]]+original-two'    "$after4"
check 'undo dedup: rollback -> original 3'   'gamma[[:space:]]+\|[[:space:]]+300[[:space:]]+\|[[:space:]]+original-three' "$after4"
check 'undo dedup: no churn value survives'  '!churn-'                     "$after4"

# Run 5: BENCH rewrites the whole table, so it must be refused inside a txn
r5="$(printf '%s\n' 'INSERT 7 70 keepme survive the bench' 'BEGIN' 'BENCH 1000' \
    'ROLLBACK' 'COUNT' 'SELECT 7' 'EXIT' | ./asmdb t5)"
check 'BENCH refused inside a txn'   'finish the transaction first'        "$r5"
check 'BENCH did not wipe the row'   'content[[:space:]]+:[[:space:]]+survive the bench' "$r5"
check 'BENCH did not change count'   '\[ OK \] 1 row\(s\)'                 "$r5"

# Run 6: a key that does not fit in 64 bits must be rejected, not wrapped
r6="$(printf '%s\n' 'INSERT 18446744073709551617 5 x wrapped-key' 'COUNT' 'EXIT' | ./asmdb t6)"
check 'u64 overflow rejected'        'syntax error'                        "$r6"
check 'u64 overflow inserted nothing' '\[ OK \] 0 row\(s\)'                "$r6"

# Run 7: an invalid .dat must be refused, never silently reinitialized
try_open() { printf '%s\n' 'COUNT' 'EXIT' | ./asmdb "$1" 2>&1; }

head -c 100 /dev/zero > part.dat                     # partially written header
o="$(try_open part)"; code=$?
check 'partial header refused'       'incomplete or corrupt'               "$o"
[[ $code -ne 0 ]] && echo "  [PASS] partial header exit code" || { echo "  [FAIL] partial header exit code"; fail=$((fail+1)); }
[[ "$(stat -c%s part.dat)" == "100" ]] && echo "  [PASS] partial header not rewritten" || { echo "  [FAIL] partial header not rewritten"; fail=$((fail+1)); }

head -c 4096 /dev/zero | tr '\0' 'X' > bad.dat        # non-empty, foreign content
o="$(try_open bad)"; code=$?
check 'bad magic refused'            'incomplete or corrupt'               "$o"
[[ "$(stat -c%s bad.dat)" == "4096" ]] && echo "  [PASS] bad magic not rewritten" || { echo "  [FAIL] bad magic not rewritten"; fail=$((fail+1)); }

printf '%s\n' 'INSERT 1 1 a a' 'EXIT' | ./asmdb tr > /dev/null
truncate -s 5000 tr.dat                              # slot region cut short
o="$(try_open tr)"
check 'truncated data region refused' 'incomplete or corrupt'              "$o"

printf '%s\n' 'INSERT 1 1 a a' 'EXIT' | ./asmdb vr > /dev/null
printf '\x63\x00\x00\x00' | dd of=vr.dat bs=1 seek=8 conv=notrunc status=none  # version = 99
o="$(try_open vr)"
check 'incompatible version refused' 'incompatible database format'        "$o"

# Run 8: a truncated backup must be refused and leave the live db intact
truncate -s 40000 snap.bak
r8="$(printf '%s\n' 'COUNT' 'RESTORE snap.bak' 'COUNT' 'SELECT 20' 'EXIT' | ./asmdb r7)"
check 'truncated backup refused'     'truncated or incompatible'           "$r8"
check 'refused restore kept data'    'value[[:space:]]+:[[:space:]]+250'   "$r8"
r8b="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb r7)"
check 'db usable after refused restore' '\[ OK \] 3 row\(s\)'              "$r8b"

# Run 9: crash recovery. A committed-but-uncheckpointed WAL must be replayed on
# the next open, exactly once, and a corrupt WAL must be discarded.
if command -v python3 >/dev/null 2>&1; then
    printf '%s\n' 'INSERT 1 10 base original row' 'EXIT' | ./asmdb wr > /dev/null
    python3 "$root/tests/make_wal.py" wr.wal 42 4242 wal 'recovered from the write-ahead log' 2 > /dev/null
    r9="$(printf '%s\n' 'COUNT' 'SELECT 42' 'EXIT' | ./asmdb wr)"
    check 'WAL replayed on open'     'content[[:space:]]+:[[:space:]]+recovered from the write-ahead log' "$r9"
    check 'WAL recovery sets count'  '\[ OK \] 2 row\(s\)'                 "$r9"
    if [[ "$(stat -c%s wr.wal)" == "0" ]]; then echo "  [PASS] WAL cleared after replay"; \
        else echo "  [FAIL] WAL cleared after replay"; fail=$((fail+1)); fi
    r9b="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb wr)"
    check 'WAL replay is idempotent' '\[ OK \] 2 row\(s\)'                 "$r9b"
    head -c 500 /dev/zero | tr '\0' 'Z' > wr.wal      # corrupt WAL
    r9c="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb wr)"
    check 'corrupt WAL discarded'    '\[ OK \] 2 row\(s\)'                 "$r9c"

    # recovery onto a database whose .dat does not exist yet must load the
    # replayed rows into memory, not just onto disk
    python3 "$root/tests/make_wal.py" nw.wal 42 4242 wal 'recovered-into-memory' 1 > /dev/null
    r9d="$(printf '%s\n' 'COUNT' 'SELECT 42' 'EXIT' | ./asmdb nw)"
    check 'WAL replay into a new .dat: count'  '\[ OK \] 1 row\(s\)'       "$r9d"
    check 'WAL replay into a new .dat: in RAM' 'content[[:space:]]+:[[:space:]]+recovered-into-memory' "$r9d"

    # a WAL entry addressing a slot outside the table must be rejected wholesale
    # rather than written at an arbitrary file offset
    python3 - <<'PY'
import struct
buf = bytearray(b'ASMWAL01')
buf += struct.pack('<Q', 1)          # N = 1
buf += struct.pack('<Q', 1)          # count = 1
buf += struct.pack('<Q', 1 << 55)    # slot index, way out of range
buf += bytes(256)                    # after-image
buf += b'COMMIT01'
open('ft.wal', 'wb').write(buf)
PY
    r9e="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb ft)"; code9e=$?
    check 'out-of-range WAL index discarded' '\[ OK \] 0 row\(s\)'         "$r9e"
    if [[ $code9e -eq 0 && "$(stat -c%s ft.dat)" == "$((512 + 4194304 * 256))" ]]; then
        echo "  [PASS] out-of-range WAL did not grow .dat"
    else
        echo "  [FAIL] out-of-range WAL did not grow .dat"; fail=$((fail+1))
    fi
else
    echo "  [SKIP] WAL recovery checks (python3 not found)"
fi

if [[ $fail -gt 0 ]]; then echo; echo "$fail check(s) failed."; exit 1; fi
echo; echo "All checks passed."
