// Twitch login state, kept in the WebView2 cookie store shared by the app and the login window.

using System.Linq;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace StreamDirector;

internal sealed class TwitchSession(CoreWebView2CookieManager cookieManager)
{
    private const string TwitchUrl = "https://www.twitch.tv";
    private const string AuthCookie = "auth-token";

    /// <summary>Auth token of the Twitch login, null when logged out.</summary>
    public async Task<string?> GetAuthTokenAsync()
    {
        var cookies = await cookieManager.GetCookiesAsync(TwitchUrl);

        return cookies.FirstOrDefault(cookie => cookie.Name == AuthCookie)?.Value;
    }

    public async Task<bool> IsLoggedInAsync() => await GetAuthTokenAsync() is not null;

    /// <summary>Removes all twitch.tv cookies — the auth token alone would leave a half-logged-in session.</summary>
    public async Task LogoutAsync()
    {
        foreach (var cookie in await cookieManager.GetCookiesAsync(TwitchUrl))
        {
            cookieManager.DeleteCookie(cookie);
        }
    }
}
