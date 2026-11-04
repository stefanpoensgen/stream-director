// StreamDirector's chat popup: Twitch chat of the marked stream with 7TV, BetterTTV and FrankerFaceZ
// emotes and 7TV's name paints and badges. Every channel with an active player stays joined in the
// background, so switching the focus shows its chat at once — recent history included.

import { createEmoteRegistry, PROVIDERS, twitchEmote } from './chat-emotes.js';
import { IrcConnection, parseIrcLine } from './chat-irc.js';
import {
  applySevenTvStyle,
  createChatMessage,
  createSystemMessage,
  emoteOfImage,
  parseCheerWord,
  renderMessage,
} from './chat-message.js';
import { createSevenTvCosmetics, SevenTvEvents } from './chat-seventv.js';
import { CHAT_SYNC_CHANNEL, CHAT_SYNC_TYPES } from './chat-sync.js';

// Recent messages of a channel, so a freshly joined chat is not empty (the service Chatterino uses)
const HISTORY_URL = 'https://recent-messages.robotty.de/api/v2/recent-messages';
const HISTORY_LIMIT = 100;
const TWITCH_POPOUT_URL = 'https://www.twitch.tv/popout';

// Messages kept per channel; while the shown chat is scrolled up (paused) it may grow larger
const LIVE_MESSAGE_LIMIT = 300;
const PAUSED_MESSAGE_LIMIT = 2000;
const CHATTER_LIMIT = 500;
const SENT_HISTORY_LIMIT = 50;
const PINNED_THRESHOLD_PX = 32;
const CARD_GAP_PX = 6;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const ME_COMMAND = '/me ';
const PLAIN_EMOTE_NAME = /^\w+$/; // Twitch's old smileys (":)", "<3") are patterns, not names
const SCOPE_LABELS = { channel: 'Channel', global: 'Global', personal: 'Personal' };

const dom = {};

/** login → { login, displayName, roomId, messages, roomState, badges, cheermotes, chatters } */
const channels = new Map();
// Other channels of a shared chat (Stream Together), by room ID: { login, displayName, badges }
const sharedSources = new Map();
const requestedSources = new Set();
let ownTwitchEmotes = []; // [{ owner, emotes }] the logged-in user may send
let shown = null;
let identity = null; // { login, token } while logged in
let writer = null;
let lastMainLoggedIn = null;
let identityRequest = null;
let globalBadges = new Map();

let isPinned = true;
let lastScrollTop = 0;
let unseenCount = 0;
let pendingAppends = [];
let needsFullRender = false;
let isFlushScheduled = false;

let reply = null; // the message being replied to
let completion = null; // ongoing Tab completion: { start, candidates, index }
const sentHistory = [];
let sentHistoryIndex = -1;

let restyleUserIds = null; // chatters whose 7TV look changed since the last frame (null: none)
let restyleEveryone = false;

const messagesByElement = new WeakMap();
const sevenTvEvents = new SevenTvEvents();
const emotes = createEmoteRegistry(sevenTvEvents, { onChannelChange: announceEmoteChange });
const cosmetics = createSevenTvCosmetics(sevenTvEvents, {
  onChange: scheduleRestyle,
  onPersonalSet: (setId) => emotes.ensurePersonalSet(setId),
});
const reader = new IrcConnection({ onMessage: handleReaderMessage, onStatus: showReaderStatus });
const sync = new BroadcastChannel(CHAT_SYNC_CHANNEL);

function init() {
  cacheDom();
  bindEvents();

  reader.connect();
  emotes.loadGlobal().then(invalidateAll);

  sync.addEventListener('message', ({ data }) => {
    if (data?.type === CHAT_SYNC_TYPES.state) applyMainState(data);
  });
  sync.postMessage({ type: CHAT_SYNC_TYPES.hello });

  renderHeader();
  updateComposer();
}

function cacheDom() {
  dom.avatar = document.getElementById('channel-avatar');
  dom.name = document.getElementById('channel-name');
  dom.modes = document.getElementById('room-modes');
  dom.twitchChat = document.getElementById('twitch-chat');
  dom.status = document.getElementById('chat-status');
  dom.scroller = document.getElementById('messages');
  dom.list = document.getElementById('message-list');
  dom.empty = document.getElementById('chat-empty');
  dom.resume = document.getElementById('resume');
  dom.replyBar = document.getElementById('reply-bar');
  dom.replyText = document.getElementById('reply-text');
  dom.replyCancel = document.getElementById('reply-cancel');
  dom.form = document.getElementById('composer');
  dom.input = document.getElementById('composer-input');
  dom.emoteButton = document.getElementById('emote-button');
  dom.emotePicker = document.getElementById('emote-picker');
  dom.emoteSearch = document.getElementById('emote-search');
  dom.emotePickerList = document.getElementById('emote-picker-list');
  dom.emoteCard = document.getElementById('emote-card');
}

// ═══════════════════════════════════════════════════════════════════
// Channels
// ═══════════════════════════════════════════════════════════════════

/** The main page's state: the marked stream is shown, all streams with a player stay joined. */
function applyMainState({ focus, channels: list, loggedIn }) {
  syncChannels(list);
  show(channels.get(focus) ?? null);
  renderHeader(); // display names arrive with the main page's live check

  if (loggedIn === lastMainLoggedIn) return;

  lastMainLoggedIn = loggedIn;
  refreshIdentity();
}

function syncChannels(list) {
  const wanted = new Map(list.map((channel) => [channel.login, channel]));

  for (const login of [...channels.keys()]) {
    if (!wanted.has(login)) leaveChannel(login);
  }

  for (const { login, displayName } of wanted.values()) {
    const channel = channels.get(login);
    if (channel) channel.displayName = displayName ?? channel.displayName;
    else joinChannel(login, displayName);
  }
}

function joinChannel(login, displayName) {
  const channel = {
    login,
    displayName: displayName ?? login,
    roomId: null,
    messages: [],
    roomState: {},
    badges: new Map(),
    cheermotes: null,
    chatters: new Map(), // login → display name, most recent last
  };
  channels.set(login, channel);

  reader.join(login);
  loadBadges(channel);
  loadCheermotes(channel);
  loadHistory(channel);
}

function leaveChannel(login) {
  const channel = channels.get(login);
  channels.delete(login);

  reader.part(login);
  writer?.part(login);
  if (!channel.roomId) return;

  cosmetics.unwatchChannel(channel.roomId);
  // A channel that is still the source of shared chat messages keeps its emotes
  if (!sharedSources.has(channel.roomId)) emotes.forgetChannel(channel.roomId);
}

function isCurrent(channel) {
  return channels.get(channel.login) === channel;
}

/** Emotes are per room ID, which Twitch sends with the channel's first message or room state. */
function learnRoomId(channel, roomId) {
  if (!roomId || channel.roomId) return;

  channel.roomId = roomId;
  cosmetics.watchChannel(roomId);
  emotes.loadChannel(roomId).then(() => {
    if (isCurrent(channel)) invalidate(channel);
  });
}

async function loadBadges(channel) {
  const badges = await fetchChatApi(`/api/chat/badges/${channel.login}`);
  if (!badges) return;

  if (globalBadges.size === 0) globalBadges = toBadgeMap(badges.global);
  channel.badges = toBadgeMap(badges.channel);
  if (isCurrent(channel)) invalidate(channel);
}

/** Cheermotes by lowercase prefix, each with its bit tiers ascending; tier colors ascending too. */
async function loadCheermotes(channel) {
  const cheer = await fetchChatApi(`/api/chat/cheermotes/${channel.login}`);
  if (!cheer) return;

  const byPrefix = new Map();
  for (const { prefix, template, tiers } of cheer.cheermotes) {
    // The channel's own cheermotes come first and win over global ones with the same prefix
    const key = prefix.toLowerCase();
    if (!byPrefix.has(key))
      byPrefix.set(key, { template, tiers: [...tiers].sort((a, b) => a - b) });
  }
  const colors = [...cheer.colors].sort((a, b) => a.bits - b.bits);

  channel.cheermotes = { byPrefix, colors };
  if (isCurrent(channel)) invalidate(channel);
}

/** JSON from the host's chat API, or null — a missing extra must not break the chat. */
async function fetchChatApi(path) {
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    return await response.json();
  } catch (error) {
    console.warn(`${path} could not be loaded:`, error);
    return null;
  }
}

/** "set/version" → { title, url, srcset }; Twitch serves each badge at …/1, …/2 and …/3 (18, 36, 72 px). */
function toBadgeMap(badges) {
  return new Map(
    badges.map(({ set, version, title, url }) => {
      const base = url.slice(0, url.lastIndexOf('/') + 1);
      return [`${set}/${version}`, { title, url, srcset: `${base}1 1x, ${base}2 2x, ${base}3 4x` }];
    }),
  );
}

/** Recent messages go before everything that arrived live in the meantime. */
async function loadHistory(channel) {
  let lines;
  try {
    const response = await fetch(`${HISTORY_URL}/${channel.login}?limit=${HISTORY_LIMIT}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    lines = (await response.json()).messages ?? [];
  } catch (error) {
    console.warn(`Chat history of ${channel.login} could not be loaded:`, error);
    return;
  }
  if (!isCurrent(channel) || lines.length === 0) return;

  // A copy collects the history; chatters and room state go straight into the channel
  const history = { ...channel, messages: [] };
  for (const line of lines) {
    const message = parseIrcLine(line);
    learnRoomId(channel, message.tags['room-id']);
    handleChannelMessage(history, message);
  }

  const liveIds = new Set(channel.messages.map((message) => message.id).filter(Boolean));
  const earlier = history.messages.filter((message) => !message.id || !liveIds.has(message.id));
  channel.messages = [...earlier, ...channel.messages];
  trimMessages(channel);
  if (channel === shown) renderAll();
}

// ═══════════════════════════════════════════════════════════════════
// Twitch IRC
// ═══════════════════════════════════════════════════════════════════

function channelOf(message) {
  const target = message.params[0];
  return target?.startsWith('#') ? channels.get(target.slice(1)) : undefined;
}

function handleReaderMessage(message) {
  const channel = channelOf(message);
  if (!channel) return;

  learnRoomId(channel, message.tags['room-id']);

  // The writing connection reports the same notices when logged in — show them only once
  if (message.command === 'NOTICE' && writer) return;

  handleChannelMessage(channel, message);
}

function handleChannelMessage(channel, message) {
  switch (message.command) {
    case 'PRIVMSG':
    case 'USERNOTICE': {
      const chatMessage = createChatMessage(message);
      rememberChatter(channel, chatMessage);
      addMessage(channel, chatMessage);
      break;
    }
    case 'CLEARMSG':
      deleteMessage(channel, message.tags['target-msg-id']);
      break;
    case 'CLEARCHAT':
      clearChat(channel, message);
      break;
    case 'ROOMSTATE':
      Object.assign(channel.roomState, message.tags);
      if (channel === shown) renderRoomModes();
      break;
    case 'NOTICE':
      addMessage(channel, createSystemMessage(message.params.at(-1)));
      break;
  }
}

/** The writing connection only matters for what it reports about our own messages. */
function handleWriterMessage(message) {
  if (message.command !== 'NOTICE') return;

  const channel = channelOf(message);
  if (channel) addMessage(channel, createSystemMessage(message.params.at(-1)));
}

function rememberChatter(channel, message) {
  if (!message.login || message.kind !== 'chat') return;

  channel.chatters.delete(message.login);
  channel.chatters.set(message.login, message.displayName);
  if (channel.chatters.size > CHATTER_LIMIT) {
    channel.chatters.delete(channel.chatters.keys().next().value);
  }
}

function deleteMessage(channel, id) {
  const message = channel.messages.find((candidate) => candidate.id === id);
  if (message) markDeleted(message);
}

/** A timeout or ban hides the user's messages; without a user, a moderator cleared the whole chat. */
function clearChat(channel, message) {
  const target = message.params[1];
  if (!target) {
    channel.messages.forEach(markDeleted);
    addMessage(channel, createSystemMessage('A moderator cleared the chat'));
    return;
  }

  for (const candidate of channel.messages) {
    if (candidate.login === target) markDeleted(candidate);
  }

  const duration = Number(message.tags['ban-duration']);
  const text = duration
    ? `${target} was timed out for ${formatDuration(duration)}`
    : `${target} was banned`;
  addMessage(channel, createSystemMessage(text));
}

function markDeleted(message) {
  if (message.kind === 'system') return;

  message.deleted = true;
  message.element?.classList.add('is-deleted');
}

function formatDuration(seconds) {
  if (seconds >= SECONDS_PER_DAY) return `${Math.round(seconds / SECONDS_PER_DAY)} d`;
  if (seconds >= SECONDS_PER_HOUR) return `${Math.round(seconds / SECONDS_PER_HOUR)} h`;
  if (seconds >= SECONDS_PER_MINUTE) return `${Math.round(seconds / SECONDS_PER_MINUTE)} min`;
  return `${seconds} s`;
}

function showReaderStatus(status) {
  const texts = {
    connecting: 'Connecting to chat…',
    disconnected: 'Chat disconnected — reconnecting…',
  };

  dom.status.textContent = texts[status] ?? '';
  dom.status.classList.toggle('hidden', !texts[status]);
}

function showWriterStatus(status) {
  if (status !== 'auth-failed') return;

  writer = null;
  identity = null;
  updateComposer();
  if (shown)
    addMessage(
      shown,
      createSystemMessage('Twitch rejected the login — log in again in the main window to chat'),
    );
}

/** 7TV edits arrive live; the chat tells about them like the 7TV extension does. */
function announceEmoteChange(roomId, { added, removed, renamed, actor }) {
  const channel = [...channels.values()].find((candidate) => candidate.roomId === roomId);
  if (!channel) return;

  const by = actor ? ` by ${actor}` : '';
  for (const name of added) addMessage(channel, createSystemMessage(`7TV: ${name} added${by}`));
  for (const name of removed) addMessage(channel, createSystemMessage(`7TV: ${name} removed${by}`));
  for (const { from, to } of renamed) {
    addMessage(channel, createSystemMessage(`7TV: ${from} renamed to ${to}${by}`));
  }
  invalidate(channel);
}

// ═══════════════════════════════════════════════════════════════════
// Login
// ═══════════════════════════════════════════════════════════════════

/** Reading works anonymously; sending needs the main window's Twitch login. */
function refreshIdentity() {
  identityRequest ??= loadIdentity().finally(() => {
    identityRequest = null;
  });
}

async function loadIdentity() {
  let next = null;
  try {
    const response = await fetch('/api/chat/identity');
    const data = await response.json();
    if (data.loggedIn) next = { login: data.login, token: data.token };
  } catch (error) {
    console.warn('Chat login could not be loaded:', error);
  }
  if (next?.token === identity?.token) return;

  identity = next;
  writer?.close();
  writer = null;

  if (identity) {
    writer = new IrcConnection({
      credentials: identity,
      onMessage: handleWriterMessage,
      onStatus: showWriterStatus,
    });
    writer.connect();
    if (shown) writer.join(shown.login);
  }

  // Mentions and reply buttons depend on who is logged in
  invalidateAll();
  updateComposer();
  loadOwnTwitchEmotes();
}

/** The Twitch emotes the user may send (globals, subscriptions) — for the picker and Tab completion. */
async function loadOwnTwitchEmotes() {
  ownTwitchEmotes = [];
  if (!identity) return;

  const sets = (await fetchChatApi('/api/chat/emotes')) ?? [];
  const byOwner = new Map();
  for (const { owner, emotes: setEmotes } of sets) {
    const key = owner ?? 'Global'; // Twitch's own emotes have no owner
    if (!byOwner.has(key)) byOwner.set(key, new Map());
    for (const { id, name } of setEmotes) {
      if (PLAIN_EMOTE_NAME.test(name)) byOwner.get(key).set(name, twitchEmote(id, name));
    }
  }

  ownTwitchEmotes = [...byOwner]
    .map(([owner, ownerEmotes]) => ({
      owner,
      emotes: [...ownerEmotes.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((set) => set.emotes.length > 0);
}

// ═══════════════════════════════════════════════════════════════════
// Message list
// ═══════════════════════════════════════════════════════════════════

function show(channel) {
  if (channel === shown) return;

  shown = channel;
  cancelReply();
  resetCompletion();
  // Sending needs the writing connection in the channel; joined once, it stays
  if (channel) writer?.join(channel.login);

  closeEmotePicker();
  renderHeader();
  updateComposer();
  renderAll();
  // Cached messages were rendered before newer 7TV cosmetics of their senders arrived
  restyleAuthors(null);
}

function renderContext(channel) {
  return {
    findEmote: (name, message) =>
      emotes.find(
        message.sourceRoomId ?? channel.roomId,
        name,
        message.userId ? cosmetics.personalSetIds(message.userId) : null,
      ),
    findBadge: (set, version, message) => {
      const key = `${set}/${version}`;
      const badges = message.sourceRoomId
        ? sourceChannel(message.sourceRoomId)?.badges
        : channel.badges;
      return badges?.get(key) ?? globalBadges.get(key);
    },
    findCheermote: (word) => findCheermote(channel, word),
    findSource: sourceChannel,
    styleOf: (userId) => cosmetics.styleOf(userId),
    ownLogin: identity?.login ?? null,
    canReply: Boolean(identity),
  };
}

/** "Cheer100" → the cheermote image of its tier and the tier's color, null for other words. */
function findCheermote(channel, word) {
  const cheer = parseCheerWord(word);
  const cheermote = cheer && channel.cheermotes?.byPrefix.get(cheer.prefix);
  if (!cheermote) return null;

  const tier = cheermote.tiers.findLast((bits) => bits <= cheer.bits) ?? cheermote.tiers[0];
  const url = (scale) => cheermote.template.replace('TIER', tier).replace('SCALE', scale);
  const color = channel.cheermotes.colors.findLast((entry) => entry.bits <= cheer.bits)?.color;

  return {
    name: word,
    provider: PROVIDERS.twitch,
    scope: null,
    url: url('1'),
    srcset: `${url('1')} 1x, ${url('2')} 2x, ${url('4')} 4x`,
    largeUrl: url('4'),
    bits: cheer.bits,
    color: color ?? null,
  };
}

/**
 * The channel a shared chat message came from: a joined channel, or one looked up once by room ID
 * (its emotes and badges load with it, then the shown chat is redrawn).
 */
function sourceChannel(roomId) {
  const joined = [...channels.values()].find((channel) => channel.roomId === roomId);
  if (joined) return joined;
  if (sharedSources.has(roomId)) return sharedSources.get(roomId);

  if (!requestedSources.has(roomId)) {
    requestedSources.add(roomId);
    loadSharedSource(roomId);
  }
  return null;
}

async function loadSharedSource(roomId) {
  const [found] = (await fetchChatApi(`/api/chat/channels?ids=${roomId}`)) ?? [];
  if (!found) return;

  const badges = await fetchChatApi(`/api/chat/badges/${found.login}`);
  const source = {
    login: found.login,
    displayName: found.displayName ?? found.login,
    badges: badges ? toBadgeMap(badges.channel) : new Map(),
  };
  sharedSources.set(roomId, source);
  if (!emotes.hasChannel(roomId)) await emotes.loadChannel(roomId);

  if (shown) invalidate(shown);
}

/** 7TV cosmetics often arrive after a chatter's message — rendered names are restyled once per frame. */
function scheduleRestyle(userId) {
  if (userId === null) restyleEveryone = true;
  else (restyleUserIds ??= new Set()).add(userId);

  requestAnimationFrame(() => {
    if (!restyleEveryone && !restyleUserIds) return;

    restyleAuthors(restyleEveryone ? null : restyleUserIds);
    restyleEveryone = false;
    restyleUserIds = null;
  });
}

/** Re-applies 7TV paints and badges to the shown names of `userIds` (null: everyone). */
function restyleAuthors(userIds) {
  for (const author of dom.list.querySelectorAll('.author[data-user-id]')) {
    const { userId } = author.dataset;
    if (!userIds || userIds.has(userId)) applySevenTvStyle(author, cosmetics.styleOf(userId));
  }
}

function elementOf(channel, message) {
  if (!message.element) {
    message.element = renderMessage(message, renderContext(channel));
    messagesByElement.set(message.element, message);
  }
  return message.element;
}

function addMessage(channel, message) {
  channel.messages.push(message);
  if (channel === shown) queueAppend(message);
  trimMessages(channel);
}

function trimMessages(channel) {
  const limit = channel === shown && !isPinned ? PAUSED_MESSAGE_LIMIT : LIVE_MESSAGE_LIMIT;
  const excess = channel.messages.length - limit;
  if (excess <= 0) return;

  for (const message of channel.messages.splice(0, excess)) {
    message.isTrimmed = true;
    message.element?.remove();
  }
}

/** Busy chats bring dozens of messages per second — they are added once per frame. */
function queueAppend(message) {
  if (needsFullRender) return;

  pendingAppends.push(message);
  // Frames stop while the window is hidden; past a full list, redrawing everything is cheaper
  if (pendingAppends.length > LIVE_MESSAGE_LIMIT) {
    pendingAppends = [];
    needsFullRender = true;
  }
  scheduleFlush();
}

function scheduleFlush() {
  if (isFlushScheduled) return;

  isFlushScheduled = true;
  requestAnimationFrame(flushAppends);
}

function flushAppends() {
  isFlushScheduled = false;
  if (needsFullRender) {
    renderAll();
    return;
  }

  const messages = pendingAppends.filter((message) => !message.isTrimmed);
  pendingAppends = [];
  if (messages.length === 0 || !shown) return;

  dom.list.append(...messages.map((message) => elementOf(shown, message)));
  if (isPinned) {
    scrollToBottom();
  } else {
    unseenCount += messages.length;
    renderResumeButton();
  }
}

function renderAll() {
  pendingAppends = [];
  needsFullRender = false;

  dom.list.replaceChildren(...(shown?.messages.map((message) => elementOf(shown, message)) ?? []));
  dom.empty.classList.toggle('hidden', Boolean(shown));
  setPinned(true);
}

/** Drops the rendered elements, e.g. after emotes or badges arrived — the shown chat is redrawn. */
function invalidate(channel) {
  for (const message of channel.messages) message.element = null;
  if (channel === shown) renderAll();
}

function invalidateAll() {
  for (const channel of channels.values()) invalidate(channel);
}

// ═══════════════════════════════════════════════════════════════════
// Scrolling: pinned to the newest message until the user scrolls up
// ═══════════════════════════════════════════════════════════════════

function scrollToBottom() {
  dom.scroller.scrollTop = dom.scroller.scrollHeight;
  lastScrollTop = dom.scroller.scrollTop;
}

function setPinned(pinned) {
  isPinned = pinned;
  if (pinned) {
    unseenCount = 0;
    scrollToBottom();
    if (shown) trimMessages(shown);
  }
  renderResumeButton();
}

function handleScroll() {
  const { scrollTop, scrollHeight, clientHeight } = dom.scroller;
  const distance = scrollHeight - scrollTop - clientHeight;

  // Only scrolling up pauses — trimming old messages or late-loading images move the list too
  if (distance < PINNED_THRESHOLD_PX) {
    if (!isPinned) setPinned(true);
  } else if (scrollTop < lastScrollTop && isPinned) {
    setPinned(false);
  }
  lastScrollTop = scrollTop;
}

function renderResumeButton() {
  dom.resume.classList.toggle('hidden', isPinned);
  dom.resume.textContent =
    unseenCount > 0
      ? `↓ ${unseenCount > LIVE_MESSAGE_LIMIT ? `${LIVE_MESSAGE_LIMIT}+` : unseenCount} new messages`
      : '↓ Chat paused';
}

// ═══════════════════════════════════════════════════════════════════
// Header
// ═══════════════════════════════════════════════════════════════════

function renderHeader() {
  dom.avatar.classList.toggle('hidden', !shown);
  dom.twitchChat.classList.toggle('hidden', !shown);
  if (shown) dom.avatar.src = `/api/avatar/${shown.login}`;
  dom.name.textContent = shown?.displayName ?? 'No stream in focus';
  document.title = shown ? `${shown.displayName} – Chat` : 'Chat';
  renderRoomModes();
}

function renderRoomModes() {
  const state = shown?.roomState ?? {};
  const modes = [];
  const followersMinutes = Number(state['followers-only'] ?? -1);
  const slowSeconds = Number(state.slow ?? 0);

  if (state['emote-only'] === '1') modes.push('Emote-only');
  if (state['subs-only'] === '1') modes.push('Subscribers-only');
  if (followersMinutes === 0) modes.push('Followers-only');
  if (followersMinutes > 0)
    modes.push(`Followers-only (${formatDuration(followersMinutes * SECONDS_PER_MINUTE)})`);
  if (slowSeconds > 0) modes.push(`Slow (${formatDuration(slowSeconds)})`);
  if (state.r9k === '1') modes.push('Unique messages');

  dom.modes.textContent = modes.join(' · ');
}

// ═══════════════════════════════════════════════════════════════════
// Composer: sending, replies, Tab completion, sent history
// ═══════════════════════════════════════════════════════════════════

function updateComposer() {
  dom.input.disabled = !identity || !shown;
  dom.emoteButton.classList.toggle('hidden', dom.input.disabled);
  if (dom.input.disabled) closeEmotePicker();
  if (!identity) dom.input.placeholder = 'Log in to Twitch in the main window to chat';
  else dom.input.placeholder = shown ? `Send a message as ${identity.login}` : '';
}

function sendMessage() {
  const text = dom.input.value.trim();
  if (!text || !shown || !writer) return;

  // Twitch's other chat commands are no longer available over IRC
  if (text.startsWith('/') && !text.startsWith(ME_COMMAND)) {
    addMessage(
      shown,
      createSystemMessage(
        `Only /me works here — use Twitch's chat (↗ above) for ${text.split(' ')[0]}`,
      ),
    );
    return;
  }

  const body = text.startsWith(ME_COMMAND)
    ? `\u0001ACTION ${text.slice(ME_COMMAND.length)}\u0001`
    : text;
  const tags = reply ? `@reply-parent-msg-id=${reply.id} ` : '';
  if (!writer.send(`${tags}PRIVMSG #${shown.login} :${body}`)) {
    addMessage(
      shown,
      createSystemMessage('Not connected to Twitch chat yet — try again in a moment'),
    );
    return;
  }

  sentHistory.push(text);
  if (sentHistory.length > SENT_HISTORY_LIMIT) sentHistory.shift();
  sentHistoryIndex = -1;
  dom.input.value = '';
  cancelReply();
}

function startReply(message) {
  if (!identity) return;

  reply = message;
  dom.replyText.textContent = `Replying to @${message.displayName}: ${message.text}`;
  dom.replyBar.classList.remove('hidden');
  dom.input.focus();
}

function cancelReply() {
  reply = null;
  dom.replyBar.classList.add('hidden');
}

function insertMention(login) {
  if (dom.input.disabled) return;

  const separator = dom.input.value && !dom.input.value.endsWith(' ') ? ' ' : '';
  dom.input.value += `${separator}@${login} `;
  dom.input.focus();
}

/** Tab completes the word before the cursor — emotes and recent chatters, @ for chatters only. */
function complete(backwards) {
  const { value, selectionStart } = dom.input;

  if (!completion) {
    const start = value.lastIndexOf(' ', selectionStart - 1) + 1;
    const word = value.slice(start, selectionStart);
    if (!word) return;

    const candidates = completionCandidates(word);
    if (candidates.length === 0) return;

    completion = { start, candidates, index: backwards ? candidates.length - 1 : 0 };
  } else {
    const step = backwards ? -1 : 1;
    completion.index =
      (completion.index + step + completion.candidates.length) % completion.candidates.length;
  }

  const replacement = `${completion.candidates[completion.index]} `;
  const end = value.indexOf(' ', completion.start);
  const rest = end === -1 ? '' : value.slice(end + 1);
  dom.input.value = value.slice(0, completion.start) + replacement + rest;

  const cursor = completion.start + replacement.length;
  dom.input.setSelectionRange(cursor, cursor);
}

function completionCandidates(word) {
  const isMentionWord = word.startsWith('@');
  const prefix = (isMentionWord ? word.slice(1) : word).toLowerCase();
  const chatters = [...shown.chatters.values()].reverse(); // most recent first
  const startsWithPrefix = (name) => name.toLowerCase().startsWith(prefix);

  if (isMentionWord) return chatters.filter(startsWithPrefix).map((name) => `@${name}`);

  const usable = emotes.usable(shown.roomId);
  const emoteNames = [
    ...usable.channel,
    ...ownTwitchEmotes.flatMap((set) => set.emotes),
    ...usable.global,
  ]
    .map((emote) => emote.name)
    .filter(startsWithPrefix)
    .sort(byLengthThenName);
  return [...new Set([...emoteNames, ...chatters.filter(startsWithPrefix)])];
}

/** Shorter names first — "xqc" + Tab should offer xqcL before xqcLongEmoteName. */
function byLengthThenName(a, b) {
  return a.length - b.length || a.localeCompare(b);
}

function resetCompletion() {
  completion = null;
}

function recallSent(direction) {
  if (sentHistory.length === 0) return;

  const index = sentHistoryIndex === -1 ? sentHistory.length : sentHistoryIndex;
  const next = Math.min(Math.max(index + direction, 0), sentHistory.length);
  sentHistoryIndex = next === sentHistory.length ? -1 : next;
  dom.input.value = sentHistoryIndex === -1 ? '' : sentHistory[sentHistoryIndex];
}

function handleComposerKey(event) {
  if (event.key === 'Tab') {
    event.preventDefault();
    complete(event.shiftKey);
    return;
  }
  if (event.key !== 'Shift') resetCompletion();

  if (event.key === 'Escape' && reply) {
    event.preventDefault();
    cancelReply();
  } else if (event.key === 'ArrowUp' && (!dom.input.value || sentHistoryIndex !== -1)) {
    event.preventDefault();
    recallSent(-1);
  } else if (event.key === 'ArrowDown' && sentHistoryIndex !== -1) {
    event.preventDefault();
    recallSent(1);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Emote picker: the channel's emotes, the user's Twitch emotes, global emotes
// ═══════════════════════════════════════════════════════════════════

function toggleEmotePicker() {
  if (dom.emotePicker.classList.contains('hidden')) openEmotePicker();
  else closeEmotePicker();
}

function openEmotePicker() {
  if (!shown || !identity) return;

  dom.emoteSearch.value = '';
  renderEmotePicker();
  dom.emotePicker.classList.remove('hidden');
  dom.emoteButton.classList.add('is-open');
  dom.emoteSearch.focus();
}

function closeEmotePicker() {
  dom.emotePicker.classList.add('hidden');
  dom.emoteButton.classList.remove('is-open');
}

function renderEmotePicker() {
  const query = dom.emoteSearch.value.trim().toLowerCase();
  const usable = emotes.usable(shown.roomId);
  // The shown channel's own subscriber emotes first
  const isShownOwner = (set) => set.owner === shown.displayName;
  const twitchSets = [...ownTwitchEmotes].sort((a, b) => isShownOwner(b) - isShownOwner(a));
  const sections = [
    { title: `${shown.displayName} · 7TV, BetterTTV, FFZ`, emotes: usable.channel },
    ...twitchSets.map((set) => ({ title: `Twitch · ${set.owner}`, emotes: set.emotes })),
    { title: 'Global · 7TV, BetterTTV, FFZ', emotes: usable.global },
  ];

  const nodes = sections.flatMap(({ title, emotes: sectionEmotes }) => {
    const matching = query
      ? sectionEmotes.filter((emote) => emote.name.toLowerCase().includes(query))
      : sectionEmotes;
    if (matching.length === 0) return [];

    const heading = document.createElement('div');
    heading.className = 'emote-picker-title';
    heading.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'emote-picker-grid';
    grid.append(...matching.map(createPickerItem));
    return [heading, grid];
  });

  if (nodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'emote-picker-empty';
    empty.textContent = 'No emotes found';
    nodes.push(empty);
  }
  dom.emotePickerList.replaceChildren(...nodes);
  dom.emotePickerList.scrollTop = 0;
}

function createPickerItem(emote) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'emote-picker-item';
  item.dataset.name = emote.name;
  item.title = `${emote.name} · ${emote.provider}`;

  const image = document.createElement('img');
  image.alt = emote.name;
  image.loading = 'lazy'; // before src — big channels have a thousand emotes
  image.decoding = 'async';
  image.srcset = emote.srcset;
  image.src = emote.url;
  item.append(image);
  return item;
}

/** Puts an emote at the cursor, with spaces around it so it stays its own word. */
function insertEmote(name) {
  const { value, selectionStart, selectionEnd } = dom.input;
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const text = `${before && !before.endsWith(' ') ? ' ' : ''}${name} `;

  dom.input.value = `${before}${text}${after.trimStart()}`;
  const cursor = before.length + text.length;
  dom.input.setSelectionRange(cursor, cursor);
}

function handleEmoteSearchKey(event) {
  if (event.key !== 'Escape' && event.key !== 'Enter') return;

  event.preventDefault();
  closeEmotePicker();
  dom.input.focus();
}

// ═══════════════════════════════════════════════════════════════════
// Emote hover card
// ═══════════════════════════════════════════════════════════════════

function showEmoteCard(image) {
  const emote = emoteOfImage(image);
  if (!emote) return;

  const scope = emote.scope ? ` · ${SCOPE_LABELS[emote.scope]}` : '';
  const overlay = emote.zeroWidth ? ' · Zero-width' : '';
  const picture = document.createElement('img');
  picture.className = 'emote-card-image';
  picture.src = emote.largeUrl;
  picture.alt = '';
  const name = document.createElement('div');
  name.className = 'emote-card-name';
  name.textContent = emote.name;
  const source = document.createElement('div');
  source.className = 'emote-card-source';
  source.textContent = `${emote.provider}${emote.provider === PROVIDERS.twitch ? '' : scope}${overlay}`;
  dom.emoteCard.replaceChildren(picture, name, source);
  dom.emoteCard.classList.remove('hidden');

  // Above the emote, or below when there is no room
  const target = image.getBoundingClientRect();
  const card = dom.emoteCard.getBoundingClientRect();
  const left = Math.min(
    Math.max(CARD_GAP_PX, target.left + target.width / 2 - card.width / 2),
    innerWidth - card.width - CARD_GAP_PX,
  );
  const above = target.top - card.height - CARD_GAP_PX;
  dom.emoteCard.style.left = `${left}px`;
  dom.emoteCard.style.top = `${above >= CARD_GAP_PX ? above : target.bottom + CARD_GAP_PX}px`;
}

function hideEmoteCard() {
  dom.emoteCard.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════════

function bindEvents() {
  dom.scroller.addEventListener('scroll', handleScroll, { passive: true });
  dom.resume.addEventListener('click', () => setPinned(true));

  // Late-loading emotes and window resizes change the height — stay at the bottom when pinned
  const keepPinned = new ResizeObserver(() => {
    if (isPinned) scrollToBottom();
  });
  keepPinned.observe(dom.list);
  keepPinned.observe(dom.scroller);

  dom.list.addEventListener('click', (event) => {
    const author = event.target.closest('.author');
    if (author) {
      insertMention(author.dataset.login);
      return;
    }

    const replyButton = event.target.closest('.reply-button');
    const message = replyButton && messagesByElement.get(replyButton.closest('.message'));
    if (message) startReply(message);
  });

  dom.list.addEventListener('mouseover', (event) => {
    if (event.target.matches('img.emote')) showEmoteCard(event.target);
  });
  dom.list.addEventListener('mouseout', (event) => {
    if (event.target.matches('img.emote')) hideEmoteCard();
  });
  dom.scroller.addEventListener('scroll', hideEmoteCard, { passive: true });

  dom.twitchChat.addEventListener('click', () => {
    if (shown) window.open(`${TWITCH_POPOUT_URL}/${shown.login}/chat?popout=`, 'sd-twitch-chat');
  });

  dom.emoteButton.addEventListener('click', toggleEmotePicker);
  dom.emoteSearch.addEventListener('input', renderEmotePicker);
  dom.emoteSearch.addEventListener('keydown', handleEmoteSearchKey);
  dom.emotePickerList.addEventListener('click', (event) => {
    const item = event.target.closest('.emote-picker-item');
    if (item) insertEmote(item.dataset.name);
  });
  // A click elsewhere closes the picker
  document.addEventListener('pointerdown', (event) => {
    if (dom.emotePicker.classList.contains('hidden')) return;
    if (dom.emotePicker.contains(event.target) || dom.emoteButton.contains(event.target)) return;

    closeEmotePicker();
  });

  dom.replyCancel.addEventListener('click', cancelReply);
  dom.input.addEventListener('keydown', handleComposerKey);
  dom.form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage();
  });

  // A mouse click must not leave the button focused (focus ring on the next key press)
  document.addEventListener('click', (event) => {
    if (event.detail > 0) event.target.closest('button')?.blur();
  });

  // Dropped files or links must not replace the chat page
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (event) => event.preventDefault());
}

document.addEventListener('DOMContentLoaded', init);
