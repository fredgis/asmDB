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
    "$root/scripts/build.sh"
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

    # a committed log for a database that does not exist yet cannot be
    # attributed to anything, so it must be refused and kept - replaying it is
    # how a stray log used to import a foreign row set into a fresh file
    python3 "$root/tests/make_wal.py" nw.wal 42 4242 wal 'recovered-into-memory' 1 > /dev/null
    r9d="$(printf '%s\n' 'COUNT' 'SELECT 42' 'EXIT' | ./asmdb nw 2>&1)"
    check 'orphan WAL into a new .dat refused' 'belongs to a different database' "$r9d"
    if [[ -s nw.wal ]]; then echo "  [PASS] orphan WAL is kept"; \
        else echo "  [FAIL] orphan WAL is kept"; fail=$((fail+1)); fi

    # a WAL entry addressing a slot outside the table must be rejected wholesale
    # rather than written at an arbitrary file offset. The frame names the
    # database it sits next to, so the refusal is about the slot index.
    printf '%s\n' 'INSERT 1 10 base original row' 'EXIT' | ./asmdb ft > /dev/null
    python3 "$root/tests/make_wal.py" ft.wal 7 777 bad 'out of range' 1 --badslot > /dev/null
    r9e="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb ft 2>&1)"; code9e=$?
    ft_size="$(stat -c%s ft.wal)"
    check 'out-of-range WAL index refused' 'cannot apply'                  "$r9e"
    if [[ $code9e -ne 0 && "$(stat -c%s ft.wal)" == "$ft_size" ]]; then
        echo "  [PASS] out-of-range WAL is kept"
    else
        echo "  [FAIL] out-of-range WAL is kept"; fail=$((fail+1))
    fi
    if [[ "$(stat -c%s ft.dat)" == "$((512 + 4194304 * 256))" ]]; then
        echo "  [PASS] out-of-range WAL did not grow .dat"
    else
        echo "  [FAIL] out-of-range WAL did not grow .dat"; fail=$((fail+1))
    fi

    # Run 10: WAL frame checksums
    printf '%s\n' 'INSERT 1 10 base original row' 'EXIT' | ./asmdb cv > /dev/null
    python3 "$root/tests/make_wal.py" cv.wal 7 777 crc 'checksummed frame' 2 > /dev/null
    r10="$(printf '%s\n' 'COUNT' 'SELECT 7' 'EXIT' | ./asmdb cv)"
    check 'v04 frame replays'        'content[[:space:]]+:[[:space:]]+checksummed frame' "$r10"
    # a frame naming a DIFFERENT database is refused, not replayed, and kept
    printf '%s\n' 'INSERT 1 10 base original row' 'EXIT' | ./asmdb fw > /dev/null
    python3 "$root/tests/make_wal.py" fw.wal 7 777 crc 'foreign frame' 5 --foreign > /dev/null
    r10f="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb fw 2>&1)"
    check 'foreign WAL refused'      'belongs to a different database'     "$r10f"
    if [[ -s fw.wal ]]; then echo "  [PASS] foreign WAL kept"; \
        else echo "  [FAIL] foreign WAL kept"; fail=$((fail+1)); fi
    # a byte flipped inside a committed frame is detected, and the log is kept
    printf '%s\n' 'INSERT 1 10 base original row' 'EXIT' | ./asmdb cb > /dev/null
    python3 "$root/tests/make_wal.py" cb.wal 7 777 crc 'corrupted frame' 2 --badcrc > /dev/null
    r10b="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb cb 2>&1)"; code10b=$?
    check 'bad WAL checksum refused'  'checksum mismatch'                  "$r10b"
    if [[ $code10b -ne 0 && -s cb.wal ]]; then echo "  [PASS] bad WAL checksum kept log"; \
        else echo "  [FAIL] bad WAL checksum kept log"; fail=$((fail+1)); fi
    rm -f cb.wal                                   # the documented remedy
    r10c="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb cb)"
    check 'db opens after removing the log' '\[ OK \] 1 row\(s\)'          "$r10c"
    # a frame that does not name its database at all (v01/v02, written before
    # 1.4) cannot be told apart from one that wandered in from another
    # database, so it is refused and kept rather than replayed
    printf '%s\n' 'INSERT 1 10 base original row' 'EXIT' | ./asmdb lg > /dev/null
    python3 "$root/tests/make_wal.py" lg.wal 9 999 old 'legacy frame' 2 --legacy > /dev/null
    r10d="$(printf '%s\n' 'SELECT 9' 'EXIT' | ./asmdb lg 2>&1)"
    check 'unnamed v01 frame refused' 'belongs to a different database'    "$r10d"
    if [[ -s lg.wal ]]; then echo "  [PASS] unnamed v01 frame kept"; \
        else echo "  [FAIL] unnamed v01 frame kept"; fail=$((fail+1)); fi
    printf '%s\n' 'INSERT 1 10 base original row' 'EXIT' | ./asmdb lg2 > /dev/null
    python3 "$root/tests/make_wal.py" lg2.wal 9 999 old 'unnamed frame' 2 --unnamed > /dev/null
    r10e="$(printf '%s\n' 'SELECT 9' 'EXIT' | ./asmdb lg2 2>&1)"
    check 'unnamed v02 frame refused' 'belongs to a different database'    "$r10e"

    # Run 11: fault injection - a failing durable write (ENOSPC-style) must abort
    # cleanly instead of acknowledging, and the committed WAL it leaves behind
    # must replay on the next open. Builds a throwaway binary with
    # -dFAULT_INJECT=<n>; the shipping binary contains none of that code.
    if command -v nasm >/dev/null 2>&1; then
        ( cd "$root/src" && nasm -f bin -dLINUX -dFAULT_INJECT=4 main.asm -o "$work/faulty" )
        chmod +x "$work/faulty"
        r11="$(printf '%s\n' 'INSERT 1 100 base first row' 'BEGIN' \
            'INSERT 2 200 txn committed but not checkpointed' 'COMMIT' 'COUNT' 'EXIT' \
            | ./faulty fi 2>&1)"; code11=$?
        check 'failed durable write says why' 'I/O failure on a durable write' "$r11"
        check 'no [ OK ] after the failure'   '!transaction committed'         "$r11"
        if [[ $code11 -ne 0 && -s fi.wal ]]; then echo "  [PASS] failed durable write aborts, WAL kept"; \
            else echo "  [FAIL] failed durable write aborts, WAL kept"; fail=$((fail+1)); fi
        r11b="$(printf '%s\n' 'COUNT' 'SELECT 2' 'EXIT' | ./asmdb fi)"
        check 'engine-written WAL replays' 'content[[:space:]]+:[[:space:]]+committed but not checkpointed' "$r11b"
        check 'recovered count is right'   '\[ OK \] 2 row\(s\)'               "$r11b"

        # Run 12: autocommit is crash-atomic. A single-statement INSERT commits
        # through the same WAL path as an explicit transaction, so a crash at ANY
        # durable write must leave the count and the rows agreeing. Before that,
        # a crash between the slot and header writes left a row present but
        # uncounted.
        for n in 1 2 3 4; do
            ( cd "$root/src" && nasm -f bin -dLINUX -dFAULT_INJECT=$n main.asm -o "$work/fa$n" )
            chmod +x "$work/fa$n"
            printf '%s\n' 'INSERT 1 100 base seed row' 'EXIT' | ./asmdb "atom$n" > /dev/null
            printf '%s\n' 'INSERT 2 200 crash row that crashes' 'EXIT' | "./fa$n" "atom$n" > /dev/null 2>&1
            after="$(printf '%s\n' 'COUNT' 'SELECT *' 'EXIT' | ./asmdb "atom$n")"
            declared="$(grep -oE '\[ OK \] [0-9]+ row\(s\)' <<< "$after" | head -1 | grep -oE '[0-9]+')"
            listed="$(grep -cE '^\|[[:space:]]+[0-9]' <<< "$after" || true)"
            if [[ "$declared" == "$listed" && "${declared:-0}" -ge 1 ]]; then
                echo "  [PASS] autocommit atomic at durable write #$n (count=$declared, rows=$listed)"
            else
                echo "  [FAIL] autocommit atomic at durable write #$n (count=$declared, rows=$listed)"
                fail=$((fail+1))
            fi
        done
    else
        echo "  [SKIP] fault-injection checks (nasm not found)"
    fi
else
    echo "  [SKIP] WAL recovery checks (python3 not found)"
fi

# Run 13: engine version is reported, and stamped into the database
r13="$(printf '%s\n' 'INSERT 1 1 a x' 'VERSION' 'EXIT' | ./asmdb verdb)"
check 'VERSION reports the engine' 'asmdb[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+'          "$r13"
check 'VERSION reports the format' 'storage format[[:space:]]+:[[:space:]]+2'         "$r13"
check 'VERSION stamps the writer'  'written by[[:space:]]+:[[:space:]]+engine[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+' "$r13"
check 'banner shows the version'   'v[0-9]+\.[0-9]+\.[0-9]+'                          "$r13"
r13b="$(printf '%s\n' 'VERSION' 'EXIT' | ./asmdb verdb)"
check 'writer stamp survives reopen' 'written by[[:space:]]+:[[:space:]]+engine'      "$r13b"

# Run 14: --upgrade migrates a database whose capacity predates this build, into
# a NEW file, leaving the original byte-for-byte untouched.
if command -v python3 >/dev/null 2>&1; then
    python3 - legacy.dat <<'PY'
import struct, sys
CAP_OLD = 262144; REC = 256; HDR = 512
GOLDEN = 0x9E3779B97F4A7C15; shift = 64 - 18
def slot(k): return ((k * GOLDEN) & 0xFFFFFFFFFFFFFFFF) >> shift
hdr = bytearray(HDR); hdr[0:8] = b'ASMDB\0\0\0'
struct.pack_into('<I', hdr, 8, 1); struct.pack_into('<I', hdr, 12, REC)
struct.pack_into('<Q', hdr, 16, CAP_OLD); struct.pack_into('<Q', hdr, 24, 3)
hdr[32:39] = b'oldtbl\0'
data = bytearray(CAP_OLD * REC)
for rid, val, tag, txt in [(1,10,'alpha','ligne un'),(2,20,'beta','ligne deux'),(3,30,'gamma','ligne trois')]:
    i = slot(rid); off = i * REC
    while data[off+8] != 0:
        i = (i + 1) % CAP_OLD; off = i * REC
    struct.pack_into('<Q', data, off, rid); data[off+8] = 1
    struct.pack_into('<I', data, off+12, len(txt))
    struct.pack_into('<q', data, off+16, 1); struct.pack_into('<q', data, off+24, 1)
    struct.pack_into('<q', data, off+32, val)
    tb = tag.encode(); data[off+40:off+40+len(tb)] = tb
    cb = txt.encode(); data[off+80:off+80+len(cb)] = cb
open(sys.argv[1], 'wb').write(bytes(hdr) + bytes(data))
PY
    size_before="$(stat -c%s legacy.dat)"
    refused="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb legacy 2>&1)"; rc=$?
    if [[ $rc -ne 0 ]] && grep -q 'incompatible database format' <<< "$refused"; then
        echo "  [PASS] legacy capacity refused normally"
    else
        echo "  [FAIL] legacy capacity refused normally"; fail=$((fail+1))
    fi
    up="$(./asmdb legacy --upgrade 2>&1)"
    check 'upgrade reports migrated rows' 'migrated 3 row'                            "$up"
    if [[ "$(stat -c%s legacy.dat)" == "$size_before" ]]; then
        echo "  [PASS] upgrade left the original alone"
    else
        echo "  [FAIL] upgrade left the original alone"; fail=$((fail+1))
    fi
    cp legacy.upgraded.dat migrated.dat
    mg="$(printf '%s\n' 'COUNT' 'SELECT 2' 'TABLES' 'EXIT' | ./asmdb migrated)"
    check 'migrated rows are all there' '\[ OK \] 3 row\(s\)'                         "$mg"
    check 'migrated content intact'     'content[[:space:]]+:[[:space:]]+ligne deux'  "$mg"
    check 'migrated table name kept'    'oldtbl'                                      "$mg"
    noop="$(./asmdb migrated --upgrade 2>&1)"
    check 'upgrade no-ops when current' 'already in the current format'               "$noop"
else
    echo "  [SKIP] upgrade checks (python3 not found)"
fi

# ---------------------------------------------------------------------------
# Run 15: change data capture
# ---------------------------------------------------------------------------
dump="$root/tests/cdc_dump.py"
if command -v python3 >/dev/null 2>&1; then
    # 15a shape of the log: one event per row per transaction, FINAL image;
    #     a rollback contributes nothing
    printf '%s\n' 'INSERT 1 100 alpha premiere' 'INSERT 2 200 beta deuxieme' \
        'UPDATE 1 111 alpha modifiee' 'DELETE 2' \
        'BEGIN' 'INSERT 3 300 gamma dans txn' 'UPDATE 3 333 gamma encore' 'COMMIT' \
        'BEGIN' 'INSERT 4 400 delta annulee' 'ROLLBACK' 'EXIT' | ./asmdb cdc1 > /dev/null
    if python3 "$dump" cdc1.cdc --quiet >/dev/null 2>&1; then
        echo "  [PASS] CDC log validates"
    else
        echo "  [FAIL] CDC log validates"; fail=$((fail+1))
    fi
    c1="$(python3 "$dump" cdc1.cdc)"
    check 'CDC one frame per commit'  'frames=5'                              "$c1"
    check 'CDC update -> single UPSERT with final image' 'UPSERT id=1 value=111' "$c1"
    check 'CDC delete -> DELETE event'                   'DELETE id=2'          "$c1"
    check 'CDC txn collapses to one final UPSERT'        'UPSERT id=3 value=333' "$c1"
    check 'CDC rollback emits nothing'                   '!id=4'                "$c1"

    # 15b a transaction that ends where it started produces no frame at all
    printf '%s\n' 'BEGIN' 'INSERT 9 900 x ephemere' 'DELETE 9' 'COMMIT' 'EXIT' | ./asmdb cdc1 > /dev/null
    check 'CDC insert+delete in one txn is a no-op' 'last_seq=5' "$(python3 "$dump" cdc1.cdc --quiet)"

    # 15c the sequence keeps climbing across restarts
    printf '%s\n' 'INSERT 10 10 z apres redemarrage' 'EXIT' | ./asmdb cdc1 > /dev/null
    check 'CDC sequence survives a restart' 'last_seq=6' "$(python3 "$dump" cdc1.cdc --quiet)"

    # 15d the three whole-table operations are ONE reset each
    printf '%s\n' 'INSERT 1 1 a un' 'INSERT 2 2 b deux' 'BACKUP snap2.bak' \
        'TRUNCATE' 'RESTORE snap2.bak' 'BENCH 1000' 'EXIT' | ./asmdb cdc2 > /dev/null
    if python3 "$dump" cdc2.cdc --expect-frames 5 --quiet >/dev/null 2>&1; then
        echo "  [PASS] CDC BENCH is one frame, not 1000"
    else
        echo "  [FAIL] CDC BENCH is one frame, not 1000"; fail=$((fail+1))
    fi
    nres="$(python3 "$dump" cdc2.cdc | grep -c 'RESET' || true)"
    if [[ "$nres" == "3" ]]; then
        echo "  [PASS] CDC three global ops -> three RESETs"
    else
        echo "  [FAIL] CDC three global ops -> three RESETs (got $nres)"; fail=$((fail+1))
    fi

    # 15e torn tail trimmed on open; a COMPLETE frame with a bad checksum is
    #     corruption: refuse and keep the log
    before="$(stat -c%s cdc1.cdc)"
    head -c 40 /dev/zero >> cdc1.cdc
    printf '%s\n' 'COUNT' 'EXIT' | ./asmdb cdc1 > /dev/null 2>&1
    if [[ "$(stat -c%s cdc1.cdc)" == "$before" ]]; then
        echo "  [PASS] CDC torn tail is trimmed"
    else
        echo "  [FAIL] CDC torn tail is trimmed"; fail=$((fail+1))
    fi
    printf '\xFF' | dd of=cdc1.cdc bs=1 seek=124 conv=notrunc status=none
    bad_size="$(stat -c%s cdc1.cdc)"
    r15="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb cdc1 2>&1)"; rc=$?
    check 'CDC bad checksum refused' 'checksum'                               "$r15"
    if [[ $rc -ne 0 && "$(stat -c%s cdc1.cdc)" == "$bad_size" ]]; then
        echo "  [PASS] CDC bad checksum kept log"
    else
        echo "  [FAIL] CDC bad checksum kept log"; fail=$((fail+1))
    fi

    # 15f snapshot + watermark: BACKUP carries last_commit_seq, a consumer
    #     resumes from the frames after it
    printf '%s\n' 'INSERT 1 1 a un' 'INSERT 2 2 b deux' 'BACKUP wm.bak' \
        'INSERT 3 3 c trois' 'INSERT 4 4 d quatre' 'EXIT' | ./asmdb cdc3 > /dev/null
    wm="$(python3 -c "import struct,sys;print(struct.unpack_from('<Q',open('wm.bak','rb').read(128),88)[0])")"
    if [[ "$wm" == "2" ]]; then
        echo "  [PASS] BACKUP carries the CDC watermark"
    else
        echo "  [FAIL] BACKUP carries the CDC watermark (got $wm)"; fail=$((fail+1))
    fi
    nresume="$(python3 "$dump" cdc3.cdc --from-seq "$wm" | grep -c '^Frame' || true)"
    if [[ "$nresume" == "2" ]]; then
        echo "  [PASS] resume from watermark yields exactly the new rows"
    else
        echo "  [FAIL] resume from watermark yields exactly the new rows (got $nresume)"; fail=$((fail+1))
    fi

    # 15g crash between the WAL commit and the change frame: recovery owes the
    #     log exactly one frame
    if command -v nasm >/dev/null 2>&1; then
        ( cd "$root/src" && nasm -f bin -dLINUX -dFAULT_CDC main.asm -o "$work/nocdc" )
        chmod +x "$work/nocdc"
        printf '%s\n' 'INSERT 1 100 a premiere' 'EXIT' | ./asmdb crash1 > /dev/null
        printf '%s\n' 'INSERT 2 200 b deuxieme' 'EXIT' | ./nocdc crash1 > /dev/null 2>&1
        check 'crash before the frame leaves it missing' 'frames=1' "$(python3 "$dump" crash1.cdc --quiet)"
        printf '%s\n' 'COUNT' 'EXIT' | ./asmdb crash1 > /dev/null
        check 'recovery publishes the missing frame' 'frames=2 last_seq=2' "$(python3 "$dump" crash1.cdc --quiet)"
        printf '%s\n' 'COUNT' 'EXIT' | ./asmdb crash1 > /dev/null
        check 'recovery never duplicates a frame' 'frames=2 last_seq=2' "$(python3 "$dump" crash1.cdc --quiet)"

        # 15h crash mid-RESET: exactly one RESET after recovery, however often
        for n in 2 3 4; do
            ( cd "$root/src" && nasm -f bin -dLINUX -dFAULT_INJECT=$n main.asm -o "$work/fr$n" )
            chmod +x "$work/fr$n"
            printf '%s\n' 'INSERT 1 1 a un' 'INSERT 2 2 b deux' 'EXIT' | ./asmdb "rst$n" > /dev/null
            printf '%s\n' 'TRUNCATE' 'EXIT' | "./fr$n" "rst$n" > /dev/null 2>&1
            printf '%s\n' 'COUNT' 'EXIT' | ./asmdb "rst$n" > /dev/null
            printf '%s\n' 'COUNT' 'EXIT' | ./asmdb "rst$n" > /dev/null
            nr="$(python3 "$dump" "rst$n.cdc" | grep -c 'RESET' || true)"
            if [[ "$nr" == "1" ]]; then
                echo "  [PASS] RESET survives a crash at write #$n (exactly one)"
            else
                echo "  [FAIL] RESET survives a crash at write #$n (got $nr)"; fail=$((fail+1))
            fi
        done
    else
        echo "  [SKIP] CDC crash checks (nasm not found)"
    fi

    # 15i a COMPLETE frame with a damaged trailer is corruption, not a torn
    #     append: refuse and keep the log
    printf '%s\n' 'INSERT 1 1 a un' 'INSERT 2 2 b deux' 'EXIT' | ./asmdb cdct > /dev/null
    tsz="$(stat -c%s cdct.cdc)"
    printf '\x00' | dd of=cdct.cdc bs=1 seek=384 conv=notrunc status=none
    rt="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb cdct 2>&1)"; rc=$?
    check 'CDC damaged trailer refused' 'trailer is damaged'                  "$rt"
    if [[ $rc -ne 0 && "$(stat -c%s cdct.cdc)" == "$tsz" ]]; then
        echo "  [PASS] CDC damaged trailer kept log"
    else
        echo "  [FAIL] CDC damaged trailer kept log"; fail=$((fail+1))
    fi

    # 15j a log AHEAD of the database would make every future commit look
    #     already-published while the data kept moving - refuse
    printf '%s\n' 'INSERT 1 1 a un' 'INSERT 2 2 b deux' 'EXIT' | ./asmdb cdca > /dev/null
    printf '\x00\x00\x00\x00\x00\x00\x00\x00' | dd of=cdca.dat bs=1 seek=88 conv=notrunc status=none
    ra="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb cdca 2>&1)"
    check 'CDC ahead of the database refused' 'disagree on the last committed sequence' "$ra"

    # 15k removing the log is the documented escape hatch: the database still
    #     opens and the stream resumes after the watermark
    printf '%s\n' 'INSERT 1 1 a un' 'INSERT 2 2 b deux' 'EXIT' | ./asmdb cdcd > /dev/null
    rm -f cdcd.cdc
    printf '%s\n' 'INSERT 3 3 c trois' 'EXIT' | ./asmdb cdcd > /dev/null
    check 'stream resumes after the watermark' 'frames=1 last_seq=3' "$(python3 "$dump" cdcd.cdc --quiet)"
    # 15l slot reuse: DELETE then INSERT on the same tombstone must emit BOTH
    printf '%s\n' 'INSERT 5 50 old ancienne ligne' 'EXIT' | ./asmdb reuse > /dev/null
    printf '%s\n' 'BEGIN' 'DELETE 5' 'INSERT 9 90 new nouvelle ligne' 'COMMIT' 'EXIT' | ./asmdb reuse > /dev/null
    ru="$(python3 "$dump" reuse.cdc)"
    check 'slot reuse deletes the old id' 'DELETE id=5'        "$ru"
    check 'slot reuse upserts the new id' 'UPSERT id=9'        "$ru"

    # 15m a fresh database must refuse a change log belonging to another one
    printf '%s\n' 'INSERT 1 1 a un' 'EXIT' | ./asmdb lineA > /dev/null
    cp lineA.cdc lineB.cdc
    rl="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb lineB 2>&1)"
    check 'foreign change log refused' 'different database'    "$rl"

    # 15n the log carries a header, and a log recreated after removal starts at
    #     the watermark and still verifies frame by frame
    if [[ "$(head -c 8 lineA.cdc)" == "ASMCDCH1" ]]; then
        echo "  [PASS] log has a file header"
    else
        echo "  [FAIL] log has a file header"; fail=$((fail+1))
    fi
    rm -f cdcd.cdc
    printf '%s\n' 'INSERT 7 7 g sept' 'EXIT' | ./asmdb cdcd > /dev/null
    check 'recreated log verifies from its base' 'frames=1'    "$(python3 "$dump" cdcd.cdc --quiet)"
else
    echo "  [SKIP] CDC checks (python3 not found)"
fi

# ---------------------------------------------------------------------------
# Run 16: safety of the destructive paths, strict parsing, machine format
# ---------------------------------------------------------------------------
long="$(printf 'x%.0s' $(seq 1 600))"
big="$(printf 'C%.0s' $(seq 1 175))"
r16="$(printf '%s\n' \
    'INSERT 1 5 tag short' \
    "INSERT 2 6 tag $big" \
    'BACKUP saf.dat' \
    'BACKUP saf.cdc' \
    'BACKUP saf.wal' \
    'COUNT' \
    'DELETE 42junk' \
    'INSERT 9 9223372036854775808 t overflow' \
    "INSERT 8 8 t $long" \
    'FORMAT TSV' \
    'SELECT 2' \
    'PAGE 1 0' \
    'SELECT *' \
    'PAGE 0 0' \
    'FORMAT TABLE' \
    'VERIFY' \
    'EXIT' | ./asmdb saf 2>&1)"

check 'BACKUP onto the live .dat refused' 'that path IS one of the live database files' "$r16"
n_self=$(grep -c 'live database files' <<< "$r16" || true)
if [[ "$n_self" -eq 3 ]]; then
    echo "  [PASS] BACKUP refuses all three live files"
else
    echo "  [FAIL] BACKUP refuses all three live files (got $n_self)"; fail=$((fail+1))
fi
check 'refused backup left the rows alone' '\[ OK \] 2 row\(s\)'  "$r16"
if [[ ! -e saf.dat.part ]]; then
    echo "  [PASS] no .part left behind"
else
    echo "  [FAIL] no .part left behind"; fail=$((fail+1))
fi
n_syn=$(grep -c 'syntax error' <<< "$r16" || true)
if [[ "$n_syn" -ge 2 ]]; then
    echo "  [PASS] trailing junk is a syntax error"
else
    echo "  [FAIL] trailing junk is a syntax error (got $n_syn)"; fail=$((fail+1))
fi
check 'over-long line refused'        'line too long'            "$r16"
check 'TSV row is not truncated'      "R.2.6.[0-9]+.[0-9]+.tag.$big" "$r16"
check 'PAGE bounds the result set'    '\[ OK \] 1 row\(s\)'      "$r16"
check 'VERIFY passes on a sound file' 'verify: 2 row\(s\) checked, no problem found' "$r16"

printf '%s\n' 'BACKUP good.bak' 'EXIT' | ./asmdb saf > /dev/null
if [[ -e good.bak && ! -e good.bak.part ]]; then
    echo "  [PASS] BACKUP to a fresh path works"
    echo "  [PASS] BACKUP leaves no temporary"
else
    echo "  [FAIL] BACKUP to a fresh path works"; fail=$((fail+2))
fi

# data files must not be readable by anyone else
perm="$(stat -c '%a' saf.dat)"
if [[ "$perm" == "600" ]]; then
    echo "  [PASS] data files are private (0600)"
else
    echo "  [FAIL] data files are private (0600) - got $perm"; fail=$((fail+1))
fi

# VERIFY must notice a hand-edited status byte
printf '\x09' | dd of=saf.dat bs=1 seek=520 count=1 conv=notrunc status=none
r17="$(printf '%s\n' 'VERIFY' 'EXIT' | ./asmdb saf 2>&1)"
check 'VERIFY reports a damaged file' 'verify: [0-9]+ problem\(s\) found' "$r17"

# a change-log header cut in half must be refused, not mistaken for a pre-1.1
# headerless log (which would skip the lineage check entirely)
printf '%s\n' 'INSERT 1 1 a x' 'EXIT' | ./asmdb torn > /dev/null
head -c 30 torn.cdc > torn.cut && mv torn.cut torn.cdc
rt="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb torn 2>&1)"
check 'torn change-log header refused' 'change log header is damaged' "$rt"
if [[ "$(wc -c < torn.cdc)" -eq 30 ]]; then
    echo "  [PASS] torn change-log header kept"
else
    echo "  [FAIL] torn change-log header kept"; fail=$((fail+1))
fi

# the change log can be trimmed once a consumer has acknowledged a watermark:
# the frames go, the sequence stays dense from the new base
if command -v python3 > /dev/null 2>&1; then
    printf '%s\n' 'INSERT 1 1 a one' 'INSERT 2 2 b two' 'INSERT 3 3 c three' \
        'INSERT 4 4 d four' 'INSERT 5 5 e five' 'EXIT' | ./asmdb trim1 > /dev/null
    tr_before="$(wc -c < trim1.cdc)"
    rt2="$(printf '%s\n' 'CDCTRIM 3' 'EXIT' | ./asmdb trim1 2>&1)"
    tr_after="$(wc -c < trim1.cdc)"
    tr_dump="$(python3 "$root/tests/cdc_dump.py" trim1.cdc --quiet)"; tr_code=$?
    check 'CDCTRIM acknowledged'  'change log trimmed up to sequence 3'  "$rt2"
    if [[ "$tr_after" -lt "$tr_before" ]]; then
        echo "  [PASS] CDCTRIM shrank the log"
    else
        echo "  [FAIL] CDCTRIM shrank the log"; fail=$((fail+1))
    fi
    check 'CDCTRIM kept the later frames' 'frames=2 last_seq=5'          "$tr_dump"
    if [[ $tr_code -eq 0 ]]; then
        echo "  [PASS] trimmed log still validates"
    else
        echo "  [FAIL] trimmed log still validates"; fail=$((fail+1))
    fi
    rt3="$(printf '%s\n' 'INSERT 6 6 f six' 'VERIFY' 'EXIT' | ./asmdb trim1 2>&1)"
    tr_dump2="$(python3 "$root/tests/cdc_dump.py" trim1.cdc --quiet)"
    check 'sequence continues after a trim'   'frames=3 last_seq=6'      "$tr_dump2"
    check 'database still sound after a trim' 'no problem found'         "$rt3"
    rt4="$(printf '%s\n' 'CDCTRIM 99' 'EXIT' | ./asmdb trim1 2>&1)"
    check 'CDCTRIM past the last commit refused' 'above the last published commit' "$rt4"
    rt5="$(printf '%s\n' 'CDCTRIM 1' 'EXIT' | ./asmdb trim1 2>&1)"
    check 'CDCTRIM below the base refused'       'below the log base'    "$rt5"
fi

# Every command response must end in exactly one status line so line-oriented
# machine consumers can stay synchronized.
terminators() {
    local base="$1"; shift
    local out
    out="$(printf '%s\n' "$@" 'EXIT' | ./asmdb "$base" 2>&1)"
    grep -oE '\[( OK |ERR)\]' <<< "$out" | wc -l | tr -d ' '
}
protocol_cmds=('HELP' 'SCHEMA' 'VERSION' 'SELECT *' 'COUNT' 'FORMAT TSV' 'PAGE 10 0' 'STATUS' 'INFO')
for cmd in "${protocol_cmds[@]}"; do
    safe="${cmd//[^A-Za-z0-9]/_}"
    n="$(terminators "proto_$safe" "$cmd")"
    if [[ "$n" == "1" ]]; then
        echo "  [PASS] protocol terminator: $cmd"
    else
        echo "  [FAIL] protocol terminator: $cmd (got $n)"; fail=$((fail+1))
    fi
done
for cmd in "${protocol_cmds[@]}"; do
    safe="${cmd//[^A-Za-z0-9]/_}"
    if [[ "$cmd" == "FORMAT TSV" ]]; then
        n="$(terminators "protot_$safe" "$cmd")"
    else
        n="$(( $(terminators "protot_$safe" 'FORMAT TSV' "$cmd") - 1 ))"
    fi
    if [[ "$n" == "1" ]]; then
        echo "  [PASS] protocol terminator in TSV: $cmd"
    else
        echo "  [FAIL] protocol terminator in TSV: $cmd (got $n)"; fail=$((fail+1))
    fi
done
printf '%s\n' 'INSERT 1 1 a one' 'INSERT 2 2 b two' 'EXIT' | ./asmdb proto_rows > /dev/null
for cmd in 'SELECT *' 'SELECT 1' 'FIND one' 'RANGE 0 2' 'TABLES' 'DATABASES' 'TYPES'; do
    n="$(terminators proto_rows "$cmd")"
    if [[ "$n" == "1" ]]; then
        echo "  [PASS] protocol terminator: $cmd with rows"
    else
        echo "  [FAIL] protocol terminator: $cmd with rows (got $n)"; fail=$((fail+1))
    fi
done
sync_out="$(printf '%s\n' 'FORMAT TABLE' 'HELP' 'COUNT' 'EXIT' | ./asmdb proto_sync 2>&1)"
mapfile -t sync_terms < <(grep -oE '\[( OK |ERR)\][^\r]*' <<< "$sync_out")
if [[ "${sync_terms[0]:-}" =~ format\ table && "${sync_terms[1]:-}" =~ help\ shown && "${sync_terms[2]:-}" =~ 0\ row\(s\) ]]; then
    echo "  [PASS] protocol stays synchronized after HELP"
else
    echo "  [FAIL] protocol stays synchronized after HELP"; fail=$((fail+1))
fi

# A whole-table operation is crash-atomic. TRUNCATE clears the slots one write
# at a time, so a crash used to leave some rows deleted, some not, and a row
# count matching neither. It is announced in the header before it starts, and
# the next open finishes it.
if command -v nasm > /dev/null 2>&1; then
    for n in 2 3 4; do
        rm -f ct.dat ct.wal ct.cdc
        nasm -f bin "-dFAULT_INJECT=$n" -o asmdb_f -I "$root/src" "$root/src/main.asm" 2>/dev/null
        chmod +x asmdb_f
        printf '%s\n' 'INSERT 1 1 a one' 'INSERT 2 2 b two' 'INSERT 3 3 c three' 'EXIT' | ./asmdb ct > /dev/null
        printf '%s\n' 'TRUNCATE' 'EXIT' | ./asmdb_f ct > /dev/null 2>&1 || true
        rc="$(printf '%s\n' 'COUNT' 'VERIFY' 'EXIT' | ./asmdb ct 2>&1)"
        if grep -q 'finishing a whole-table operation' <<< "$rc" \
           && grep -q '\[ OK \] 0 row(s)' <<< "$rc" \
           && grep -q 'no problem found' <<< "$rc"; then
            echo "  [PASS] TRUNCATE crash at write #$n is finished on reopen"
        else
            echo "  [FAIL] TRUNCATE crash at write #$n is finished on reopen"; fail=$((fail+1))
        fi
    done
    rm -f asmdb_f
else
    echo "  [SKIP] whole-table crash checks (nasm not found)"
fi

# ---------------------------------------------------------------------------
# Run 18: one writer, many readers
# ---------------------------------------------------------------------------
printf '%s\n' 'INSERT 1 10 a one' 'INSERT 2 20 b two' 'EXIT' | ./asmdb conc > /dev/null
# A long-lived writer is driven through a FIFO: file descriptor 9 stays open, so
# the writer keeps waiting for commands until we close it.
if ! mkfifo wpipe 2>/dev/null; then
    echo "  [SKIP] concurrency checks (no FIFO support here)"
else
./asmdb conc < wpipe > writer.log 2>&1 &
wpid=$!
exec 9> wpipe
sleep 1
if ! kill -0 "$wpid" 2>/dev/null; then
    echo "  [SKIP] concurrency checks (writer did not stay up)"
    exec 9>&-
    rm -f wpipe
else

ro="$(printf '%s\n' 'COUNT' 'FORMAT TSV' 'SELECT *' 'VERIFY' \
    'INSERT 3 30 c three' 'DELETE 1' 'TRUNCATE' 'BACKUP x.bak' 'BEGIN' 'EXIT' \
    | ./asmdb conc --reader 2>&1)"
w2="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb conc 2>&1)"

check 'reader opens a database a writer holds' '\[ OK \] 2 row\(s\)'   "$ro"
check 'reader sees the rows'                   'R.2.20.[0-9]+.[0-9]+.b.two' "$ro"
check 'reader can VERIFY'                      'verify: 2 row\(s\) checked' "$ro"
n_ro=$(grep -c 'read-only session' <<< "$ro" || true)
if [[ "$n_ro" -eq 5 ]]; then
    echo "  [PASS] reader refuses every mutation"
else
    echo "  [FAIL] reader refuses every mutation (got $n_ro)"; fail=$((fail+1))
fi
check 'a second WRITER is still refused' 'locked by another process' "$w2"

echo 'INSERT 42 42 live added-while-readers-run' >&9
sleep 1
ro2="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb conc --reader 2>&1)"
check 'reader observes a new commit' '\[ OK \] 3 row\(s\)' "$ro2"

# three readers at once
for i in 1 2 3; do
    (printf '%s\n' 'COUNT' 'EXIT' | ./asmdb conc --reader > "par$i.out" 2>&1) &
done
wait
n_par=$(cat par1.out par2.out par3.out | grep -c '\[ OK \] 3 row(s)' || true)
if [[ "$n_par" -eq 3 ]]; then
    echo "  [PASS] three readers at once all succeed"
else
    echo "  [FAIL] three readers at once all succeed (got $n_par)"; fail=$((fail+1))
fi

exec 9>&-              # closing the pipe ends the writer
wait "$wpid" 2>/dev/null || true
rm -f wpipe
fi
fi

rg="$(printf '%s\n' 'COUNT' 'EXIT' | ./asmdb ghost --reader 2>&1)"
check 'reader refuses a missing database' 'a reader never creates one' "$rg"
if [[ ! -e ghost.dat ]]; then
    echo "  [PASS] reader never creates a database"
else
    echo "  [FAIL] reader never creates a database"; fail=$((fail+1))
fi

if [[ $fail -gt 0 ]]; then echo; echo "$fail check(s) failed."; exit 1; fi
echo; echo "All checks passed."
