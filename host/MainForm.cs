// 1920×1080 window hosting the renderer in WebView2 (the Edge engine built into Windows).
// A normal window with title bar: OBS window capture records only the client area by default.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace StreamDirector;

internal sealed class MainForm : Form
{
    private const int ContentWidth = 1920;
    private const int ContentHeight = 1080;
    private const string ToggleFullscreenMessage = "toggle-fullscreen";
    private const string AudioMessagePrefix = "audio:";
    private const string TwitchLoginPath = "/login";
    private const string TwitchActivatePath = "/activate";
    private const string GitHubUrlPrefix = "https://github.com/";

    // Autoplay with sound for the focused stream without a click first
    private const string BrowserArguments = "--autoplay-policy=no-user-gesture-required";

    private static readonly Color BackgroundColor = ColorTranslator.FromHtml("#0a0a0f");

    private readonly bool _isDev;
    private CoreWebView2Environment? _environment;
    private AuthWindow? _authWindow;
    private readonly FollowsConnection _follows = new();
    private readonly AudioRenderer _audioRenderer = new();
    private bool _isFullscreen;
    private FormWindowState _windowStateBeforeFullscreen;
    private TwitchSession? _session;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = BackgroundColor };

    public MainForm(bool isDev)
    {
        _isDev = isDev;

        Text = "StreamDirector";
        Icon = NativeMethods.LoadApplicationIcon();
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = BackgroundColor;
        ClientSize = new Size(LogicalToDeviceUnits(ContentWidth), LogicalToDeviceUnits(ContentHeight));
        Controls.Add(_webView);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _audioRenderer.Dispose();
        base.OnFormClosed(e);
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
            MessageBox.Show($"WebView2 could not be started:\n{error.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private async Task InitializeWebViewAsync()
    {
        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StreamDirector", "WebView2");
        CoreWebView2Environment.SetLoaderDllFolderPath(EmbeddedFiles.ExtractWebView2Loader());
        var options = new CoreWebView2EnvironmentOptions(BrowserArguments);
        var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
        _environment = environment;
        await _webView.EnsureCoreWebView2Async(environment);

        var core = _webView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = _isDev;
        _webView.AllowExternalDrop = false; // a dropped file or link would replace the app page

        _session = new TwitchSession(core.CookieManager);
        var requestHandler = new AppRequestHandler(environment, new TwitchClient(), _session, _follows);
        core.AddWebResourceRequestedFilter($"{AppRequestHandler.Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += requestHandler.OnWebResourceRequested;

        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.WebMessageReceived += OnWebMessageReceived;
        await core.AddScriptToExecuteOnDocumentCreatedAsync(HostScript());

        if (_isDev) core.OpenDevToolsWindow();

        core.Navigate(_isDev ? $"{AppRequestHandler.Origin}/?dev" : $"{AppRequestHandler.Origin}/");
    }

    /// <summary>Glue the renderer expects from its host: version label and F11 fullscreen.</summary>
    private static string HostScript()
    {
        var version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

        return $$"""
            document.addEventListener('DOMContentLoaded', () => {
              document.querySelector('.version')?.replaceChildren('v{{version}}');
            });
            document.addEventListener('keydown', (event) => {
              if (event.key !== 'F11') return;
              event.preventDefault();
              window.chrome.webview.postMessage('{{ToggleFullscreenMessage}}');
            });
            """;
    }

    private static bool IsAppUrl(string url) => url.StartsWith($"{AppRequestHandler.Origin}/", StringComparison.Ordinal);

    /// <summary>The main view only ever shows the app — external pages must not inherit the host API.</summary>
    private static void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (!IsAppUrl(args.Uri)) args.Cancel = true;
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri))
        {
            args.Handled = true;
            return;
        }

        var isTwitch = uri.Host == "twitch.tv" || uri.Host.EndsWith(".twitch.tv", StringComparison.Ordinal);

        if (isTwitch && uri.AbsolutePath.StartsWith(TwitchLoginPath, StringComparison.Ordinal))
        {
            args.Handled = true;
            ShowLogin(args.Uri);
            return;
        }

        if (isTwitch && uri.AbsolutePath.StartsWith(TwitchActivatePath, StringComparison.Ordinal))
        {
            args.Handled = true;
            ShowAuthWindow(args.Uri, "Connect followed channels", () => Task.FromResult(_follows.IsConnected), _ => Task.CompletedTask);
            return;
        }

        // Other Twitch popups (chat) open as WebView2 windows sharing our cookies
        if (isTwitch) return;

        args.Handled = true;
        if (args.Uri.StartsWith(GitHubUrlPrefix, StringComparison.Ordinal)) Process.Start(args.Uri);
    }

    private async void ShowLogin(string loginUrl)
    {
        try
        {
            var tokenBefore = await _session!.GetAuthTokenAsync();

            ShowAuthWindow(loginUrl, "Twitch Login", _session.IsLoggedInAsync, async window =>
            {
                // Playlists requested before the login are anonymous — reload so Turbo applies to all streams
                if (window.Completed && await _session.GetAuthTokenAsync() != tokenBefore) _webView.CoreWebView2.Reload();
            });
        }
        catch (Exception error)
        {
            Trace.WriteLine($"Twitch login could not be opened: {error.Message}");
        }
    }

    /// <summary>
    /// Non-modal on purpose: a nested message loop (ShowDialog) started from a WebView2 callback
    /// stops WebView2 from delivering further callbacks — the page would never load.
    /// One window at a time: another request brings the open one to the front.
    /// </summary>
    private void ShowAuthWindow(string url, string title, Func<Task<bool>> isDone, Func<AuthWindow, Task> onClosed)
    {
        if (_authWindow is not null)
        {
            _authWindow.Activate();
            return;
        }

        var window = new AuthWindow(_environment!, url, title, isDone, Icon);
        _authWindow = window;
        window.FormClosed += async (_, _) =>
        {
            if (_authWindow == window) _authWindow = null;

            try
            {
                await onClosed(window);
            }
            catch (Exception error)
            {
                Trace.WriteLine($"Closing the Twitch window failed: {error.Message}");
            }
            finally
            {
                window.Dispose();
            }
        };
        window.Show(this);
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!IsAppUrl(args.Source)) return;

        string message;
        try
        {
            message = args.TryGetWebMessageAsString();
        }
        catch (ArgumentException)
        {
            return; // not a string message — nothing the host understands
        }

        if (message.StartsWith(AudioMessagePrefix, StringComparison.Ordinal))
        {
            _audioRenderer.Enqueue(Convert.FromBase64String(message.Substring(AudioMessagePrefix.Length)));
            return;
        }

        if (message == ToggleFullscreenMessage) ToggleFullscreen();
    }

    /// <summary>
    /// Fullscreen = borderless + maximized, which also covers the taskbar.
    /// Leaving it brings back the title bar and the previous window state.
    /// </summary>
    private void ToggleFullscreen()
    {
        if (_isFullscreen)
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            WindowState = _windowStateBeforeFullscreen;
        }
        else
        {
            _windowStateBeforeFullscreen = WindowState;

            // Maximize only after removing the frame — a window maximized with frame keeps the taskbar visible
            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Maximized;
        }

        _isFullscreen = !_isFullscreen;
    }
}
