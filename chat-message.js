// Chat messages: built from Twitch IRC lines, rendered to DOM with Twitch and third-party emotes,
// badges, links and mentions.

import { twitchEmote } from './chat-emotes.js';

const ACTION_PATTERN = /^\u0001ACTION (.*?)\u0001?$/s;
const LINK_PATTERN = /^(https?:\/\/|www\.)[^\s]+\.[^\s]+$/i;
const MENTION_PATTERN = /^@\w+/;
const CHEER_PATTERN = /^(.+?)(\d+)$/; // "Cheer100", "4Head500"
const SEVENTV_BADGE_CLASS = 'is-seventv';
const WORD_EDGE_PUNCTUATION = /^[^\w]+|[^\w]+$/g;

// What Twitch shows for users who never picked a color
const DEFAULT_NAME_COLORS = [
  '#ff0000',
  '#0000ff',
  '#008000',
  '#b22222',
  '#ff7f50',
  '#9acd32',
  '#ff4500',
  '#2e8b57',
  '#daa520',
  '#d2691e',
  '#5f9ea0',
  '#1e90ff',
  '#ff69b4',
  '#8a2be2',
  '#00ff7f',
];

// 4.5:1 against black (WCAG AA): dark name colors are lightened until they reach it
const MIN_NAME_LUMINANCE = 4.5 * 0.05 - 0.05;
const LIGHTEN_STEPS = 10;

const readableColors = new Map();
const emotesByImage = new WeakMap();

/** A chat line (PRIVMSG) or an event like a sub, raid or announcement (USERNOTICE). */
export function createChatMessage(irc) {
  const { tags } = irc;
  const login = tags.login || irc.login;
  const rawText = irc.params[1] ?? '';
  const action = ACTION_PATTERN.exec(rawText);
  // In a shared chat, messages from the other channels carry the room and badges they were sent with
  const sourceRoomId = tags['source-room-id'];
  const isShared = Boolean(sourceRoomId) && sourceRoomId !== tags['room-id'];

  return {
    kind: irc.command === 'USERNOTICE' ? 'event' : 'chat',
    id: tags.id ?? null,
    login,
    userId: tags['user-id'] ?? null,
    displayName: tags['display-name'] || login,
    color: tags.color || null,
    badges: parseBadges(isShared ? tags['source-badges'] : tags.badges),
    sourceRoomId: isShared ? sourceRoomId : null,
    bits: Number(tags.bits) || 0,
    text: action ? action[1] : rawText,
    isAction: Boolean(action),
    emoteRanges: parseEmoteRanges(tags.emotes),
    reply: tags['reply-parent-msg-id']
      ? { displayName: tags['reply-parent-display-name'], body: tags['reply-parent-msg-body'] }
      : null,
    eventText: tags['system-msg'] ?? null,
    isFirst: tags['first-msg'] === '1',
    isHistory: tags.historical === '1',
    deleted: tags['rm-deleted'] === '1', // the history service keeps deleted messages, marked
    element: null,
  };
}

/** A line from the chat itself: notices, mod actions, connection state. */
export function createSystemMessage(text) {
  return { kind: 'system', id: null, login: null, text, deleted: false, element: null };
}

/** The emote shown by an <img> the chat rendered (for the hover card). */
export function emoteOfImage(image) {
  return emotesByImage.get(image);
}

/**
 * Paints the name with the chatter's 7TV paint and puts their 7TV badge before it — also used to
 * restyle rendered names when 7TV delivers a chatter's cosmetics after their message.
 * @param {HTMLElement} author the .author element
 * @param {{ paint: object | null, badge: object | null }} style
 */
export function applySevenTvStyle(author, { paint, badge }) {
  author.classList.toggle('has-paint', Boolean(paint));
  author.style.backgroundImage = paint?.backgroundImage ?? '';
  author.style.filter = paint?.filter ?? '';
  author.title = paint ? `7TV paint: ${paint.name}` : '';

  const previous = author.previousElementSibling;
  const current = previous?.classList.contains(SEVENTV_BADGE_CLASS) ? previous : null;
  if (current?.title === badge?.title) return;

  current?.remove();
  if (badge) author.before(createBadgeImage(badge, SEVENTV_BADGE_CLASS));
}

/**
 * @param {object} message from createChatMessage / createSystemMessage
 * @param {{ findEmote: (name: string, message: object) => object | undefined,
 *           findBadge: (set: string, version: string, message: object) => object | undefined,
 *           findCheermote: (word: string, message: object) => object | null,
 *           findSource: (roomId: string) => { login: string, displayName: string } | null,
 *           styleOf: (userId: string) => { paint: object | null, badge: object | null },
 *           ownLogin: string | null, canReply: boolean }} context
 */
export function renderMessage(message, context) {
  const element = document.createElement('div');
  element.className = 'message';

  if (message.kind === 'system') {
    element.classList.add('is-system');
    element.textContent = message.text;
    return element;
  }

  element.classList.toggle('is-history', message.isHistory);
  element.classList.toggle('is-first', message.isFirst);
  element.classList.toggle('is-deleted', message.deleted);

  if (message.kind === 'event') {
    element.classList.add('is-event');
    if (message.eventText) element.append(createLine('event-text', message.eventText));
    if (!message.text) return element;
  }

  if (message.reply) {
    element.append(
      createLine(
        'reply-context',
        `↪ Replying to @${message.reply.displayName}: ${message.reply.body}`,
      ),
    );
  }

  const line = document.createElement('div');
  line.className = 'message-line';
  const source = message.sourceRoomId ? context.findSource(message.sourceRoomId) : null;
  if (source) line.append(createSourceAvatar(source));
  const author = createAuthor(message);
  line.append(...createBadges(message, context.findBadge), author);
  if (message.userId) applySevenTvStyle(author, context.styleOf(message.userId));
  if (!message.isAction) line.append(': ');
  line.append(createText(message, context));
  element.append(line);

  if (message.isAction) element.classList.add('is-action');
  if (message.bits > 0) element.classList.add('is-cheer');
  if (isMention(message, context.ownLogin)) element.classList.add('is-mention');
  if (context.canReply && message.kind === 'chat' && message.id)
    element.append(createReplyButton());

  return element;
}

/** Name colors readable on black, with Twitch's defaults for users without one. */
function readableNameColor(message) {
  const color = message.color ?? defaultNameColor(message.login);

  if (!readableColors.has(color)) readableColors.set(color, lightenToContrast(color));
  return readableColors.get(color);
}

function parseBadges(tag) {
  if (!tag) return [];

  return tag.split(',').map((badge) => {
    const [set, version] = badge.split('/');
    return { set, version };
  });
}

/** "emotesv2_abc:0-4,12-16/25:6-10" → [{ id, start, end }] in code points, sorted by position. */
function parseEmoteRanges(tag) {
  if (!tag) return [];

  return tag
    .split('/')
    .flatMap((entry) => {
      const [id, positions] = entry.split(':');
      return positions.split(',').map((range) => {
        const [start, end] = range.split('-').map(Number);
        return { id, start, end };
      });
    })
    .sort((a, b) => a.start - b.start);
}

function createLine(className, text) {
  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;
  return line;
}

function createBadges(message, findBadge) {
  return message.badges.flatMap(({ set, version }) => {
    const badge = findBadge(set, version, message);
    return badge ? [createBadgeImage(badge)] : [];
  });
}

function createBadgeImage(badge, extraClass) {
  const image = document.createElement('img');
  image.className = extraClass ? `badge ${extraClass}` : 'badge';
  image.alt = badge.title;
  image.title = badge.title;
  image.srcset = badge.srcset;
  image.src = badge.url;
  return image;
}

/** Shared chat: the avatar of the channel a message was sent in. */
function createSourceAvatar({ login, displayName }) {
  const image = document.createElement('img');
  image.className = 'source-avatar';
  image.alt = displayName;
  image.title = `Sent in ${displayName}'s chat`;
  image.src = `/api/avatar/${login}`;
  return image;
}

function createAuthor(message) {
  const author = document.createElement('button');
  author.type = 'button';
  author.className = 'author';
  author.dataset.login = message.login;
  if (message.userId) author.dataset.userId = message.userId;
  author.style.color = readableNameColor(message);

  // Localized names (e.g. Japanese) differ from the login, which is what @mentions need
  const isLocalized = message.displayName.toLowerCase() !== message.login;
  author.textContent = isLocalized
    ? `${message.displayName} (${message.login})`
    : message.displayName;
  return author;
}

function createReplyButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reply-button';
  button.title = 'Reply';
  button.textContent = '↩';
  return button;
}

function createText(message, { findEmote, findCheermote }) {
  const text = document.createElement('span');
  text.className = 'message-text';
  if (message.isAction) text.style.color = readableNameColor(message);

  const findWord = {
    emote: (word) => findEmote(word, message),
    // Twitch only turns cheer words into cheermotes in messages that carried bits
    cheermote: (word) => (message.bits > 0 ? findCheermote(word, message) : null),
  };
  for (const part of combineEmotes(tokenize(message, findWord))) {
    text.append(renderPart(part));
  }

  return text;
}

/** Words, spaces, Twitch emotes (by position), cheermotes and third-party emotes (by exact name). */
function tokenize(message, findWord) {
  const characters = [...message.text]; // Twitch counts emote positions in code points
  const parts = [];
  let cursor = 0;

  for (const { id, start, end } of message.emoteRanges) {
    // Overlapping or out-of-range positions (rare Twitch glitches) are left as text
    if (start < cursor || end >= characters.length) continue;

    pushWords(parts, characters.slice(cursor, start).join(''), findWord);
    parts.push({
      type: 'emote',
      emote: twitchEmote(id, characters.slice(start, end + 1).join('')),
    });
    cursor = end + 1;
  }
  pushWords(parts, characters.slice(cursor).join(''), findWord);

  return parts;
}

function pushWords(parts, text, findWord) {
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;

    if (/^\s+$/.test(word)) {
      parts.push({ type: 'space', text: word });
      continue;
    }

    const cheermote = findWord.cheermote(word);
    const emote = cheermote ? null : findWord.emote(word);
    if (cheermote) parts.push({ type: 'cheermote', cheermote });
    else if (emote) parts.push({ type: 'emote', emote });
    else if (LINK_PATTERN.test(word)) parts.push({ type: 'link', text: word });
    else if (MENTION_PATTERN.test(word)) parts.push({ type: 'mention', text: word });
    else parts.push({ type: 'text', text: word });
  }
}

/** Stacks zero-width emotes onto the emote before them and applies modifier emotes to their neighbour. */
function combineEmotes(parts) {
  const combined = [];
  let pendingEffects = [];

  for (const part of parts) {
    if (part.type !== 'emote') {
      if (part.type !== 'space') pendingEffects = [];
      combined.push(part);
      continue;
    }

    const { emote } = part;

    if (emote.modifier?.appliesTo === 'next') {
      if (emote.modifier.effect) pendingEffects.push(emote.modifier.effect);
      continue;
    }

    if (emote.modifier || emote.zeroWidth) {
      const target = previousEmote(combined);
      if (target) {
        trimTrailingSpaces(combined);
        if (emote.modifier?.effect) target.effects.push(emote.modifier.effect);
        else if (!emote.modifier) target.overlays.push(emote);
        continue;
      }
      if (emote.modifier) {
        combined.push({ type: 'text', text: emote.name });
        continue;
      }
    }

    combined.push({ type: 'emote', emote, overlays: [], effects: pendingEffects });
    pendingEffects = [];
  }

  return combined;
}

function previousEmote(parts) {
  const last = parts.findLast((part) => part.type !== 'space');
  return last?.type === 'emote' ? last : null;
}

function trimTrailingSpaces(parts) {
  while (parts.at(-1)?.type === 'space') parts.pop();
}

function renderPart(part) {
  switch (part.type) {
    case 'emote':
      return createEmote(part);
    case 'cheermote':
      return createCheermote(part.cheermote);
    case 'link':
      return createLink(part.text);
    case 'mention': {
      const mention = document.createElement('span');
      mention.className = 'mention';
      mention.textContent = part.text;
      return mention;
    }
    default:
      return part.text;
  }
}

function createEmote({ emote, overlays, effects }) {
  const image = createEmoteImage(emote);
  for (const effect of effects) image.classList.add(`effect-${effect}`);
  if (effects.includes('wide')) trackAspectRatio(image, emote);

  if (overlays.length === 0) return image;

  const stack = document.createElement('span');
  stack.className = 'emote-stack';
  stack.append(image);
  for (const overlay of overlays) {
    const overlayImage = createEmoteImage(overlay);
    overlayImage.classList.add('is-overlay');
    stack.append(overlayImage);
  }
  return stack;
}

function createCheermote(cheermote) {
  const cheer = document.createElement('span');
  cheer.className = 'cheer';
  const amount = document.createElement('span');
  amount.className = 'cheer-amount';
  amount.style.color = cheermote.color;
  amount.textContent = cheermote.bits;
  cheer.append(createEmoteImage(cheermote), amount);
  return cheer;
}

/** Splits a cheer word into prefix and bits ("Cheer100" → Cheer, 100), null when it is none. */
export function parseCheerWord(word) {
  const match = CHEER_PATTERN.exec(word);
  return match ? { prefix: match[1].toLowerCase(), bits: Number(match[2]) } : null;
}

function createEmoteImage(emote) {
  const image = document.createElement('img');
  image.className = 'emote';
  image.alt = emote.name;
  image.decoding = 'async';
  // Known sizes reserve the room before the image loads — no jumping lines
  if (emote.width) {
    image.width = emote.width;
    image.height = emote.height;
  }
  image.srcset = emote.srcset;
  image.src = emote.url;
  emotesByImage.set(image, emote);
  return image;
}

/** Wide emotes are drawn at twice their width; CSS needs the aspect ratio for that. */
function trackAspectRatio(image, emote) {
  const setRatio = (width, height) => image.style.setProperty('--aspect-ratio', width / height);

  if (emote.width) setRatio(emote.width, emote.height);
  else
    image.addEventListener('load', () => setRatio(image.naturalWidth, image.naturalHeight), {
      once: true,
    });
}

function createLink(text) {
  const link = document.createElement('a');
  link.className = 'link';
  link.href = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = text;
  return link;
}

function isMention(message, ownLogin) {
  if (!ownLogin || message.login === ownLogin) return false;

  return message.text
    .split(/\s+/)
    .some((word) => word.replace(WORD_EDGE_PUNCTUATION, '').toLowerCase() === ownLogin);
}

function defaultNameColor(login) {
  const hash = [...login].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return DEFAULT_NAME_COLORS[hash % DEFAULT_NAME_COLORS.length];
}

function lightenToContrast(hex) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  if (channels.some(Number.isNaN)) return hex;

  for (let step = 0; step <= LIGHTEN_STEPS; step++) {
    const amount = step / LIGHTEN_STEPS;
    const mixed = channels.map((channel) => Math.round(channel + (255 - channel) * amount));
    if (relativeLuminance(mixed) >= MIN_NAME_LUMINANCE) return `rgb(${mixed.join(', ')})`;
  }

  return '#fff';
}

function relativeLuminance(channels) {
  const [red, green, blue] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
