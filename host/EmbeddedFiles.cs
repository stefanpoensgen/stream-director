// Files embedded in the exe (see StreamDirector.csproj): renderer, licenses, WebView2 assemblies and loader.
// They make StreamDirector.exe a single-file app — no DLLs or folders next to it.

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace StreamDirector;

internal static class EmbeddedFiles
{
    private const string LoaderFileName = "WebView2Loader.dll";
    private const int LoaderHashLength = 12;

    private static readonly Assembly App = Assembly.GetExecutingAssembly();
    private static readonly Dictionary<string, Assembly> LoadedAssemblies = new();

    /// <summary>Content of an embedded file, null when there is none with that name.</summary>
    public static byte[]? Read(string name)
    {
        using var stream = App.GetManifestResourceStream(name);
        if (stream is null) return null;

        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);

        return buffer.ToArray();
    }

    /// <summary>
    /// AssemblyResolve handler: loads WebView2's managed assemblies from the exe. Cached — the event can
    /// fire again for an assembly loaded from bytes, and a second copy would break type identity.
    /// </summary>
    public static Assembly? ResolveAssembly(object? sender, ResolveEventArgs args)
    {
        var name = new AssemblyName(args.Name).Name;

        lock (LoadedAssemblies)
        {
            if (LoadedAssemblies.TryGetValue(name, out var loaded)) return loaded;

            var bytes = Read($"assemblies/{name}.dll");
            if (bytes is null) return null;

            var assembly = Assembly.Load(bytes);
            LoadedAssemblies[name] = assembly;

            return assembly;
        }
    }

    /// <summary>
    /// The native WebView2 loader cannot be loaded from memory: write it once to local app data and
    /// return its folder. The folder is named after the file's hash, so an update never reuses a stale copy.
    /// </summary>
    public static string ExtractWebView2Loader()
    {
        var architecture = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win-x64",
            Architecture.X86 => "win-x86",
            Architecture.Arm64 => "win-arm64",
            var other => throw new PlatformNotSupportedException($"Unsupported architecture: {other}"),
        };

        var loader = Read($"native/{architecture}/{LoaderFileName}")
            ?? throw new InvalidOperationException($"{LoaderFileName} for {architecture} is not embedded");

        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "StreamDirector",
            "WebView2Loader",
            $"{architecture}-{ShortHash(loader)}");
        var target = Path.Combine(folder, LoaderFileName);
        if (File.Exists(target)) return folder;

        // Write next to the target and move into place: a second instance never sees a half-written DLL
        Directory.CreateDirectory(folder);
        var temporary = Path.Combine(folder, $"{Guid.NewGuid():N}.tmp");
        File.WriteAllBytes(temporary, loader);

        try
        {
            File.Move(temporary, target);
        }
        catch (IOException) when (File.Exists(target))
        {
            File.Delete(temporary); // another instance was faster — its copy is identical
        }

        return folder;
    }

    private static string ShortHash(byte[] content)
    {
        using var sha256 = SHA256.Create();
        var hex = BitConverter.ToString(sha256.ComputeHash(content)).Replace("-", string.Empty);

        return hex.Substring(0, LoaderHashLength).ToLowerInvariant();
    }
}
