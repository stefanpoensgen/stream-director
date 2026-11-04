// Chat popup: StreamDirector's own chat page (chat.html) in a window of its own, beside the main window.
// Shares the app's WebView2 environment, so the page talks to the main page over a BroadcastChannel.
// Remembers where it was, how big and how zoomed — a chat window usually lives at one fixed spot.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace StreamDirector;

internal sealed class ChatWindow : Form
{
    public const string PagePath = "/chat.html";

    private const int DefaultWidth = 400;
    private const int DefaultHeight = 760;
    private const int ScreenMargin = 8;

    private static readonly Color BackgroundColor = Color.Black;

    private static readonly string BoundsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StreamDirector", "chat-window.json");

    private readonly CoreWebView2Environment _environment;
    private readonly AppRequestHandler _requestHandler;
    private readonly bool _isDev;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = BackgroundColor };
    private double _zoomFactor = 1;

    public ChatWindow(CoreWebView2Environment environment, AppRequestHandler requestHandler, bool isDev, Icon icon, Rectangle mainBounds)
    {
        _environment = environment;
        _requestHandler = requestHandler;
        _isDev = isDev;

        Text = "Chat";
        Icon = icon;
        BackColor = BackgroundColor;
        StartPosition = FormStartPosition.Manual;
        Controls.Add(_webView);
        PlaceWindow(mainBounds);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        NativeMethods.UseDarkTitleBar(Handle);
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);

        try
        {
            await InitializeWebViewAsync();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, $"The chat could not be opened:\n{error.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        SaveBounds();
        base.OnFormClosing(e);
    }

    private async Task InitializeWebViewAsync()
    {
        await _webView.EnsureCoreWebView2Async(_environment);

        var core = _webView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = _isDev;
        core.Settings.AreBrowserAcceleratorKeysEnabled = _isDev;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;
        // Ctrl + mouse wheel scales the chat text — remembered with the window
        core.Settings.IsZoomControlEnabled = true;
        _webView.ZoomFactor = _zoomFactor;

        core.AddWebResourceRequestedFilter($"{AppRequestHandler.Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += _requestHandler.OnWebResourceRequested;
        core.NavigationStarting += (_, args) =>
        {
            if (!args.Uri.StartsWith($"{AppRequestHandler.Origin}/", StringComparison.Ordinal)) args.Cancel = true;
        };
        core.NewWindowRequested += OnNewWindowRequested;
        core.DocumentTitleChanged += (_, _) => Text = core.DocumentTitle;

        if (_isDev) core.OpenDevToolsWindow();

        core.Navigate($"{AppRequestHandler.Origin}{PagePath}");
    }

    /// <summary>
    /// Twitch's own chat popout (polls, predictions, channel points) opens as a WebView2 window with our cookies;
    /// links posted in chat open in the default browser.
    /// </summary>
    private static void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        {
            args.Handled = true;
            return;
        }

        var isTwitch = uri.Host == "twitch.tv" || uri.Host.EndsWith(".twitch.tv", StringComparison.Ordinal);
        if (isTwitch && uri.AbsolutePath.StartsWith("/popout/", StringComparison.Ordinal)) return;

        args.Handled = true;
        Process.Start(uri.AbsoluteUri);
    }

    /// <summary>Where the window was last time, or right of the main window when that is unknown or off-screen.</summary>
    private void PlaceWindow(Rectangle mainBounds)
    {
        var saved = LoadBounds();
        if (saved?.Zoom > 0) _zoomFactor = saved.Zoom;

        if (saved is not null && IsOnScreen(saved.Bounds))
        {
            Bounds = saved.Bounds;
            return;
        }

        var size = new Size(LogicalToDeviceUnits(DefaultWidth), LogicalToDeviceUnits(DefaultHeight));
        var area = Screen.FromRectangle(mainBounds).WorkingArea;
        var left = mainBounds.Right + size.Width <= area.Right ? mainBounds.Right : area.Right - size.Width - ScreenMargin;
        var top = Math.Max(area.Top, Math.Min(mainBounds.Top, area.Bottom - size.Height));
        Bounds = new Rectangle(new Point(left, top), size);
    }

    private static bool IsOnScreen(Rectangle bounds) =>
        Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(bounds));

    private static SavedBounds? LoadBounds()
    {
        try
        {
            return File.Exists(BoundsPath) ? new JavaScriptSerializer().Deserialize<SavedBounds>(File.ReadAllText(BoundsPath)) : null;
        }
        catch (Exception error)
        {
            Trace.WriteLine($"Chat window position could not be read: {error.Message}");
            return null;
        }
    }

    private void SaveBounds()
    {
        try
        {
            var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var zoom = _webView.CoreWebView2 is null ? _zoomFactor : _webView.ZoomFactor;
            var saved = new SavedBounds { Left = bounds.Left, Top = bounds.Top, Width = bounds.Width, Height = bounds.Height, Zoom = zoom };

            Directory.CreateDirectory(Path.GetDirectoryName(BoundsPath)!);
            File.WriteAllText(BoundsPath, new JavaScriptSerializer().Serialize(saved));
        }
        catch (Exception error)
        {
            Trace.WriteLine($"Chat window position could not be saved: {error.Message}");
        }
    }

    private sealed class SavedBounds
    {
        public int Left { get; set; }
        public int Top { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public double Zoom { get; set; } = 1;

        [ScriptIgnore]
        public Rectangle Bounds => new(Left, Top, Width, Height);
    }
}
