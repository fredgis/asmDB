// Minimal asmdb client for C# (.NET).
//
// asmdb has no network protocol or client library: it is a REPL that reads
// commands from stdin and writes ASCII results to stdout. This client
// "connects" by launching asmdb.exe as a child process, writing commands to
// its stdin, and reading the plain-ASCII output back (color is auto-disabled
// when stdout is redirected).
//
// Build & run (from this folder):
//     dotnet run
// or drop AsmdbClient.cs into any project.

using System;
using System.Diagnostics;

public sealed class AsmdbClient
{
    private readonly string _exe;
    private readonly string _args;

    public AsmdbClient(string exe, string database, string? table = null)
    {
        _exe = exe;
        _args = table is null ? database : $"{database} {table}";
    }

    // Send commands (one per array element), then QUIT. Returns raw stdout.
    public string Run(params string[] commands)
    {
        var psi = new ProcessStartInfo(_exe, _args)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("failed to start asmdb.exe");

        foreach (var cmd in commands)
            proc.StandardInput.WriteLine(cmd);
        proc.StandardInput.WriteLine("QUIT");
        proc.StandardInput.Close();

        string output = proc.StandardOutput.ReadToEnd();
        proc.WaitForExit();
        return output;
    }

    public static void Main()
    {
        var exe = System.IO.Path.Combine("..", "..", "build", "asmdb.exe");
        var db = new AsmdbClient(exe, "DemoDB", "notes");
        Console.Write(db.Run(
            "BEGIN",
            "INSERT 1 500 alice first memory about alice",
            "INSERT 2 750 bob follow-up on bob",
            "COMMIT",
            "SELECT *"));
    }
}
