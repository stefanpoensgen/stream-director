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
    string webRoot,
    TwitchClient twitch,
    Func<Task<string?>> getAuthToken)
{
    // Twitch's playlist servers only accept requests from localhost or twitch.tv origins (403 otherwise).
    // Nothing listens on localhost: WebView2 hands every request to this handler.
    public const string Origin = "https://localhost";

    /// <summary>Renderer files — the only files handed out.</summary>
    private static readonly HashSet<string> StaticFiles =
        ["index.html", "app.js", "player.js", "styles.css", "vendor/hls.light.mjs"];

    private static readonly Dictionary<string, string> ContentTypes = new()
    {
        [".html"] = "text/html; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".mjs"] = "text/javascript; charset=utf-8",
    };

    private const string JsonContentType = "application/json";
    private const string PlaylistContentType = "application/vnd.apple.mpegurl";
    private const string LiveRoute = "/api/live";
    private static readonly Regex PlaylistRoute = new(@"^/api/playlist/([a-z0-9_]+)\.m3u8$");

    private readonly JavaScriptSerializer _json = new();

    public async void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        var deferral = args.GetDeferral();

        try
        {
            args.Response = await RouteAsync(new Uri(args.Request.Uri));
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

    private async Task<CoreWebView2WebResourceResponse> RouteAsync(Uri uri)
    {
        if (uri.AbsolutePath == LiveRoute) return await LiveAsync(uri);

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

        var playlist = await twitch.FetchMasterPlaylistAsync(channel, await getAuthToken());
        if (playlist is null) return Text(404, "Channel offline");

        return Response(200, playlist, PlaylistContentType);
    }

    private CoreWebView2WebResourceResponse Static(string path)
    {
        var file = path == "/" ? "index.html" : path.TrimStart('/');
        if (!StaticFiles.Contains(file)) return Text(404, "Not found");

        var content = File.ReadAllBytes(Path.Combine(webRoot, file));

        return Response(200, content, ContentTypes[Path.GetExtension(file)]);
    }

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
