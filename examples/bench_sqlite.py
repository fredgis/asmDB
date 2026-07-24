#!/usr/bin/env python3
"""Same-machine SQLite baseline for the asmdb benchmark.

SQLite is measured through its in-process C API (sqlite3 module) - i.e. with NO
text/SQL-over-a-pipe protocol tax - which is a deliberately *generous* baseline:
asmdb's stdio numbers include command parsing that SQLite is not charged for
here. Three workloads mirror the asmdb figures:

  1. memory / transaction   - :memory: db, one transaction  -> raw engine speed
  2. disk / transaction     - file db, synchronous=FULL, one commit (1 fsync)
  3. disk / autocommit      - file db, synchronous=FULL, 1 commit per row (fsync/row)

Prints a JSON object of rows/sec for each workload.
"""
import argparse, json, os, sqlite3, tempfile, time


def rows_gen(n):
    for i in range(1, n + 1):
        yield (i, "bench_row", i)


def bench_memory_txn(n, runs):
    best = float("inf")
    for _ in range(runs):
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, value INTEGER)")
        t0 = time.perf_counter()
        con.execute("BEGIN")
        con.executemany("INSERT INTO t VALUES(?,?,?)", rows_gen(n))
        con.execute("COMMIT")
        best = min(best, time.perf_counter() - t0)
        con.close()
    return n / best


def bench_disk_txn(n, runs):
    best = float("inf")
    for _ in range(runs):
        fd, path = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        os.remove(path)
        con = sqlite3.connect(path)
        con.execute("PRAGMA synchronous=FULL")
        con.execute("PRAGMA journal_mode=DELETE")
        con.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, value INTEGER)")
        t0 = time.perf_counter()
        con.execute("BEGIN")
        con.executemany("INSERT INTO t VALUES(?,?,?)", rows_gen(n))
        con.execute("COMMIT")
        best = min(best, time.perf_counter() - t0)
        con.close()
        os.remove(path)
    return n / best


def bench_disk_autocommit(n, runs):
    best = float("inf")
    for _ in range(runs):
        fd, path = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        os.remove(path)
        con = sqlite3.connect(path, isolation_level=None)  # autocommit
        con.execute("PRAGMA synchronous=FULL")
        con.execute("PRAGMA journal_mode=DELETE")
        con.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, value INTEGER)")
        cur = con.cursor()
        t0 = time.perf_counter()
        for row in rows_gen(n):
            cur.execute("INSERT INTO t VALUES(?,?,?)", row)  # 1 durable txn each
        best = min(best, time.perf_counter() - t0)
        con.close()
        os.remove(path)
    return n / best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=100000)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--auto-rows", type=int, default=10000,
                    help="rows for the (slow) per-row autocommit workload")
    args = ap.parse_args()

    out = {
        "sqlite_version": sqlite3.sqlite_version,
        "rows": args.rows,
        "auto_rows": args.auto_rows,
        "memory_txn_rps": round(bench_memory_txn(args.rows, args.runs)),
        "disk_txn_rps": round(bench_disk_txn(args.rows, args.runs)),
        "disk_autocommit_rps": round(bench_disk_autocommit(args.auto_rows, 1)),
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
