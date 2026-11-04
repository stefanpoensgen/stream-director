// Third-party chat emotes — 7TV, BetterTTV and FrankerFaceZ (through BetterTTV's cache), global, per
// channel and 7TV personal sets. Changes to 7TV sets arrive live over 7TV's EventAPI (chat-seventv.js).

const SEVENTV_API = 'https://7tv.io/v3';
const BTTV_API = 'https://api.betterttv.net/3/cached';
const BTTV_CDN = 'https://cdn.betterttv.net/emote';
const TWITCH_EMOTE_CDN = 'https://static-cdn.jtvnw.net/emoticons/v2';

const SEVENTV_ZERO_WIDTH_FLAG = 1; // flag of an emote inside an emote set
const SEVENTV_IMAGE_FORMAT = 'WEBP';
const SEVENTV_SET_UPDATE = 'emote_set.update';
const SEVENTV_SET_CREATE = 'emote_set.create';

// BetterTTV's API does not mark its overlay emotes; these globals are the known ones
const BTTV_ZERO_WIDTH_CODES = new Set([
  'SoSnowy',
  'IceCold',
  'SantaHat',
  'TopHat',
  'ReinDeer',
  'CandyCane',
  'cvMask',
  'cvHazmat',
]);

// Modifier emotes change a neighbouring emote instead of showing an image: BetterTTV's precede
// the emote ("w! KEKW"), FrankerFaceZ's follow it ("KEKW ffzW"). Unknown modifiers stay hidden.
const BTTV_EFFECTS = {
  'w!': 'wide',
  'h!': 'flip-horizontal',
  'v!': 'flip-vertical',
  'l!': 'rotate-left',
  'r!': 'rotate-right',
  'c!': 'cursed',
  'p!': 'party',
  's!': 'shake',
};
const FFZ_EFFECTS = {
  ffzW: 'wide',
  ffzX: 'flip-horizontal',
  ffzY: 'flip-vertical',
  ffzCursed: 'cursed',
};

export const PROVIDERS = {
  twitch: 'Twitch',
  sevenTv: '7TV',
  bttv: 'BetterTTV',
  ffz: 'FrankerFaceZ',
};

/** A Twitch emote by ID — "default" serves the animated version when there is one. */
export function twitchEmote(id, name) {
  const url = (scale) => `${TWITCH_EMOTE_CDN}/${id}/default/dark/${scale}`;

  return {
    name,
    provider: PROVIDERS.twitch,
    scope: null,
    url: url('1.0'),
    srcset: `${url('1.0')} 1x, ${url('2.0')} 2x, ${url('3.0')} 4x`,
    largeUrl: url('3.0'),
  };
}

/**
 * All third-party emotes the chat knows: global ones, one set per channel (by Twitch room ID) and
 * 7TV personal sets. `onChannelChange(roomId, change)` reports live 7TV edits of a channel's set:
 * { added, removed, renamed, actor }.
 */
export function createEmoteRegistry(sevenTvEvents, { onChannelChange }) {
  const globalEmotes = new Map();
  const channelEmotes = new Map(); // room ID → Map name → emote
  const sevenTvSetRooms = new Map(); // 7TV emote set ID → room ID
  const personalSets = new Map(); // 7TV personal emote set ID → Map name → emote
  const requestedPersonalSets = new Set();

  // A set update may arrive twice (by set ID and by channel) — applying it is idempotent
  sevenTvEvents.on(SEVENTV_SET_UPDATE, (body) => {
    const roomId = sevenTvSetRooms.get(body.id);
    if (roomId && channelEmotes.has(roomId)) {
      const change = applySevenTvUpdate(channelEmotes.get(roomId), body, 'channel');
      if (change.added.length + change.removed.length + change.renamed.length > 0) {
        onChannelChange(roomId, change);
      }
      return;
    }

    if (personalSets.has(body.id)) applySevenTvUpdate(personalSets.get(body.id), body, 'personal');
  });
  sevenTvEvents.on(SEVENTV_SET_CREATE, ({ object }) => {
    if (object?.id && !personalSets.has(object.id))
      personalSets.set(object.id, toSevenTvSet(object));
  });

  async function loadGlobal() {
    const [sevenTv, bttv, ffz] = await Promise.all([
      fetchJson(`${SEVENTV_API}/emote-sets/global`),
      fetchJson(`${BTTV_API}/emotes/global`),
      fetchJson(`${BTTV_API}/frankerfacez/emotes/global`),
    ]);

    // Lowest priority first: a later provider's emote replaces an earlier one with the same name
    addAll(
      globalEmotes,
      (ffz ?? []).map((emote) => fromFfz(emote, 'global')),
    );
    addAll(
      globalEmotes,
      (bttv ?? []).map((emote) => fromBttv(emote, 'global')),
    );
    addAll(
      globalEmotes,
      (sevenTv?.emotes ?? []).map((emote) => fromSevenTv(emote, 'global')),
    );
  }

  async function loadChannel(roomId) {
    const [sevenTv, bttv, ffz] = await Promise.all([
      fetchJson(`${SEVENTV_API}/users/twitch/${roomId}`),
      fetchJson(`${BTTV_API}/users/twitch/${roomId}`),
      fetchJson(`${BTTV_API}/frankerfacez/users/twitch/${roomId}`),
    ]);

    const emotes = new Map();
    addAll(
      emotes,
      (ffz ?? []).map((emote) => fromFfz(emote, 'channel')),
    );
    addAll(
      emotes,
      [...(bttv?.channelEmotes ?? []), ...(bttv?.sharedEmotes ?? [])].map((emote) =>
        fromBttv(emote, 'channel'),
      ),
    );
    addAll(
      emotes,
      (sevenTv?.emote_set?.emotes ?? []).map((emote) => fromSevenTv(emote, 'channel')),
    );
    channelEmotes.set(roomId, emotes);

    const setId = sevenTv?.emote_set?.id;
    if (setId) {
      sevenTvSetRooms.set(setId, roomId);
      sevenTvEvents.subscribe(SEVENTV_SET_UPDATE, { object_id: setId });
    }
  }

  function hasChannel(roomId) {
    return channelEmotes.has(roomId);
  }

  function forgetChannel(roomId) {
    channelEmotes.delete(roomId);
    for (const [setId, setRoomId] of [...sevenTvSetRooms]) {
      if (setRoomId !== roomId) continue;

      sevenTvSetRooms.delete(setId);
      sevenTvEvents.unsubscribe(SEVENTV_SET_UPDATE, { object_id: setId });
    }
  }

  /** A personal set a chatter was given — fetched unless 7TV already sent it with its creation. */
  async function ensurePersonalSet(setId) {
    if (personalSets.has(setId) || requestedPersonalSets.has(setId)) return;

    requestedPersonalSets.add(setId);
    const set = await fetchJson(`${SEVENTV_API}/emote-sets/${setId}`);
    if (set && !personalSets.has(setId)) personalSets.set(setId, toSevenTvSet(set));
  }

  /**
   * The emote named exactly `name` in a channel: channel emotes first, then the sender's
   * personal 7TV emotes (`personalSetIds`), then global ones.
   */
  function find(roomId, name, personalSetIds) {
    const channelEmote = channelEmotes.get(roomId)?.get(name);
    if (channelEmote) return channelEmote;

    for (const setId of personalSetIds ?? []) {
      const personalEmote = personalSets.get(setId)?.get(name);
      if (personalEmote) return personalEmote;
    }

    return globalEmotes.get(name);
  }

  /** The emotes one can send in a channel (modifiers left out): { channel, global }, by name. */
  function usable(roomId) {
    const byName = (emotes) =>
      [...emotes.values()]
        .filter((emote) => !emote.modifier)
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
      channel: byName(channelEmotes.get(roomId) ?? new Map()),
      global: byName(globalEmotes),
    };
  }

  return { loadGlobal, loadChannel, hasChannel, forgetChannel, ensurePersonalSet, find, usable };
}

function toSevenTvSet(set) {
  const emotes = new Map();
  addAll(
    emotes,
    (set.emotes ?? []).map((emote) => fromSevenTv(emote, 'personal')),
  );
  return emotes;
}

function addAll(target, emotes) {
  for (const emote of emotes) {
    if (emote) target.set(emote.name, emote);
  }
}

/** JSON of a third-party API, or null — a missing provider must not break the chat. */
async function fetchJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    return await response.json();
  } catch (error) {
    console.warn(`Loading ${url} failed:`, error);
    return null;
  }
}

function fromSevenTv(activeEmote, scope) {
  const host = activeEmote.data?.host;
  const files = host?.files.filter((file) => file.format === SEVENTV_IMAGE_FORMAT) ?? [];
  if (files.length === 0) return null;

  const base = `https:${host.url}`;
  // File names are their scale: 1x.webp … 4x.webp
  const srcset = files.slice(0, 3).map((file) => `${base}/${file.name} ${file.name.split('.')[0]}`);

  return {
    name: activeEmote.name,
    id: activeEmote.id,
    provider: PROVIDERS.sevenTv,
    scope,
    url: `${base}/${files[0].name}`,
    srcset: srcset.join(', '),
    largeUrl: `${base}/${files.at(-1).name}`,
    width: files[0].width,
    height: files[0].height,
    zeroWidth: (activeEmote.flags & SEVENTV_ZERO_WIDTH_FLAG) !== 0,
  };
}

function fromBttv(emote, scope) {
  const url = (scale) => `${BTTV_CDN}/${emote.id}/${scale}.webp`;

  return {
    name: emote.code,
    provider: PROVIDERS.bttv,
    scope,
    url: url('1x'),
    srcset: `${url('1x')} 1x, ${url('2x')} 2x, ${url('3x')} 3x`,
    largeUrl: url('3x'),
    zeroWidth: BTTV_ZERO_WIDTH_CODES.has(emote.code),
    modifier: emote.modifier
      ? { effect: BTTV_EFFECTS[emote.code] ?? null, appliesTo: 'next' }
      : null,
  };
}

function fromFfz(emote, scope) {
  const images = Object.entries(emote.images).filter(([, url]) => url);
  const effect = FFZ_EFFECTS[emote.code];

  return {
    name: emote.code,
    provider: PROVIDERS.ffz,
    scope,
    url: emote.images['1x'],
    srcset: images.map(([scale, url]) => `${url} ${scale}`).join(', '),
    largeUrl: images.at(-1)[1],
    // FrankerFaceZ modifiers without a known effect are overlays (hats, masks …)
    zeroWidth: emote.modifier && !effect,
    modifier: effect ? { effect, appliesTo: 'previous' } : null,
  };
}

/** Applies a 7TV emote_set.update to a set and describes what actually changed. */
function applySevenTvUpdate(emotes, body, scope) {
  const change = { added: [], removed: [], renamed: [], actor: body.actor?.display_name ?? null };

  for (const { key, old_value: previous } of body.pulled ?? []) {
    if (key === 'emotes' && previous && deleteSevenTvEmote(emotes, previous.id)) {
      change.removed.push(previous.name);
    }
  }

  for (const { key, value } of body.pushed ?? []) {
    const emote = key === 'emotes' && value ? fromSevenTv(value, scope) : null;
    if (!emote || emotes.get(emote.name)?.id === emote.id) continue;

    emotes.set(emote.name, emote);
    change.added.push(emote.name);
  }

  for (const { key, old_value: previous, value } of body.updated ?? []) {
    const emote = key === 'emotes' && value ? fromSevenTv(value, scope) : null;
    if (!emote || !previous || emotes.get(emote.name)?.id === emote.id) continue;

    deleteSevenTvEmote(emotes, previous.id);
    emotes.set(emote.name, emote);
    change.renamed.push({ from: previous.name, to: emote.name });
  }

  return change;
}

/** Removes a 7TV emote by ID; false when it was not there. */
function deleteSevenTvEmote(emotes, id) {
  let deleted = false;
  for (const [name, emote] of [...emotes]) {
    if (emote.provider !== PROVIDERS.sevenTv || emote.id !== id) continue;

    emotes.delete(name);
    deleted = true;
  }
  return deleted;
}
