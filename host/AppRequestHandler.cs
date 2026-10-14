// Answers every request to the app origin inside WebView2 — no local HTTP server needed.
// Serves the renderer files and the Twitch API the renderer cannot call itself (CORS).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

namespace StreamDirector;

internal sealed class AppRequestHandler(
    CoreWebView2Environment environment,
    TwitchClient twitch,
    TwitchSession session)
{
    // Twitch's playlist servers only accept requests from localhost or twitch.tv origins (403 otherwise).
    // Nothing listens on localhost: WebView2 hands every request to this handler.
    public const string Origin = "https://localhost";

    private static readonly Dictionary<string, string> ContentTypes = new()
    {
        [".html"] = "text/html; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".mjs"] = "text/javascript; charset=utf-8",
    };

    private const string FallbackContentType = "application/octet-stream";
    private const string JsonContentType = "application/json";
    private const string PlaylistContentType = "application/vnd.apple.mpegurl";
    private const string LiveRoute = "/api/live";
    private const string AuthRoute = "/api/auth";
    private const string LogoutRoute = "/api/logout";
    private const string FollowedLiveRoute = "/api/follows/live";
    private static readonly Regex PlaylistRoute = new(@"^/api/playlist/([a-z0-9_]+)\.m3u8$");

    private readonly JavaScriptSerializer _json = new();

    public async void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        var deferral = args.GetDeferral();

        try
        {
            args.Response = await RouteAsync(new Uri(args.Request.Uri), args.Request);
        }
        catch (Exception error)
        {
            Trace.WriteLine($"{args.Request.Uri}: {error.Message}");
            args.Response = Text(502, "Upstream error");
        }
        finally
        {
            deferral.Complete();
        }
    }

    private async Task<CoreWebView2WebResourceResponse> RouteAsync(Uri uri, CoreWebView2WebResourceRequest request)
    {
        if (uri.AbsolutePath == LiveRoute) return await LiveAsync(uri);
        if (uri.AbsolutePath == AuthRoute) return await AuthAsync();
        if (uri.AbsolutePath == LogoutRoute) return await LogoutAsync(request);
        if (uri.AbsolutePath == FollowedLiveRoute) return await FollowedLiveAsync();

        var playlistMatch = PlaylistRoute.Match(uri.AbsolutePath);
        if (playlistMatch.Success) return await PlaylistAsync(playlistMatch.Groups[1].Value);

        return Static(uri.AbsolutePath);
    }

    private async Task<CoreWebView2WebResourceResponse> LiveAsync(Uri uri)
    {
        var channels = QueryValue(uri, "channels")
            .Split([','], StringSplitOptions.RemoveEmptyEntries)
            .ToList();
        if (!channels.All(TwitchClient.IsValidChannelName)) return Text(400, "Invalid channel name");

        var liveChannels = await twitch.FetchLiveChannelsAsync(channels);

        return Response(200, _json.Serialize(liveChannels), JsonContentType);
    }

    private async Task<CoreWebView2WebResourceResponse> PlaylistAsync(string channel)
    {
        if (!TwitchClient.IsValidChannelName(channel)) return Text(400, "Invalid channel name");

        var (status, playlist) = await twitch.FetchMasterPlaylistAsync(channel, await session.GetAuthTokenAsync());

        return status switch
        {
            PlaylistStatus.Offline => Text(404, "Channel offline"),
            PlaylistStatus.Forbidden => Text(403, "Playback not allowed"),
            _ => Response(200, playlist!, PlaylistContentType),
        };
    }

    private async Task<CoreWebView2WebResourceResponse> FollowedLiveAsync()
    {
        var authToken = await session.GetAuthTokenAsync();
        if (authToken is null) return Text(401, "Not logged in");

        var followed = await twitch.FetchFollowedLiveAsync(authToken);
        if (followed is null) return Text(401, "Login not accepted");

        return Response(200, _json.Serialize(followed), JsonContentType);
    }

    private async Task<CoreWebView2WebResourceResponse> AuthAsync() =>
        Response(200, _json.Serialize(new { loggedIn = await session.IsLoggedInAsync() }), JsonContentType);

    private async Task<CoreWebView2WebResourceResponse> LogoutAsync(CoreWebView2WebResourceRequest request)
    {
        if (request.Method != "POST") return Text(405, "Method not allowed");
        if (!IsFromApp(request)) return Text(403, "Forbidden");

        await session.LogoutAsync();

        return Response(200, _json.Serialize(new { loggedIn = false }), JsonContentType);
    }

    /// <summary>Renderer files come from the exe's wwwroot/* resources — only what the project embeds is served.</summary>
    private CoreWebView2WebResourceResponse Static(string path)
    {
        var file = path == "/" ? "index.html" : path.TrimStart('/');
        var content = EmbeddedFiles.Read($"wwwroot/{file}");
        if (content is null) return Text(404, "Not found");

        var contentType = ContentTypes.TryGetValue(Path.GetExtension(file), out var type) ? type : FallbackContentType;

        return Response(200, content, contentType);
    }

    /// <summary>State-changing requests must come from the app page itself (browsers always send Origin on POST).</summary>
    private static bool IsFromApp(CoreWebView2WebResourceRequest request) =>
        request.Headers.Contains("Origin") && request.Headers.GetHeader("Origin") == Origin;

    private static string QueryValue(Uri uri, string key)
    {
        var pair = uri.Query.TrimStart('?')
            .Split('&')
            .Select(part => part.Split(['='], 2))
            .FirstOrDefault(parts => parts[0] == key);

        return pair is { Length: 2 } ? Uri.UnescapeDataString(pair[1]) : string.Empty;
    }

    private CoreWebView2WebResourceResponse Text(int status, string body) => Response(status, body, "text/plain");

    private CoreWebView2WebResourceResponse Response(int status, string body, string contentType) =>
        Response(status, Encoding.UTF8.GetBytes(body), contentType);

    private CoreWebView2WebResourceResponse Response(int status, byte[] body, string contentType) =>
        environment.CreateWebResourceResponse(
            new MemoryStream(body),
            status,
            status == 200 ? "OK" : "Error",
            $"Content-Type: {contentType}\nCache-Control: no-store");
}
