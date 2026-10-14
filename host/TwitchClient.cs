// Twitch API client — unofficial GQL + usher endpoints, the same ones streamlink uses.

using System;
using System.Collections;
using System.Collections.Generic;
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
    private const int LiveCheckBatchSize = 35;

    private const string PlaybackTokenQuery = """
        query PlaybackAccessToken($login: String!) {
          streamPlaybackAccessToken(
            channelName: $login
            params: { platform: "web", playerBackend: "mediaplayer", playerType: "embed" }
          ) { value signature }
        }
        """;

    private static readonly Regex ChannelNamePattern = new("^[a-z0-9_]{1,25}$");

    private readonly HttpClient _http = new();
    private readonly JavaScriptSerializer _json = new();
    private readonly Random _random = new();

    public static bool IsValidChannelName(string name) => ChannelNamePattern.IsMatch(name);

    /// <summary>Returns the subset of <paramref name="names"/> that is currently streaming.</summary>
    public async Task<List<string>> FetchLiveChannelsAsync(IReadOnlyList<string> names)
    {
        var liveNames = new List<string>();

        for (var start = 0; start < names.Count; start += LiveCheckBatchSize)
        {
            var batch = names.Skip(start).Take(LiveCheckBatchSize).ToList();
            var aliases = batch.Select((name, index) => $"u{index}: user(login: \"{name}\") {{ stream {{ id }} }}");
            var data = await GqlAsync(new { query = $"query {{ {string.Join(" ", aliases)} }}" });

            liveNames.AddRange(batch.Where((_, index) => data[$"u{index}"] is IDictionary user && user["stream"] is not null));
        }

        return liveNames;
    }

    /// <summary>
    /// Channels the logged-in user follows that are live right now, or null when the token is not
    /// accepted (expired login).
    /// </summary>
    public async Task<List<object>?> FetchFollowedLiveAsync(string authToken)
    {
        const string query =
            "query { currentUser { followedLiveUsers(first: 100) { edges { node { login stream { viewersCount game { displayName } } } } } } }";
        var data = await GqlAsync(new { query }, authToken);
        if (data["currentUser"] is not IDictionary user) return null;

        var edges = (user["followedLiveUsers"] as IDictionary)?["edges"] as ICollection ?? Array.Empty<object>();

        return edges
            .Cast<IDictionary>()
            .Select(edge => (IDictionary)edge["node"])
            .Select(node => (object)new
            {
                login = (string)node["login"],
                game = ((node["stream"] as IDictionary)?["game"] as IDictionary)?["displayName"] as string,
                viewers = (node["stream"] as IDictionary)?["viewersCount"] as int? ?? 0,
            })
            .ToList();
    }

    /// <summary>
    /// Fetches the HLS master playlist of a channel.
    /// With the auth token of a Twitch Turbo account the stream comes without ads.
    /// </summary>
    public async Task<(PlaylistStatus Status, string? Playlist)> FetchMasterPlaylistAsync(string channel, string? authToken)
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
            throw new HttpRequestException($"Twitch GQL error: {firstError?["message"]}");
        }

        return (IDictionary)result["data"];
    }
}
