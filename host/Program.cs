using System;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Windows.Forms;

namespace StreamDirector;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Before any WebView2 type is touched: its assemblies live inside this exe
        AppDomain.CurrentDomain.AssemblyResolve += EmbeddedFiles.ResolveAssembly;

        Run(args);
    }

    // Separate, never inlined: compiling it loads MainForm and with it WebView2 — only after the resolver exists
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(isDev: args.Contains("--dev")));
    }
}
