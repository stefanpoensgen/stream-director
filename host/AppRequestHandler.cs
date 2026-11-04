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
    TwitchSession session,
    FollowsConnection follows)
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
    private const string FollowedRoute = "/api/follows";
    private const string FollowsConnectRoute = "/api/follows/connect";
    private const string ChatIdentityRoute = "/api/chat/identity";
    private const string ChatEmotesRoute = "/api/chat/emotes";
    private const string ChatChannelsRoute = "/api/chat/channels";
    private static readonly Regex UserIdPattern = new("^[0-9]{1,20}$");
    private static readonly Regex PlaylistRoute = new(@"^/api/playlist/([a-z0-9_]+)\.m3u8$");
    private static readonly Regex AvatarRoute = new(@"^/api/avatar/([a-z0-9_]+)$");
    private static readonly Regex ChatBadgesRoute = new(@"^/api/chat/badges/([a-z0-9_]+)$");
    private static readonly Regex ChatCheermotesRoute = new(@"^/api/chat/cheermotes/([a-z0-9_]+)$");

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
            // The message (e.g. Twitch's "failed integrity check") helps diagnosing; it never contains tokens
            args.Response = Text(502, error.Message);
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
        if (uri.AbsolutePath == FollowedRoute) return await FollowedAsync();
        if (uri.AbsolutePath == FollowsConnectRoute) return await FollowsConnectAsync(request);
        if (uri.AbsolutePath == ChatIdentityRoute) return await ChatIdentityAsync();
        if (uri.AbsolutePath == ChatEmotesRoute) return await ChatEmotesAsync();
        if (uri.AbsolutePath == ChatChannelsRoute) return await ChatChannelsAsync(uri);

        var playlistMatch = PlaylistRoute.Match(uri.AbsolutePath);
        if (playlistMatch.Success) return await PlaylistAsync(playlistMatch.Groups[1].Value);

        var avatarMatch = AvatarRoute.Match(uri.AbsolutePath);
        if (avatarMatch.Success) return await AvatarAsync(avatarMatch.Groups[1].Value);

        var chatBadgesMatch = ChatBadgesRoute.Match(uri.AbsolutePath);
        if (chatBadgesMatch.Success) return await ChatBadgesAsync(chatBadgesMatch.Groups[1].Value);

        var chatCheermotesMatch = ChatCheermotesRoute.Match(uri.AbsolutePath);
        if (chatCheermotesMatch.Success) return await ChatCheermotesAsync(chatCheermotesMatch.Groups[1].Value);

        return Static(uri.AbsolutePath);
    }

    private async Task<CoreWebView2WebResourceResponse> LiveAsync(Uri uri)
    {
        var channels = QueryValue(uri, "channels")
            .Split([','], StringSplitOptions.RemoveEmptyEntries)
            .ToList();
        if (!channels.All(TwitchClient.IsValidChannelName)) return Text(400, "Invalid channel name");

        var liveStreams = await twitch.FetchLiveStreamsAsync(channels);

        return Response(200, _json.Serialize(liveStreams), JsonContentType);
    }

    private async Task<CoreWebView2WebResourceResponse> PlaylistAsync(string channel)
    {
        if (!TwitchClient.IsValidChannelName(channel)) return Text(400, "Invalid channel name");

        var authToken = await session.GetAuthTokenAsync();
        var (status, playlist) = await twitch.FetchMasterPlaylistAsync(channel, authToken);

        return status switch
        {
            PlaylistStatus.Offline => Text(404, "Channel offline"),
            PlaylistStatus.Forbidden => Text(403, "Playback not allowed"),
            _ => Response(200, playlist!, PlaylistContentType),
        };
    }

    private async Task<CoreWebView2WebResourceResponse> AvatarAsync(string channel)
    {
        if (!TwitchClient.IsValidChannelName(channel)) return Text(400, "Invalid channel name");

        var avatar = await twitch.FetchAvatarAsync(channel);

        return avatar is { } image ? Response(200, image.Content, image.ContentType) : Text(404, "Unknown channel");
    }

    /// <summary>{ connected: false } until the follows are connected, then { connected: true, channels: [all follows] }.</summary>
    private async Task<CoreWebView2WebResourceResponse> FollowedAsync()
    {
        if (!follows.IsConnected) return Response(200, _json.Serialize(new { connected = false }), JsonContentType);

        var channels = await follows.FetchFollowedAsync();

        return Response(200, _json.Serialize(new { connected = true, channels }), JsonContentType);
    }

    private async Task<CoreWebView2WebResourceResponse> FollowsConnectAsync(CoreWebView2WebResourceRequest request)
    {
        if (request.Method != "POST") return Text(405, "Method not allowed");
        if (!IsFromApp(request)) return Text(403, "Forbidden");

        var (userCode, verificationUri) = await follows.StartConnectAsync();

        return Response(200, _json.Serialize(new { userCode, verificationUri }), JsonContentType);
    }

    private async Task<CoreWebView2WebResourceResponse> ChatBadgesAsync(string channel)
    {
        if (!TwitchClient.IsValidChannelName(channel)) return Text(400, "Invalid channel name");

        return Response(200, _json.Serialize(await twitch.FetchChatBadgesAsync(channel)), JsonContentType);
    }

    private async Task<CoreWebView2WebResourceResponse> ChatCheermotesAsync(string channel)
    {
        if (!TwitchClient.IsValidChannelName(channel)) return Text(400, "Invalid channel name");

        return Response(200, _json.Serialize(await twitch.FetchCheermotesAsync(channel)), JsonContentType);
    }

    /// <summary>The logged-in user's own Twitch emotes, by owner — an empty list when logged out.</summary>
    private async Task<CoreWebView2WebResourceResponse> ChatEmotesAsync()
    {
        var token = await session.GetAuthTokenAsync();
        var emoteSets = token is null ? [] : await twitch.FetchOwnEmotesAsync(token);

        return Response(200, _json.Serialize(emoteSets), JsonContentType);
    }

    private async Task<CoreWebView2WebResourceResponse> ChatChannelsAsync(Uri uri)
    {
        var ids = QueryValue(uri, "ids").Split([','], StringSplitOptions.RemoveEmptyEntries).ToList();
        if (ids.Count == 0 || ids.Count > TwitchClient.UserBatchSize || !ids.All(UserIdPattern.IsMatch)) return Text(400, "Invalid user IDs");

        return Response(200, _json.Serialize(await twitch.FetchChannelsByIdAsync(ids)), JsonContentType);
    }

    /// <summary>
    /// { loggedIn: false }, or the login with its token: the chat page sends over Twitch IRC itself.
    /// Only app pages can read it — WebView2 hands requests to the app origin to this handler alone.
    /// </summary>
    private async Task<CoreWebView2WebResourceResponse> ChatIdentityAsync()
    {
        var token = await session.GetAuthTokenAsync();
        var login = token is null ? null : await FetchLoginOrNullAsync(token);
        var identity = login is null ? (object)new { loggedIn = false } : new { loggedIn = true, login, token };

        return Response(200, _json.Serialize(identity), JsonContentType);
    }

    /// <summary>
    /// An expired token means logged out for the chat — reading works without one. Other failures
    /// answer 502, so the chat retries instead of taking a network hiccup for a logout.
    /// </summary>
    private async Task<string?> FetchLoginOrNullAsync(string token)
    {
        try
        {
            return await twitch.FetchLoginAsync(token);
        }
        catch (TwitchUnauthorizedException)
        {
            return null;
        }
    }

    private async Task<CoreWebView2WebResourceResponse> AuthAsync() =>
        Response(200, _json.Serialize(new { loggedIn = await session.IsLoggedInAsync() }), JsonContentType);

    private async Task<CoreWebView2WebResourceResponse> LogoutAsync(CoreWebView2WebResourceRequest request)
    {
        if (request.Method != "POST") return Text(405, "Method not allowed");
        if (!IsFromApp(request)) return Text(403, "Forbidden");

        await session.LogoutAsync();
        follows.Disconnect();

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
