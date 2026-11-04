// 7TV's EventAPI and the cosmetics it delivers. Twitch chat knows nothing about 7TV name paints,
// 7TV badges or personal emotes: 7TV pushes them to everyone watching a channel whenever a chatter
// with 7TV shows up there. One WebSocket carries everything, subscriptions survive reconnects.

const EVENTS_URL = 'wss://events.7tv.io/v3';
const OPCODES = { dispatch: 0, hello: 1, reconnect: 4, subscribe: 35, unsubscribe: 36 };
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const CHANNEL_EVENT_TYPES = ['cosmetic.*', 'entitlement.*', 'emote_set.*'];
const PAINT_IMAGE_PREFIX = 'https://cdn.7tv.app/';
const TWITCH_PLATFORM = 'TWITCH';
const BYTE = 0xff;
const PERCENT = 100;

/** One EventAPI connection: subscribe by type and condition, listen by dispatch type. */
export class SevenTvEvents {
  #listeners = new Map(); // dispatch type → callbacks
  #subscriptions = new Map(); // "type condition" → { type, condition }
  #socket = null;
  #isReady = false;
  #reconnectAttempt = 0;

  on(type, callback) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, []);
    this.#listeners.get(type).push(callback);
  }

  subscribe(type, condition) {
    const key = subscriptionKey(type, condition);
    if (this.#subscriptions.has(key)) return;

    this.#subscriptions.set(key, { type, condition });
    if (this.#isReady) this.#send(OPCODES.subscribe, type, condition);
    else if (!this.#socket) this.#connect();
  }

  unsubscribe(type, condition) {
    if (!this.#subscriptions.delete(subscriptionKey(type, condition))) return;

    if (this.#isReady) this.#send(OPCODES.unsubscribe, type, condition);
  }

  #connect() {
    const socket = new WebSocket(EVENTS_URL);
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#receive(JSON.parse(event.data)));
    socket.addEventListener('close', () => this.#handleClose(socket));
  }

  #receive({ op, d }) {
    switch (op) {
      case OPCODES.hello:
        this.#isReady = true;
        this.#reconnectAttempt = 0;
        for (const { type, condition } of this.#subscriptions.values()) {
          this.#send(OPCODES.subscribe, type, condition);
        }
        break;
      case OPCODES.dispatch:
        for (const callback of this.#listeners.get(d.type) ?? []) callback(d.body);
        break;
      case OPCODES.reconnect:
        this.#socket.close();
        break;
    }
  }

  #send(op, type, condition) {
    this.#socket.send(JSON.stringify({ op, d: { type, condition } }));
  }

  #handleClose(socket) {
    if (socket !== this.#socket) return;

    this.#isReady = false;
    this.#socket = null;
    if (this.#subscriptions.size === 0) return;

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.#reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.#reconnectAttempt += 1;
    setTimeout(() => {
      if (!this.#socket) this.#connect();
    }, delay);
  }
}

function subscriptionKey(type, condition) {
  return `${type} ${JSON.stringify(condition)}`;
}

/**
 * Name paints, badges and personal emote sets of 7TV users, by Twitch user ID.
 * `onChange(twitchId)` fires when a chatter's look changed (null: possibly anyone's, a paint or badge
 * arrived); `onPersonalSet(setId)` when a chatter got an
 * emote set whose emotes may not be known yet.
 */
export function createSevenTvCosmetics(events, { onChange, onPersonalSet }) {
  const paints = new Map(); // paint ID → { name, backgroundImage, filter }
  const badges = new Map(); // badge ID → { title, url, srcset }
  const users = new Map(); // Twitch user ID → { paintId, badgeId, emoteSetIds }

  events.on('cosmetic.create', ({ object }) => {
    // 7TV resends a cosmetic with every chatter wearing it — only new ones matter
    if (!object || paints.has(object.id) || badges.has(object.id)) return;

    if (object.kind === 'PAINT') {
      const paint = toPaint(object.data);
      if (paint) paints.set(object.id, paint);
    } else if (object.kind === 'BADGE') {
      const badge = toBadge(object.data);
      if (badge) badges.set(object.id, badge);
    } else {
      return;
    }
    onChange(null);
  });
  events.on('entitlement.create', ({ object }) => updateEntitlement(object, true));
  events.on('entitlement.delete', ({ object }) => updateEntitlement(object, false));

  function updateEntitlement(entitlement, isGranted) {
    const twitchId = entitlement?.user?.connections?.find(
      (connection) => connection.platform === TWITCH_PLATFORM,
    )?.id;
    if (!twitchId) return;

    if (!users.has(twitchId))
      users.set(twitchId, { paintId: null, badgeId: null, emoteSetIds: new Set() });
    const user = users.get(twitchId);
    const { kind, ref_id: refId } = entitlement;

    if (kind === 'PAINT')
      user.paintId = isGranted ? refId : user.paintId === refId ? null : user.paintId;
    else if (kind === 'BADGE')
      user.badgeId = isGranted ? refId : user.badgeId === refId ? null : user.badgeId;
    else if (kind === 'EMOTE_SET') {
      if (isGranted) {
        user.emoteSetIds.add(refId);
        onPersonalSet(refId);
      } else {
        user.emoteSetIds.delete(refId);
      }
    } else {
      return;
    }
    onChange(twitchId);
  }

  function watchChannel(roomId) {
    for (const type of CHANNEL_EVENT_TYPES) events.subscribe(type, channelCondition(roomId));
  }

  function unwatchChannel(roomId) {
    for (const type of CHANNEL_EVENT_TYPES) events.unsubscribe(type, channelCondition(roomId));
  }

  /** { paint, badge } of a chatter, each null without one. */
  function styleOf(twitchId) {
    const user = users.get(twitchId);

    return {
      paint: (user?.paintId && paints.get(user.paintId)) || null,
      badge: (user?.badgeId && badges.get(user.badgeId)) || null,
    };
  }

  function personalSetIds(twitchId) {
    return users.get(twitchId)?.emoteSetIds ?? null;
  }

  return { watchChannel, unwatchChannel, styleOf, personalSetIds };
}

function channelCondition(roomId) {
  return { ctx: 'channel', platform: TWITCH_PLATFORM, id: roomId };
}

/** A paint as CSS: a gradient or image clipped to the name's text, shadows as drop-shadow filters. */
function toPaint(data) {
  const stops = (data.stops ?? [])
    .map((stop) => `${toRgba(stop.color)} ${stop.at * PERCENT}%`)
    .join(', ');
  const repeat = data.repeat ? 'repeating-' : '';
  let backgroundImage = null;

  if (data.function === 'LINEAR_GRADIENT' && stops) {
    backgroundImage = `${repeat}linear-gradient(${data.angle}deg, ${stops})`;
  } else if (data.function === 'RADIAL_GRADIENT' && stops) {
    backgroundImage = `${repeat}radial-gradient(${data.shape === 'ellipse' ? 'ellipse' : 'circle'}, ${stops})`;
  } else if (data.function === 'URL' && data.image_url?.startsWith(PAINT_IMAGE_PREFIX)) {
    backgroundImage = `url("${encodeURI(data.image_url)}")`;
  }
  if (!backgroundImage) return null;

  const filter = (data.shadows ?? [])
    .map(
      (shadow) =>
        `drop-shadow(${shadow.x_offset}px ${shadow.y_offset}px ${shadow.radius}px ${toRgba(shadow.color)})`,
    )
    .join(' ');

  return { name: data.name, backgroundImage, filter };
}

function toBadge(data) {
  const files = (data.host?.files ?? []).filter((file) => file.format === 'WEBP');
  if (files.length === 0) return null;

  const base = `https:${data.host.url}`;
  return {
    title: data.tooltip || data.name,
    url: `${base}/${files[0].name}`,
    srcset: files
      .slice(0, 3)
      .map((file) => `${base}/${file.name} ${file.name.split('.')[0]}`)
      .join(', '),
  };
}

/** 7TV packs colors as one signed 32-bit RGBA integer. */
function toRgba(color) {
  const value = color >>> 0;
  const alpha = (value & BYTE) / BYTE;

  return `rgba(${value >>> 24}, ${(value >>> 16) & BYTE}, ${(value >>> 8) & BYTE}, ${alpha.toFixed(3)})`;
}
