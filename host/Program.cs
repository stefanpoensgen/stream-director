using System;
using System.Linq;
using System.Windows.Forms;

namespace StreamDirector;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(isDev: args.Contains("--dev")));
    }
}
