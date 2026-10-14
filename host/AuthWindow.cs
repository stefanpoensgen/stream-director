// Twitch window for the login or for connecting the followed channels. Shares the app's WebView2 environment
// (cookies) and closes itself once its job is done — Twitch would otherwise just stay on a homepage or
// success page.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace StreamDirector;

internal sealed class AuthWindow : Form
{
    private const int DialogWidth = 480;
    private const int DialogHeight = 720;
    private const int CheckIntervalMs = 1000;

    private readonly CoreWebView2Environment _environment;
    private readonly string _url;
    private readonly Func<Task<bool>> _isDone;
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };

    // Some steps finish without a navigation (the follows are confirmed in the background), so check periodically too
    private readonly Timer _checkTimer = new() { Interval = CheckIntervalMs };

    public bool Completed { get; private set; }

    public AuthWindow(CoreWebView2Environment environment, string url, string title, Func<Task<bool>> isDone, Icon icon)
    {
        _environment = environment;
        _url = url;
        _isDone = isDone;

        Text = title;
        Icon = icon;
        StartPosition = FormStartPosition.CenterParent;
        ShowInTaskbar = false;
        ClientSize = new Size(LogicalToDeviceUnits(DialogWidth), LogicalToDeviceUnits(DialogHeight));
        Controls.Add(_webView);
        _checkTimer.Tick += async (_, _) => await CloseWhenDoneAsync();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);

        try
        {
            await _webView.EnsureCoreWebView2Async(_environment);

            // Twitch's pages are single-page apps: watch real navigations and history changes
            _webView.CoreWebView2.NavigationCompleted += async (_, _) => await CloseWhenDoneAsync();
            _webView.CoreWebView2.SourceChanged += async (_, _) => await CloseWhenDoneAsync();
            _webView.CoreWebView2.Navigate(_url);
            _checkTimer.Start();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, $"Twitch could not be opened:\n{error.Message}", Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _checkTimer.Dispose();
        base.OnFormClosed(e);
    }

    private async Task CloseWhenDoneAsync()
    {
        try
        {
            if (Completed || IsDisposed || !await _isDone()) return;

            Completed = true;
            Close();
        }
        catch (Exception error)
        {
            // The window stays open — the user can still close it by hand
            Trace.WriteLine($"Twitch window check failed: {error.Message}");
        }
    }
}
