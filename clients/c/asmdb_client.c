/* Minimal asmdb client for C.
 *
 * asmdb has no network protocol or shared library: it is a REPL that reads
 * commands from stdin and writes results to stdout. This client "connects" by
 * spawning asmdb directly with pipes; it never invokes a shell.
 *
 * Build (MSVC):   cl /nologo asmdb_client.c
 * Build (POSIX):  gcc -Wall -Wextra -o asmdb_client asmdb_client.c
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <errno.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

static const char *default_exe(void)
{
    const char *env = getenv("ASMDB_EXE");
    if (env && *env)
        return env;
#ifdef _WIN32
    return "..\\..\\build\\asmdb.exe";
#else
    return "../../build/asmdb";
#endif
}

#ifdef _WIN32
static int append_char(char **cursor, size_t *remaining, char ch)
{
    if (*remaining <= 1)
        return 0;
    *(*cursor)++ = ch;
    (*remaining)--;
    **cursor = '\0';
    return 1;
}

static size_t quoted_len(const char *arg)
{
    size_t len = 2;
    for (; *arg; arg++)
        len += (*arg == '\\' || *arg == '"') ? 2 : 1;
    return len;
}

static int append_quoted_arg(char **cursor, size_t *remaining, const char *arg)
{
    unsigned backslashes = 0;
    if (!append_char(cursor, remaining, '"'))
        return 0;
    for (; *arg; arg++) {
        if (*arg == '\\') {
            backslashes++;
            continue;
        }
        if (*arg == '"') {
            while (backslashes-- > 0)
                if (!append_char(cursor, remaining, '\\') ||
                    !append_char(cursor, remaining, '\\'))
                    return 0;
            if (!append_char(cursor, remaining, '\\') ||
                !append_char(cursor, remaining, '"'))
                return 0;
            continue;
        }
        while (backslashes-- > 0)
            if (!append_char(cursor, remaining, '\\'))
                return 0;
        if (!append_char(cursor, remaining, *arg))
            return 0;
    }
    while (backslashes-- > 0)
        if (!append_char(cursor, remaining, '\\') ||
            !append_char(cursor, remaining, '\\'))
            return 0;
    return append_char(cursor, remaining, '"');
}

static char *build_cmdline(const char *exe, const char *database,
                           const char *table)
{
    size_t needed = quoted_len(exe) + 1 + quoted_len(database) + 1;
    if (table && *table)
        needed += quoted_len(table) + 1;
    char *cmdline = (char *)calloc(needed, 1);
    if (!cmdline)
        return NULL;

    char *cursor = cmdline;
    size_t remaining = needed;
    if (!append_quoted_arg(&cursor, &remaining, exe) ||
        !append_char(&cursor, &remaining, ' ') ||
        !append_quoted_arg(&cursor, &remaining, database) ||
        ((table && *table) &&
         (!append_char(&cursor, &remaining, ' ') ||
          !append_quoted_arg(&cursor, &remaining, table)))) {
        free(cmdline);
        return NULL;
    }
    return cmdline;
}

static int write_all_handle(HANDLE handle, const char *text)
{
    size_t left = strlen(text);
    while (left > 0) {
        DWORD chunk = left > 0x7ffff000u ? 0x7ffff000u : (DWORD)left;
        DWORD written = 0;
        if (!WriteFile(handle, text, chunk, &written, NULL))
            return 0;
        text += written;
        left -= written;
    }
    return 1;
}

static int asmdb_exec(const char *database, const char *table,
                      const char *commands)
{
    const char *exe = default_exe();
    char *cmdline = build_cmdline(exe, database, table);
    if (!cmdline) {
        fputs("failed to build command line\n", stderr);
        return 1;
    }

    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;

    HANDLE child_stdin_rd = NULL, child_stdin_wr = NULL;
    HANDLE child_stdout_rd = NULL, child_stdout_wr = NULL;
    if (!CreatePipe(&child_stdin_rd, &child_stdin_wr, &sa, 0) ||
        !CreatePipe(&child_stdout_rd, &child_stdout_wr, &sa, 0) ||
        !SetHandleInformation(child_stdin_wr, HANDLE_FLAG_INHERIT, 0) ||
        !SetHandleInformation(child_stdout_rd, HANDLE_FLAG_INHERIT, 0)) {
        fprintf(stderr, "pipe setup failed: %lu\n", GetLastError());
        free(cmdline);
        return 1;
    }

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = child_stdin_rd;
    si.hStdOutput = child_stdout_wr;
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    if (!CreateProcessA(exe, cmdline, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        fprintf(stderr, "CreateProcess failed: %lu\n", GetLastError());
        CloseHandle(child_stdin_rd);
        CloseHandle(child_stdin_wr);
        CloseHandle(child_stdout_rd);
        CloseHandle(child_stdout_wr);
        free(cmdline);
        return 1;
    }

    CloseHandle(child_stdin_rd);
    CloseHandle(child_stdout_wr);
    free(cmdline);

    int ok = write_all_handle(child_stdin_wr, commands) &&
             write_all_handle(child_stdin_wr, "\nQUIT\n");
    CloseHandle(child_stdin_wr);

    char buffer[4096];
    DWORD got = 0;
    while (ReadFile(child_stdout_rd, buffer, sizeof(buffer), &got, NULL) && got)
        fwrite(buffer, 1, got, stdout);
    CloseHandle(child_stdout_rd);

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exit_code = 1;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return ok ? (int)exit_code : 1;
}
#else
static int write_all_fd(int fd, const char *text)
{
    size_t left = strlen(text);
    while (left > 0) {
        ssize_t written = write(fd, text, left);
        if (written < 0) {
            if (errno == EINTR)
                continue;
            return 0;
        }
        text += written;
        left -= (size_t)written;
    }
    return 1;
}

static int asmdb_exec(const char *database, const char *table,
                      const char *commands)
{
    int in_pipe[2];
    int out_pipe[2];
    if (pipe(in_pipe) < 0 || pipe(out_pipe) < 0) {
        perror("pipe");
        return 1;
    }

    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 1;
    }
    if (pid == 0) {
        const char *exe = default_exe();
        char *const argv_with_table[] = {
            (char *)exe, (char *)database, (char *)table, NULL
        };
        char *const argv_without_table[] = {
            (char *)exe, (char *)database, NULL
        };

        dup2(in_pipe[0], STDIN_FILENO);
        dup2(out_pipe[1], STDOUT_FILENO);
        close(in_pipe[0]);
        close(in_pipe[1]);
        close(out_pipe[0]);
        close(out_pipe[1]);
        execv(exe, (table && *table) ? argv_with_table : argv_without_table);
        perror("execv");
        _exit(127);
    }

    close(in_pipe[0]);
    close(out_pipe[1]);

    int ok = write_all_fd(in_pipe[1], commands) &&
             write_all_fd(in_pipe[1], "\nQUIT\n");
    close(in_pipe[1]);

    char buffer[4096];
    ssize_t got;
    while ((got = read(out_pipe[0], buffer, sizeof(buffer))) > 0)
        fwrite(buffer, 1, (size_t)got, stdout);
    close(out_pipe[0]);

    int status = 1;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR)
        ;
    if (!ok)
        return 1;
    if (WIFEXITED(status))
        return WEXITSTATUS(status);
    return 1;
}
#endif

int main(void)
{
    const char *script =
        "BEGIN\n"
        "INSERT 1 500 alice first memory about alice\n"
        "INSERT 2 750 bob follow-up on bob\n"
        "COMMIT\n"
        "FORMAT TSV\n"
        "SELECT *";

    return asmdb_exec("DemoDB", "notes", script);
}
