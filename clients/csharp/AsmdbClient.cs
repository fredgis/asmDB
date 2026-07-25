// Minimal asmdb client for C# (.NET).
//
// asmdb has no network protocol or client library: it is a REPL that reads
// commands from stdin and writes results to stdout. This client "connects" by
// launching asmdb as a child process, writing commands to stdin, and reading
// stdout back.
//
// Drop AsmdbClient.cs into any .NET project.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

public sealed class AsmdbClient
{
    private readonly string _exe;
    private readonly string _database;
    private readonly string? _table;

    public AsmdbClient(string database, string? table = null, string? exe = null)
    {
        _exe = exe ?? DefaultExe();
        _database = database;
        _table = table;
    }

    public static string DefaultExe()
    {
        var env = Environment.GetEnvironmentVariable("ASMDB_EXE");
        if (!string.IsNullOrEmpty(env))
            return env;

        var name = RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
            ? "asmdb.exe"
            : "asmdb";
        return Path.Combine("..", "..", "build", name);
    }

    // Send commands (one per array element), then QUIT. Returns raw stdout.
    public string Run(params string[] commands)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _exe,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(_database);
        if (_table is not null)
            psi.ArgumentList.Add(_table);

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("failed to start asmdb");

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
        var db = new AsmdbClient("DemoDB", "notes");
        Console.Write(db.Run(
            "BEGIN",
            "INSERT 1 500 alice first memory about alice",
            "INSERT 2 750 bob follow-up on bob",
            "COMMIT",
            "FORMAT TSV",
            "SELECT *"));
    }
}
