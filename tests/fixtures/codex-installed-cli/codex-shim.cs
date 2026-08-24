using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

public static class CodexShim
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        var node = Environment.GetEnvironmentVariable("AUTOPROMPT_FAKE_CODEX_NODE");
        var provider = Environment.GetEnvironmentVariable("AUTOPROMPT_FAKE_CODEX_PROVIDER");
        if (String.IsNullOrEmpty(node) || String.IsNullOrEmpty(provider)) return 64;
        var start = new ProcessStartInfo(node, Quote(provider) + " " + String.Join(" ", args.Select(Quote))) {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        using (var child = Process.Start(start)) {
            child.StandardInput.Write(Console.In.ReadToEnd());
            child.StandardInput.Close();
            var stdout = child.StandardOutput.ReadToEnd();
            var stderr = child.StandardError.ReadToEnd();
            child.WaitForExit();
            Console.Out.Write(stdout);
            Console.Error.Write(stderr);
            return child.ExitCode;
        }
    }
}
