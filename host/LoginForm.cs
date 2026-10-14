// Twitch login window. Shares the app's WebView2 environment (cookies) and closes itself
// as soon as the login cookie exists — Twitch would otherwise just redirect to its homepage.

using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace StreamDirector;

internal sealed class LoginForm : Form
{
    private const int DialogWidth = 480;
    private const int DialogHeight = 720;

    private readonly CoreWebView2Environment _environment;
    private readonly string _loginUrl;
    private readonly TwitchSession _session;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };

    public bool LoggedIn { get; private set; }

    public LoginForm(CoreWebView2Environment environment, string loginUrl, TwitchSession session, Icon icon)
    {
        _environment = environment;
        _loginUrl = loginUrl;
        _session = session;

        Text = "Twitch Login";
        Icon = icon;
        StartPosition = FormStartPosition.CenterParent;
        ShowInTaskbar = false;
        ClientSize = new Size(LogicalToDeviceUnits(DialogWidth), LogicalToDeviceUnits(DialogHeight));
        Controls.Add(_webView);
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);

        try
        {
            await _webView.EnsureCoreWebView2Async(_environment);

            // Twitch's login page is a single-page app: watch real navigations and history changes
            _webView.CoreWebView2.NavigationCompleted += async (_, _) => await CloseWhenLoggedInAsync();
            _webView.CoreWebView2.SourceChanged += async (_, _) => await CloseWhenLoggedInAsync();
            _webView.CoreWebView2.Navigate(_loginUrl);
        }
        catch (Exception error)
        {
            MessageBox.Show(this, $"Twitch login could not be opened:\n{error.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private async Task CloseWhenLoggedInAsync()
    {
        if (LoggedIn || !await _session.IsLoggedInAsync()) return;

        LoggedIn = true;
        Close();
    }
}
