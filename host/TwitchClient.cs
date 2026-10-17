// Twitch API client — unofficial GQL + usher endpoints, the same ones streamlink uses.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace StreamDirector;

internal enum PlaylistStatus
{
    Available,
    Offline,
    Forbidden, // live, but not playable (subscriber-only, geo-blocked)
}

internal sealed class TwitchClient
{
    private const string GqlUrl = "https://gql.twitch.tv/gql";
    private const string ClientId = "kimne78kx3ncx6brgo4mv6wki5h1ko";
    private const string UsherUrl = "https://usher.ttvnw.net/api/channel/hls";
    private const int LiveCheckBatchSize = 100; // users(logins:) takes at most 100 logins
    private const int AvatarWidth = 70; // profileImageURL only accepts Twitch's fixed sizes (28, 50, 70, 150, 300, 600)

    private const string PlaybackTokenQuery = """
        query PlaybackAccessToken($login: String!) {
          streamPlaybackAccessToken(
            channelName: $login
            params: { platform: "web", playerBackend: "mediaplayer", playerType: "embed" }
          ) { value signature }
        }
        """;

    private const string LiveStreamFields =
        "id login displayName broadcastSettings { title } stream { viewersCount game { displayName } }";

    private const string LiveWithFields =
        "id session { guests { user { id displayName stream { viewersCount } } } }";

    private static readonly Regex ChannelNamePattern = new("^[a-z0-9_]{1,25}$");

    private readonly HttpClient _http = new();
    private readonly JavaScriptSerializer _json = new();
    private readonly Random _random = new();

    // Channel name → its profile image; avatars hardly ever change, so once per session is enough
    private readonly Dictionary<string, (byte[] Content, string ContentType)> _avatars = new();

    public static bool IsValidChannelName(string name) => ChannelNamePattern.IsMatch(name);

    /// <summary>
    /// The channels of <paramref name="names"/> that are currently streaming, with what they stream:
    /// login, displayName, title, game (the category), viewers and liveWith (see <see cref="FetchLiveWithAsync"/>).
    /// </summary>
    public async Task<List<object>> FetchLiveStreamsAsync(IReadOnlyList<string> names)
    {
        var liveUsers = new List<(IDictionary User, IDictionary Stream)>();

        // One list query per batch — Twitch rejects queries with more than 15 aliased root fields
        for (var start = 0; start < names.Count; start += LiveCheckBatchSize)
        {
            var logins = string.Join(", ", names.Skip(start).Take(LiveCheckBatchSize).Select(name => $"\"{name}\""));
            var data = await GqlAsync(new { query = $"query {{ users(logins: [{logins}]) {{ {LiveStreamFields} }} }}" });

            // Unknown or banned logins come back as null
            foreach (var user in (data["users"] as ICollection ?? Array.Empty<object>()).OfType<IDictionary>())
            {
                if (user["stream"] is IDictionary stream) liveUsers.Add((user, stream));
            }
        }

        var liveWith = await FetchLiveWithAsync(liveUsers.Select(live => (string)live.User["id"]).ToList());

        return liveUsers
            .Select(live => (object)new
            {
                login = (string)live.User["login"],
                displayName = live.User["displayName"] as string,
                title = (live.User["broadcastSettings"] as IDictionary)?["title"] as string,
                game = (live.Stream["game"] as IDictionary)?["displayName"] as string,
                viewers = live.Stream["viewersCount"] as int? ?? 0,
                liveWith = liveWith.TryGetValue((string)live.User["id"], out var partners) ? partners : null,
            })
            .ToList();
    }

    /// <summary>
    /// Twitch "Stream Together" sessions of the given channels (by user ID): channel ID → the other
    /// participants (displayName, viewers when they stream themselves), most viewers first.
    /// Optional extra — on failure the channels are reported without partners.
    /// </summary>
    public async Task<Dictionary<string, List<object>>> FetchLiveWithAsync(IReadOnlyList<string> channelIds)
    {
        var liveWith = new Dictionary<string, List<object>>();
        if (channelIds.Count == 0) return liveWith;

        try
        {
            var ids = string.Join(", ", channelIds.Select(id => $"\"{id}\""));
            var data = await GqlAsync(new { query = $"query {{ guestStarChannelCollaboration(options: {{ channelIDs: [{ids}] }}) {{ {LiveWithFields} }} }}" });

            foreach (var collaboration in (data["guestStarChannelCollaboration"] as ICollection ?? Array.Empty<object>()).Cast<IDictionary>())
            {
                if ((collaboration["session"] as IDictionary)?["guests"] is not ICollection guests) continue;

                var channelId = (string)collaboration["id"];
                var partners = guests.Cast<IDictionary>()
                    .Select(guest => guest["user"] as IDictionary)
                    .Where(user => user is not null && (string)user["id"] != channelId)
                    .Select(user => new
                    {
                        displayName = (string)user!["displayName"],
                        viewers = (user["stream"] as IDictionary)?["viewersCount"] as int?,
                    })
                    .OrderByDescending(partner => partner.viewers ?? -1)
                    .ToList<object>();

                if (partners.Count > 0) liveWith[channelId] = partners;
            }
        }
        catch (HttpRequestException error)
        {
            Trace.WriteLine($"Loading Stream Together sessions failed: {error.Message}");
        }

        return liveWith;
    }

    /// <summary>The profile image of a channel, or null for unknown channels.</summary>
    public async Task<(byte[] Content, string ContentType)?> FetchAvatarAsync(string channel)
    {
        if (_avatars.TryGetValue(channel, out var cached)) return cached;

        var data = await GqlAsync(new
        {
            query = $"query {{ user(login: \"{channel}\") {{ profileImageURL(width: {AvatarWidth}) }} }}",
        });
        if ((data["user"] as IDictionary)?["profileImageURL"] is not string imageUrl) return null;

        using var response = await _http.GetAsync(imageUrl);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Twitch CDN responded {(int)response.StatusCode}");

        var avatar = (await response.Content.ReadAsByteArrayAsync(), response.Content.Headers.ContentType.MediaType);
        _avatars[channel] = avatar;

        return avatar;
    }

    /// <summary>
    /// Fetches the HLS master playlist of a channel.
    /// With the auth token of a Twitch Turbo account the stream comes without ads.
    /// </summary>
    public async Task<(PlaylistStatus Status, string? Playlist)> FetchMasterPlaylistAsync(
        string channel, string? authToken)
    {
        var token = await FetchPlaybackTokenAsync(channel, authToken);
        if (token is null) return (PlaylistStatus.Offline, null);

        var query = new Dictionary<string, string>
        {
            ["sig"] = (string)token["signature"],
            ["token"] = (string)token["value"],
            ["allow_source"] = "true",
            ["player_backend"] = "mediaplayer",
            ["playlist_include_framerate"] = "true",
            // HEVC/AV1 allowed: Twitch serves above-1080p (Enhanced Broadcasting) only in these codecs.
            // hls.js drops renditions this PC cannot decode, so H.264 remains the fallback.
            ["supported_codecs"] = "av1,h265,h264",
            ["p"] = _random.Next(1_000_000).ToString(),
        };
        var queryString = string.Join("&", query.Select(pair => $"{pair.Key}={Uri.EscapeDataString(pair.Value)}"));

        using var response = await _http.GetAsync($"{UsherUrl}/{channel}.m3u8?{queryString}");
        if (response.StatusCode == HttpStatusCode.NotFound) return (PlaylistStatus.Offline, null);
        if (response.StatusCode == HttpStatusCode.Forbidden) return (PlaylistStatus.Forbidden, null);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Twitch usher responded {(int)response.StatusCode}");

        return (PlaylistStatus.Available, await response.Content.ReadAsStringAsync());
    }

    private async Task<IDictionary?> FetchPlaybackTokenAsync(string channel, string? authToken)
    {
        var body = new { query = PlaybackTokenQuery, variables = new { login = channel } };

        try
        {
            return (await GqlAsync(body, authToken))["streamPlaybackAccessToken"] as IDictionary;
        }
        catch (HttpRequestException) when (authToken is not null)
        {
            // An expired login must not break playback — fall back to anonymous (with ads)
            return (await GqlAsync(body))["streamPlaybackAccessToken"] as IDictionary;
        }
    }

    private async Task<IDictionary> GqlAsync(object body, string? authToken = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, GqlUrl)
        {
            Content = new StringContent(_json.Serialize(body), Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("Client-ID", ClientId);
        if (authToken is not null) request.Headers.TryAddWithoutValidation("Authorization", $"OAuth {authToken}");

        using var response = await _http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Twitch GQL responded {(int)response.StatusCode}");

        var result = _json.Deserialize<Dictionary<string, object>>(await response.Content.ReadAsStringAsync());
        if (result.TryGetValue("errors", out var errors) && errors is ICollection { Count: > 0 } errorList)
        {
            var firstError = errorList.Cast<object>().First() as IDictionary;
            var path = firstError?["path"] is ICollection segments ? string.Join(".", segments.Cast<object>()) : null;
            throw new HttpRequestException($"Twitch GQL error: {firstError?["message"]}{(path is null ? "" : $" at {path}")}");
        }

        return (IDictionary)result["data"];
    }
}
