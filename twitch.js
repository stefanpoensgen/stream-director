// ═══════════════════════════════════════════════════════════════════
// Twitch API client (main process)
// Unofficial GQL + usher endpoints, the same ones streamlink uses.
// ═══════════════════════════════════════════════════════════════════

const GQL_URL = 'https://gql.twitch.tv/gql';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const USHER_URL = 'https://usher.ttvnw.net/api/channel/hls';
const LIVE_CHECK_BATCH_SIZE = 35;
const CHANNEL_NAME_PATTERN = /^[a-z0-9_]{1,25}$/;
const OFFLINE_STATUS_CODES = new Set([403, 404]);

const PLAYBACK_TOKEN_QUERY = `query PlaybackAccessToken($login: String!) {
  streamPlaybackAccessToken(
    channelName: $login
    params: { platform: "web", playerBackend: "mediaplayer", playerType: "embed" }
  ) { value signature }
}`;

export function isValidChannelName(name) {
  return CHANNEL_NAME_PATTERN.test(name);
}

async function gql(body, authToken = null) {
  const headers = { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `OAuth ${authToken}`;

  const response = await fetch(GQL_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Twitch GQL responded ${response.status}`);

  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(`Twitch GQL error: ${errors[0].message}`);

  return data;
}

/** Returns the subset of `names` that is currently streaming. */
export async function fetchLiveChannels(names) {
  const liveNames = [];

  for (let start = 0; start < names.length; start += LIVE_CHECK_BATCH_SIZE) {
    const batch = names.slice(start, start + LIVE_CHECK_BATCH_SIZE);
    const aliases = batch.map(
      (name, index) => `u${index}: user(login: "${name}") { stream { id } }`,
    );
    const data = await gql({ query: `query { ${aliases.join(' ')} }` });

    liveNames.push(...batch.filter((_name, index) => data[`u${index}`]?.stream));
  }

  return liveNames;
}

async function fetchPlaybackToken(channel, authToken) {
  const body = { query: PLAYBACK_TOKEN_QUERY, variables: { login: channel } };

  try {
    return (await gql(body, authToken)).streamPlaybackAccessToken;
  } catch (error) {
    if (!authToken) throw error;

    // An expired login must not break playback — fall back to anonymous (with ads)
    console.warn(`Authenticated playback token failed, retrying anonymously: ${error.message}`);

    return (await gql(body)).streamPlaybackAccessToken;
  }
}

/**
 * Fetches the HLS master playlist of a channel, or null when it is offline.
 * With the auth token of a Twitch Turbo account the stream comes without ads.
 */
export async function fetchMasterPlaylist(channel, authToken) {
  const token = await fetchPlaybackToken(channel, authToken);
  if (!token) return null;

  const query = new URLSearchParams({
    sig: token.signature,
    token: token.value,
    allow_source: 'true',
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    supported_codecs: 'avc1',
    p: String(Math.floor(Math.random() * 1_000_000)),
  });

  const response = await fetch(`${USHER_URL}/${channel}.m3u8?${query}`);
  if (OFFLINE_STATUS_CODES.has(response.status)) return null;
  if (!response.ok) throw new Error(`Twitch usher responded ${response.status}`);

  return response.text();
}
