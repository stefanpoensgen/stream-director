// Frameless 1920×1080 window hosting the renderer in WebView2 (the Edge engine built into Windows).

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
    private const string TwitchLoginPath = "/login";
    private const string GitHubUrlPrefix = "https://github.com/";

    // Autoplay with sound for the focused stream without a click first
    private const string BrowserArguments = "--autoplay-policy=no-user-gesture-required";

    private static readonly Color BackgroundColor = ColorTranslator.FromHtml("#0a0a0f");

    private readonly bool _isDev;
    private CoreWebView2Environment? _environment;
    private LoginForm? _loginForm;
    private TwitchSession? _session;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = BackgroundColor };

    public MainForm(bool isDev)
    {
        _isDev = isDev;

        Text = "StreamDirector";
        Icon = NativeMethods.LoadApplicationIcon();
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = BackgroundColor;
        ClientSize = new Size(LogicalToDeviceUnits(ContentWidth), LogicalToDeviceUnits(ContentHeight));
        Controls.Add(_webView);
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
        core.Settings.IsNonClientRegionSupportEnabled = true; // CSS app-region: drag moves the window
        core.Settings.AreDevToolsEnabled = _isDev;
        _webView.AllowExternalDrop = false; // a dropped file or link would replace the app page

        _session = new TwitchSession(core.CookieManager);
        var requestHandler = new AppRequestHandler(environment, new TwitchClient(), _session);
        core.AddWebResourceRequestedFilter($"{AppRequestHandler.Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += requestHandler.OnWebResourceRequested;

        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.WindowCloseRequested += (_, _) => Close();
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

        // Other Twitch popups (chat) open as WebView2 windows sharing our cookies
        if (isTwitch) return;

        args.Handled = true;
        if (args.Uri.StartsWith(GitHubUrlPrefix, StringComparison.Ordinal)) Process.Start(args.Uri);
    }

    /// <summary>
    /// Non-modal on purpose: a nested message loop (ShowDialog) started from a WebView2 callback
    /// stops WebView2 from delivering further callbacks — the login page would never load.
    /// </summary>
    private async void ShowLogin(string loginUrl)
    {
        if (_loginForm is not null)
        {
            _loginForm.Activate();
            return;
        }

        // Claim the slot before the first await — a second click must not open another window
        var login = new LoginForm(_environment!, loginUrl, _session!, Icon);
        _loginForm = login;

        try
        {
            var tokenBefore = await _session!.GetAuthTokenAsync();
            login.FormClosed += async (_, _) => await OnLoginClosedAsync(login, tokenBefore);
            login.Show(this);
        }
        catch (Exception error)
        {
            _loginForm = null;
            login.Dispose();
            MessageBox.Show(this, $"Twitch login could not be opened:\n{error.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task OnLoginClosedAsync(LoginForm login, string? tokenBefore)
    {
        if (_loginForm == login) _loginForm = null;
        login.Dispose();

        try
        {
            // Playlists requested before the login are anonymous — reload so Turbo applies to all streams
            if (login.LoggedIn && await _session!.GetAuthTokenAsync() != tokenBefore) _webView.CoreWebView2.Reload();
        }
        catch (Exception error)
        {
            Trace.WriteLine($"Reload after login failed: {error.Message}");
        }
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

        if (message == ToggleFullscreenMessage) ToggleFullscreen();
    }

    /// <summary>A maximized borderless window covers the whole screen including the taskbar.</summary>
    private void ToggleFullscreen()
    {
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
    }
}
