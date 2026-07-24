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

if [[ $fail -gt 0 ]]; then echo; echo "$fail check(s) failed."; exit 1; fi
echo; echo "All checks passed."
