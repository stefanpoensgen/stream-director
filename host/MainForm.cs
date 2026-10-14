// Frameless 1920×1080 window hosting the renderer in WebView2 (the Edge engine built into Windows).

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
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
    private const string TwitchUrl = "https://www.twitch.tv";
    private const string TwitchAuthCookie = "auth-token";
    private const string GitHubUrlPrefix = "https://github.com/";

    // Autoplay with sound for the focused stream without a click first
    private const string BrowserArguments = "--autoplay-policy=no-user-gesture-required";

    private static readonly Color BackgroundColor = ColorTranslator.FromHtml("#0a0a0f");

    private readonly bool _isDev;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = BackgroundColor };

    public MainForm(bool isDev)
    {
        _isDev = isDev;

        Text = "StreamDirector";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
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
        var options = new CoreWebView2EnvironmentOptions(BrowserArguments);
        var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
        await _webView.EnsureCoreWebView2Async(environment);

        var core = _webView.CoreWebView2;
        core.Settings.IsNonClientRegionSupportEnabled = true; // CSS app-region: drag moves the window
        core.Settings.AreDevToolsEnabled = _isDev;

        var webRoot = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot");
        var requestHandler = new AppRequestHandler(environment, webRoot, new TwitchClient(), GetTwitchAuthTokenAsync);
        core.AddWebResourceRequestedFilter($"{AppRequestHandler.Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += requestHandler.OnWebResourceRequested;

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

    /// <summary>Auth token of the Twitch login (shared cookie store), null when logged out.</summary>
    private async Task<string?> GetTwitchAuthTokenAsync()
    {
        var cookies = await _webView.CoreWebView2.CookieManager.GetCookiesAsync(TwitchUrl);

        return cookies.FirstOrDefault(cookie => cookie.Name == TwitchAuthCookie)?.Value;
    }

    private static void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        var host = new Uri(args.Uri).Host;
        var isTwitch = host == "twitch.tv" || host.EndsWith(".twitch.tv", StringComparison.Ordinal);

        // Twitch popups (login, chat) open as WebView2 windows sharing our cookies
        if (isTwitch) return;

        args.Handled = true;
        if (args.Uri.StartsWith(GitHubUrlPrefix, StringComparison.Ordinal)) Process.Start(args.Uri);
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (args.TryGetWebMessageAsString() == ToggleFullscreenMessage) ToggleFullscreen();
    }

    /// <summary>A maximized borderless window covers the whole screen including the taskbar.</summary>
    private void ToggleFullscreen()
    {
        WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
    }
}
