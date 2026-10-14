using System;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;

namespace StreamDirector;

internal static class NativeMethods
{
    // Resource ID the C# compiler assigns to <ApplicationIcon>
    private const int ApplicationIconResourceId = 32512;
    private const uint ImageTypeIcon = 1;
    private const uint LoadDefaultSize = 0x40;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? moduleName);

    // Dark title bar: attribute 20 since Windows 10 20H1, 19 on older Windows 10 builds
    private const int ImmersiveDarkModeAttribute = 20;
    private const int ImmersiveDarkModeAttributeLegacy = 19;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr LoadImage(IntPtr instance, IntPtr name, uint type, int width, int height, uint load);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    /// <summary>
    /// The exe's own icon via Win32: System.Drawing cannot read PNG-only .ico files and
    /// Icon.ExtractAssociatedIcon fails for UNC paths (e.g. started from WSL).
    /// </summary>
    public static Icon LoadApplicationIcon()
    {
        var handle = LoadImage(GetModuleHandle(null), (IntPtr)ApplicationIconResourceId, ImageTypeIcon, 0, 0, LoadDefaultSize);
        if (handle == IntPtr.Zero) throw new Win32Exception();

        return Icon.FromHandle(handle);
    }

    /// <summary>Dark title bar matching the app. Best effort: older Windows keeps the light one.</summary>
    public static void UseDarkTitleBar(IntPtr window)
    {
        var enabled = 1;
        if (DwmSetWindowAttribute(window, ImmersiveDarkModeAttribute, ref enabled, sizeof(int)) == 0) return;

        DwmSetWindowAttribute(window, ImmersiveDarkModeAttributeLegacy, ref enabled, sizeof(int));
    }
}
