// Optional second Twitch connection for the followed channels. The website login (TwitchSession) lacks the
// user:read:follows scope and Twitch blocks follows on its internal API for other clients, so StreamDirector
// asks for that scope via its own Twitch app (device code flow) and uses the official API (Helix).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace StreamDirector;

internal sealed class FollowsConnection
{
    private const string ClientId = "22km0oo61jehbuva3k4y3u9ih6v5u3"; // public client — not a secret
    private const string Scope = "user:read:follows";
    private const string DeviceUrl = "https://id.twitch.tv/oauth2/device";
    private const string TokenUrl = "https://id.twitch.tv/oauth2/token";
    private const string ValidateUrl = "https://id.twitch.tv/oauth2/validate";
    private const string FollowedStreamsUrl = "https://api.twitch.tv/helix/streams/followed";
    private const string FollowedChannelsUrl = "https://api.twitch.tv/helix/channels/followed";
    private const int PageSize = 100;
    private const int MaxFollowedPages = 20; // 2000 follows — a guard against endless paging
    private const string DeviceGrantType = "urn:ietf:params:oauth:grant-type:device_code";
    private const string AuthorizationPending = "authorization_pending";
    private const string SlowDown = "slow_down";
    private static readonly TimeSpan ExpiryMargin = TimeSpan.FromMinutes(1);

    // Who you follow rarely changes; the live state is fetched every time
    private static readonly TimeSpan FollowedChannelsMaxAge = TimeSpan.FromMinutes(10);

    private static readonly string StorePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StreamDirector", "follows.dat");

    private readonly HttpClient _http = new();
    private readonly JavaScriptSerializer _json = new();
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private Tokens? _tokens = LoadTokens();
    private List<string>? _followedLogins;
    private DateTime _followedLoginsFetchedAt;
    private CancellationTokenSource? _pendingConnect;

    public bool IsConnected => _tokens is not null;

    /// <summary>Starts the device code flow; the user confirms on the returned page while this polls in the background.</summary>
    public async Task<(string UserCode, string VerificationUri)> StartConnectAsync()
    {
        var (status, device) = await PostFormAsync(DeviceUrl, new() { ["client_id"] = ClientId, ["scopes"] = Scope });
        if (status != HttpStatusCode.OK) throw new HttpRequestException($"Twitch device login responded {(int)status}");

        _pendingConnect?.Cancel();
        var pending = new CancellationTokenSource(TimeSpan.FromSeconds((int)device["expires_in"]));
        _pendingConnect = pending;
        _ = PollForTokensAsync((string)device["device_code"], (int)device["interval"], pending.Token);

        return ((string)device["user_code"], (string)device["verification_uri"]);
    }

    public void Disconnect()
    {
        _pendingConnect?.Cancel();
        _tokens = null;
        _followedLogins = null;
        if (File.Exists(StorePath)) File.Delete(StorePath);
    }

    /// <summary>All followed channels: login, live and — when live — displayName, title, game (the category) and viewers.</summary>
    public async Task<List<object>> FetchFollowedAsync()
    {
        var live = (await GetPagesAsync(FollowedStreamsUrl, maxPages: 1))
            .ToDictionary(stream => (string)stream["user_login"]);

        if (_followedLogins is null || DateTime.UtcNow - _followedLoginsFetchedAt > FollowedChannelsMaxAge)
        {
            _followedLogins = (await GetPagesAsync(FollowedChannelsUrl, MaxFollowedPages))
                .Select(channel => (string)channel["broadcaster_login"])
                .ToList();
            _followedLoginsFetchedAt = DateTime.UtcNow;
        }

        // A channel followed after the last list refresh can already be live — include it anyway
        return _followedLogins
            .Union(live.Keys)
            .Select(login => live.TryGetValue(login, out var stream)
                ? (object)new
                {
                    login,
                    live = true,
                    displayName = stream["user_name"] as string,
                    title = stream["title"] as string,
                    game = stream["game_name"] as string,
                    viewers = stream["viewer_count"] as int? ?? 0,
                }
                : new { login, live = false })
            .ToList();
    }

    /// <summary>Helix list endpoint for the connected user, following the pagination cursor.</summary>
    private async Task<List<IDictionary>> GetPagesAsync(string url, int maxPages)
    {
        var items = new List<IDictionary>();
        string? cursor = null;

        for (var page = 0; page < maxPages; page++)
        {
            var response = await GetHelixAsync(url, cursor, await GetFreshTokensAsync(forceRefresh: false));

            // An access token can be revoked before it expires — refresh once and retry
            if (response.Status == HttpStatusCode.Unauthorized)
            {
                response = await GetHelixAsync(url, cursor, await GetFreshTokensAsync(forceRefresh: true));
            }

            if (response.Status != HttpStatusCode.OK) throw new HttpRequestException($"Twitch API responded {(int)response.Status}");

            items.AddRange((response.Body["data"] as ICollection ?? Array.Empty<object>()).Cast<IDictionary>());
            cursor = (response.Body["pagination"] as IDictionary)?["cursor"] as string;
            if (string.IsNullOrEmpty(cursor)) break;
        }

        return items;
    }

    private async Task<(HttpStatusCode Status, IDictionary Body)> GetHelixAsync(string url, string? cursor, Tokens tokens)
    {
        var after = cursor is null ? string.Empty : $"&after={Uri.EscapeDataString(cursor)}";
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{url}?user_id={tokens.UserId}&first={PageSize}{after}");
        request.Headers.Add("Client-Id", ClientId);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {tokens.AccessToken}");

        return await SendAsync(request);
    }

    private async Task PollForTokensAsync(string deviceCode, int intervalSeconds, CancellationToken cancellation)
    {
        try
        {
            while (true)
            {
                await Task.Delay(TimeSpan.FromSeconds(intervalSeconds), cancellation);

                var (status, body) = await PostFormAsync(TokenUrl, new()
                {
                    ["client_id"] = ClientId,
                    ["scopes"] = Scope,
                    ["device_code"] = deviceCode,
                    ["grant_type"] = DeviceGrantType,
                });

                if (status == HttpStatusCode.OK)
                {
                    await StoreAsync(body);
                    return;
                }

                // Anything else than "not confirmed yet" ends the attempt (denied, expired)
                var message = body.Contains("message") ? body["message"] as string : null;
                if (message != AuthorizationPending && message != SlowDown) return;
            }
        }
        catch (TaskCanceledException)
        {
            // Expired or replaced by a new attempt
        }
        catch (Exception error)
        {
            Trace.WriteLine($"Connecting the follows failed: {error.Message}");
        }
    }

    private async Task<Tokens> GetFreshTokensAsync(bool forceRefresh)
    {
        await _refreshLock.WaitAsync();
        try
        {
            var tokens = _tokens ?? throw new InvalidOperationException("Followed channels are not connected");
            if (!forceRefresh && tokens.ExpiresAt - ExpiryMargin > DateTime.UtcNow) return tokens;

            var (status, body) = await PostFormAsync(TokenUrl, new()
            {
                ["client_id"] = ClientId,
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = tokens.RefreshToken,
            });

            if (status != HttpStatusCode.OK)
            {
                // Refresh tokens expire after 30 days without use or when access is revoked on Twitch
                Disconnect();
                throw new HttpRequestException("Twitch connection expired — connect again");
            }

            return await StoreAsync(body, tokens.UserId);
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    /// <summary>Keeps the new tokens in memory and DPAPI-encrypted on disk (readable only by this Windows user).</summary>
    private async Task<Tokens> StoreAsync(IDictionary tokenResponse, string? knownUserId = null)
    {
        var accessToken = (string)tokenResponse["access_token"];
        var tokens = new Tokens
        {
            AccessToken = accessToken,
            RefreshToken = (string)tokenResponse["refresh_token"],
            ExpiresAt = DateTime.UtcNow.AddSeconds((int)tokenResponse["expires_in"]),
            UserId = knownUserId ?? await FetchUserIdAsync(accessToken),
        };

        var plain = Encoding.UTF8.GetBytes(_json.Serialize(tokens));
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        File.WriteAllBytes(StorePath, ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser));
        _tokens = tokens;

        return tokens;
    }

    private async Task<string> FetchUserIdAsync(string accessToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, ValidateUrl);
        request.Headers.TryAddWithoutValidation("Authorization", $"OAuth {accessToken}");
        var (status, body) = await SendAsync(request);
        if (status != HttpStatusCode.OK) throw new HttpRequestException($"Twitch token check responded {(int)status}");

        return (string)body["user_id"];
    }

    private static Tokens? LoadTokens()
    {
        try
        {
            if (!File.Exists(StorePath)) return null;

            var plain = ProtectedData.Unprotect(File.ReadAllBytes(StorePath), null, DataProtectionScope.CurrentUser);

            return new JavaScriptSerializer().Deserialize<Tokens>(Encoding.UTF8.GetString(plain));
        }
        catch (Exception error)
        {
            Trace.WriteLine($"Stored follows connection unreadable, ignoring it: {error.Message}");
            return null;
        }
    }

    private async Task<(HttpStatusCode Status, IDictionary Body)> PostFormAsync(string url, Dictionary<string, string> form)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = new FormUrlEncodedContent(form) };

        return await SendAsync(request);
    }

    private async Task<(HttpStatusCode Status, IDictionary Body)> SendAsync(HttpRequestMessage request)
    {
        using var response = await _http.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        var body = string.IsNullOrWhiteSpace(text) ? new Dictionary<string, object>() : _json.Deserialize<Dictionary<string, object>>(text);

        return (response.StatusCode, body);
    }

    private sealed class Tokens
    {
        public string AccessToken { get; set; } = string.Empty;
        public string RefreshToken { get; set; } = string.Empty;
        public DateTime ExpiresAt { get; set; }
        public string UserId { get; set; } = string.Empty;
    }
}
