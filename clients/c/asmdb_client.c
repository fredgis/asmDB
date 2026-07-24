/* Minimal asmdb client for C (Windows).
 *
 * asmdb has no network protocol or shared library: it is a REPL that reads
 * commands from stdin and writes ASCII results to stdout. This client
 * "connects" by spawning asmdb.exe with _popen() and piping commands to it.
 * Color is disabled automatically when stdout is a pipe, so the output you
 * read back is plain ASCII.
 *
 * This example writes commands; to also capture output, open two pipes with
 * CreateProcess + CreatePipe (see clients/README.md for the pattern).
 *
 * Build (MSVC):   cl /nologo asmdb_client.c
 * Run:            asmdb_client.exe
 */

#include <stdio.h>

static int asmdb_exec(const char *database, const char *table,
                      const char *commands)
{
    char cmdline[256];
    if (table && *table)
        _snprintf_s(cmdline, sizeof(cmdline), _TRUNCATE,
                    "..\\..\\build\\asmdb.exe %s %s", database, table);
    else
        _snprintf_s(cmdline, sizeof(cmdline), _TRUNCATE,
                    "..\\..\\build\\asmdb.exe %s", database);

    FILE *pipe = _popen(cmdline, "w");
    if (!pipe) {
        perror("_popen");
        return 1;
    }

    fputs(commands, pipe);
    fputs("\nQUIT\n", pipe);
    return _pclose(pipe);
}

int main(void)
{
    const char *script =
        "BEGIN\n"
        "INSERT 1 500 alice first memory about alice\n"
        "INSERT 2 750 bob follow-up on bob\n"
        "COMMIT\n"
        "SELECT *";

    return asmdb_exec("DemoDB", "notes", script);
}
