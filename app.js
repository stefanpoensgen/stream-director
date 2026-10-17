// ═══════════════════════════════════════════════════════════════════
// StreamDirector — Multiview Twitch Dashboard
// ═══════════════════════════════════════════════════════════════════

import { createAudioRelay } from './audio-relay.js';
import { createPlayer } from './player.js';

// ─── Configuration ──────────────────────────────────────────────────
const STORAGE_KEY = 'stream-director';
const DEFAULT_MAX_PLAYERS = 14;
const LIVE_CHECK_INTERVAL_MS = 60_000;
const QUALITY_BADGE_INTERVAL_MS = 2000;
const RESOLUTION_REFRESH_MS = 1000;
const RESET_WINDOW_MESSAGE = 'reset-window-size';
// Content wider than this (e.g. 3440×1440 fullscreen) puts the tiles left and right of the focus
const WIDE_ASPECT_RATIO = 2.1;
const VIDEO_ASPECT_RATIO = 16 / 9;
const GRID_GAP_PX = 4;
const DEFAULT_VOLUME = 1;
const VOLUME_STEP_PERCENT = 5;
const VOLUME_OSD_DURATION_MS = 1200;
const SPEAKER_ICON = '\u{1F50A}';
const MUTED_ICON = '\u{1F507}';
const TWITCH_LOGIN_URL = 'https://www.twitch.tv/login';
// Same rule as the host — one invalid name would make it reject every live check
const CHANNEL_NAME_PATTERN = /^[a-z0-9_]{1,25}$/;
const IS_DEV = new URL(location.href).searchParams.has('dev');

// ─── Application State ─────────────────────────────────────────────
const state = {
  channels: [], // { name, volume? } — persisted in localStorage
  liveSet: new Set(), // channel names with active players
  focus: null, // currently focused channel name
  lru: [], // LRU tracking — most recently used at end
  lastFocus: null, // previous focus for 'F' hotkey recall
  sidebarCollapsed: false, // sidebar visibility
};

// ─── Player Registry ────────────────────────────────────────────────
// One audio relay for all players, created in init() (null outside the WebView2 host)
let audioRelay = null;

// Maps channel name → { container, player, resolution, volumeOsd, volumeControl, qualityBadge: HTMLElement|null }
const players = new Map();

// Tracks which channels are actually streaming
const onlineSet = new Set();

// Channel name → { displayName, title, game, viewers, liveWith } of streaming own channels (from the live check)
const liveStreams = new Map();

// ─── DOM Cache ──────────────────────────────────────────────────────
const dom = {};

function cacheDom() {
  dom.app = document.getElementById('app');
  dom.content = document.getElementById('content');
  dom.focusEmpty = document.getElementById('focus-empty');
  dom.channelList = document.getElementById('channel-list');
  dom.channelTooltip = document.getElementById('channel-tooltip');
  dom.sidebarToggle = document.getElementById('sidebar-toggle');
  dom.addChannelForm = document.getElementById('add-channel-form');
  dom.addChannelInput = document.getElementById('add-channel-input');
  dom.twitchLogin = document.getElementById('twitch-login');
  dom.branding = document.getElementById('branding');
  dom.chatBtn = document.getElementById('chat-btn');
  dom.importBtn = document.getElementById('import-btn');
  dom.resetWindow = document.getElementById('reset-window');
  dom.importOverlay = document.getElementById('import-overlay');
  dom.importTextarea = document.getElementById('import-textarea');
  dom.importConfirm = document.getElementById('import-confirm');
  dom.importCancel = document.getElementById('import-cancel');
}

// ═══════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════

function init() {
  cacheDom();
  audioRelay = createAudioRelay();

  restoreState();
  applySidebarState();

  renderSidebar();
  syncPlayers();
  bindEvents();

  // Window resize, F11 and the sidebar change the content size — and maybe the layout kind
  new ResizeObserver(() => updateGridLayout()).observe(dom.content);

  checkAllLive();
  setInterval(checkAllLive, LIVE_CHECK_INTERVAL_MS);
  refreshLoginState();
  refreshFollowedLive();
  setInterval(refreshFollowedLive, LIVE_CHECK_INTERVAL_MS);

  setInterval(updateFocusResolution, RESOLUTION_REFRESH_MS);
  if (IS_DEV) {
    setInterval(updateQualityBadges, QUALITY_BADGE_INTERVAL_MS);
  }
}

/** Ask the host which of `names` are streaming: Map name → stream details. Returns null on failure. */
async function fetchLiveStreams(names) {
  if (names.length === 0) return new Map();

  try {
    const response = await fetch(`/api/live?channels=${names.join(',')}`);
    if (!response.ok) return null;

    const streams = await response.json();

    return new Map(streams.map((stream) => [stream.login, stream]));
  } catch {
    return null;
  }
}

function markOnline(name, stream) {
  onlineSet.add(name);
  liveStreams.set(name, stream);
}

let liveCheckRunning = false;

/** Refresh the online state of all channels; keeps the previous state on failure. */
async function checkAllLive() {
  if (liveCheckRunning) return;
  liveCheckRunning = true;

  try {
    const streams = await fetchLiveStreams(state.channels.map((channel) => channel.name));
    if (!streams) return;

    onlineSet.clear();
    liveStreams.clear();
    for (const [name, stream] of streams) {
      markOnline(name, stream);
    }
    renderSidebar();
  } finally {
    liveCheckRunning = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Persistence (localStorage)
// ═══════════════════════════════════════════════════════════════════

let saveTimer = null;

function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          channels: state.channels,
          live: [...state.liveSet],
          focus: state.focus,
          lru: state.lru,
          lastFocus: state.lastFocus,
          sidebarCollapsed: state.sidebarCollapsed,
        }),
      );
    } catch {
      /* storage full or unavailable */
    }
  }, 300);
}

function isValidChannelName(name) {
  return typeof name === 'string' && CHANNEL_NAME_PATTERN.test(name);
}

/** Saved channels are untrusted input: keep valid, unique names and in-range volumes only. */
function restoreChannels(saved) {
  if (!Array.isArray(saved)) return [];

  const seen = new Set();
  const channels = [];
  for (const entry of saved) {
    const name = entry?.name;
    if (!isValidChannelName(name) || seen.has(name)) continue;

    seen.add(name);
    const channel = { name };
    if (Number.isFinite(entry.volume)) channel.volume = Math.min(1, Math.max(0, entry.volume));
    if (entry.muted === true) channel.muted = true;
    channels.push(channel);
  }

  return channels;
}

function restoreState() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!data) return;

    state.channels = restoreChannels(data.channels);

    const valid = new Set(state.channels.map((c) => c.name));
    const knownNames = (list) => (Array.isArray(list) ? list.filter((n) => valid.has(n)) : []);

    state.lru = knownNames(data.lru);
    state.liveSet = new Set(knownNames(data.live));
    state.focus = valid.has(data.focus) ? data.focus : null;
    state.lastFocus = valid.has(data.lastFocus) ? data.lastFocus : null;
    state.sidebarCollapsed = data.sidebarCollapsed === true;

    // Trim live set to max
    while (state.liveSet.size > DEFAULT_MAX_PLAYERS) {
      const victim = findEvictionTarget();
      if (!victim) break;
      state.liveSet.delete(victim);
    }
  } catch {
    /* ignore corrupt data */
  }
}

// ═══════════════════════════════════════════════════════════════════
// LRU Management
// ═══════════════════════════════════════════════════════════════════

/** Move channel to the "most recently used" end of the LRU list. */
function touchLru(name) {
  const idx = state.lru.indexOf(name);
  if (idx !== -1) state.lru.splice(idx, 1);
  state.lru.push(name);
}

/** Find the least-recently-used live channel that isn't the current focus. */
function findEvictionTarget() {
  // Walk LRU from oldest → newest
  for (const name of state.lru) {
    if (state.liveSet.has(name) && name !== state.focus) return name;
  }
  // Fallback: any live channel that isn't focus
  for (const name of state.liveSet) {
    if (name !== state.focus) return name;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Live Slot Management
// ═══════════════════════════════════════════════════════════════════

function addLive(name) {
  if (state.liveSet.has(name)) return;

  // Evict if at capacity
  while (state.liveSet.size >= DEFAULT_MAX_PLAYERS) {
    const victim = findEvictionTarget();
    if (!victim) break;
    removeLive(victim);
  }

  state.liveSet.add(name);
  touchLru(name);
}

function removeLive(name) {
  state.liveSet.delete(name);
  if (state.focus === name) state.focus = null;
  // DOM cleanup is handled by syncPlayers in the correct order
}

function toggleLive(name) {
  if (state.liveSet.has(name)) {
    removeLive(name);
    // Auto-focus another live channel if the focused one was toggled off
    if (!state.focus) {
      const next = getOrderedLiveChannels()[0];
      if (next) state.focus = next;
    }
  } else {
    addLive(name);
    // Nothing in focus yet (e.g. the first channel) — the activated channel takes it
    if (!state.focus) state.focus = name;
  }
  syncPlayers();
  renderSidebar();
  saveState();
}

// ═══════════════════════════════════════════════════════════════════
// Focus Management
// ═══════════════════════════════════════════════════════════════════

function setFocus(name) {
  if (state.focus === name) return;

  // Remember previous focus for 'F' recall
  if (state.focus) state.lastFocus = state.focus;

  // Auto-activate if not live
  if (!state.liveSet.has(name)) addLive(name);

  state.focus = name;
  touchLru(name);

  followFocusInChat();

  syncPlayers();
  renderSidebar();
  saveState();
}

/** Cycle focus through live tiles (direction: +1 or -1). */
function cycleFocus(direction) {
  const ordered = getOrderedLiveChannels();
  if (ordered.length === 0) return;

  const idx = ordered.indexOf(state.focus);
  const next = idx === -1 ? 0 : mod(idx + direction, ordered.length);
  setFocus(ordered[next]);
}

/** Recall last focused channel. */
function recallFocus() {
  if (state.lastFocus && state.channels.some((c) => c.name === state.lastFocus)) {
    setFocus(state.lastFocus);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Channel Management (add / remove)
// ═══════════════════════════════════════════════════════════════════

/** Add a new channel to the pool. Returns true on success. */
function addChannel(name) {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '');
  if (!isValidChannelName(normalized)) return false;
  if (state.channels.some((c) => c.name === normalized)) return false;

  state.channels.push({ name: normalized });
  fetchLiveStreams([normalized]).then((streams) => {
    const stream = streams?.get(normalized);
    if (stream) markOnline(normalized, stream);
    renderSidebar();
  });
  renderSidebar();
  saveState();
  return true;
}

/** Import channels from a newline/comma-separated string. Returns count added. */
function importChannels(text) {
  const names = text
    .split(/[\n,]+/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ''))
    .filter(isValidChannelName);

  const existing = new Set(state.channels.map((c) => c.name));
  let added = 0;
  for (const name of names) {
    if (!existing.has(name)) {
      state.channels.push({ name });
      existing.add(name);
      added++;
    }
  }

  if (added > 0) {
    renderSidebar();
    saveState();
    checkAllLive();
  }
  return added;
}

function showImportModal() {
  dom.importOverlay.classList.remove('hidden');
  dom.importTextarea.value = '';
  dom.importTextarea.focus();
}

function hideImportModal() {
  dom.importOverlay.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// Twitch Login (the host keeps the session; Turbo removes ads on all streams)
// ═══════════════════════════════════════════════════════════════════

let isLoggedIn = false;

/** Ask the host whether a Twitch login exists and label the button accordingly. */
async function refreshLoginState() {
  try {
    const response = await fetch('/api/auth');
    if (!response.ok) return;

    ({ loggedIn: isLoggedIn } = await response.json());
  } catch {
    return;
  }

  dom.twitchLogin.textContent = isLoggedIn ? 'Twitch logout' : 'Twitch login';
  dom.twitchLogin.title = isLoggedIn ? 'Log out of Twitch' : 'Log in with your Twitch account';
}

// ═══════════════════════════════════════════════════════════════════
// Followed & live — a separate Twitch connection with the follows
// permission (the website login cannot read follows)
// ═══════════════════════════════════════════════════════════════════

const CONNECT_POLL_INTERVAL_MS = 3000;
const CONNECT_POLL_DURATION_MS = 5 * 60_000;

/** All followed channels: { login, live } plus, when live, { displayName, title, game, viewers, liveWith }. Not persisted. */
let followedChannels = [];
let followedConnected = false;
/** Code to confirm on Twitch while connecting, else null. */
let followedPendingCode = null;
/** Why loading failed (host/Twitch message), null when the last load worked. */
let followedError = null;
let connectPollTimer = null;

async function refreshFollowedLive() {
  try {
    const response = await fetch('/api/follows');
    if (response.ok) {
      const result = await response.json();
      followedConnected = result.connected;
      followedChannels = result.channels ?? [];
      followedError = null;
      if (followedConnected) stopConnectPolling();
    } else {
      followedError = (await response.text()) || `HTTP ${response.status}`;
    }
  } catch (error) {
    followedError = error.message;
  }
  renderSidebar();
}

/** Starts Twitch's device login: the host opens the confirmation page in its own window. */
async function connectFollows() {
  try {
    const response = await fetch('/api/follows/connect', { method: 'POST' });
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);

    const { userCode, verificationUri } = await response.json();
    followedPendingCode = userCode;
    followedError = null;
    renderSidebar();
    window.open(verificationUri, '_blank');
    startConnectPolling();
  } catch (error) {
    followedError = error.message;
    renderSidebar();
  }
}

function startConnectPolling() {
  stopConnectPolling();
  const giveUpAt = Date.now() + CONNECT_POLL_DURATION_MS;

  connectPollTimer = setInterval(() => {
    if (Date.now() > giveUpAt) {
      stopConnectPolling();
      followedPendingCode = null;
      renderSidebar();
      return;
    }
    refreshFollowedLive();
  }, CONNECT_POLL_INTERVAL_MS);
}

function stopConnectPolling() {
  clearInterval(connectPollTimer);
  connectPollTimer = null;
}

function formatViewers(viewers) {
  return viewers >= 1000 ? `${(viewers / 1000).toFixed(1)}k` : String(viewers);
}

/** Takes a followed channel into the own list and starts it — in focus or as a tile. */
function addFollowed(login, { focus }) {
  if (!addChannel(login)) return;

  if (focus) setFocus(login);
  else toggleLive(login);
}

/** Followed channel that is not in the own list yet: same row, marked with ♥. */
function createFollowedRow({ login, live }) {
  const li = document.createElement('li');
  li.className = 'channel-item is-followed';
  li.dataset.channel = login;

  // Live rows get the channel tooltip instead
  if (!live) li.title = 'Followed on Twitch';

  const toggle = document.createElement('label');
  toggle.className = 'live-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', () => addFollowed(login, { focus: false }));
  const track = document.createElement('span');
  track.className = 'toggle-track';
  const thumb = document.createElement('span');
  thumb.className = 'toggle-thumb';
  toggle.append(checkbox, track, thumb);

  const mark = document.createElement('span');
  mark.className = 'followed-mark';
  mark.textContent = '\u2665';

  const nameBtn = document.createElement('button');
  nameBtn.className = 'channel-name';
  nameBtn.textContent = login;
  nameBtn.addEventListener('click', () => addFollowed(login, { focus: true }));

  li.append(toggle, mark, nameBtn);
  if (live) {
    const liveBadge = document.createElement('span');
    liveBadge.className = 'live-badge';
    liveBadge.textContent = 'LIVE';
    li.append(liveBadge);
  }

  return li;
}

function createErrorLine(message) {
  const line = document.createElement('span');
  line.className = 'followed-error';
  line.textContent = message;

  return line;
}

/** Last row of the list: connect the follows, the code to confirm, or why loading failed. */
function createFollowedStatusRow() {
  const li = document.createElement('li');
  li.className = 'followed-status';

  if (followedConnected) {
    if (!followedError) return null;

    li.textContent = "Couldn't load followed channels";
    li.append(createErrorLine(followedError));
    return li;
  }

  if (followedPendingCode) {
    li.textContent = `Confirm on Twitch (code ${followedPendingCode})…`;
    return li;
  }

  const connectBtn = document.createElement('button');
  connectBtn.className = 'followed-connect';
  connectBtn.textContent = '\u2665 Show followed channels';
  connectBtn.addEventListener('click', connectFollows);
  li.append(connectBtn);
  if (followedError) li.append(createErrorLine(followedError));

  return li;
}

/** Login opens Twitch's login page; logout drops the session and restarts the streams anonymously. */
async function toggleLogin() {
  if (!isLoggedIn) {
    window.open(TWITCH_LOGIN_URL, '_blank');
    return;
  }

  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

let chatWindow = null;

function focusChatUrl() {
  return `https://www.twitch.tv/popout/${state.focus}/chat?popout=`;
}

/** Open the Twitch chat popup for the focused channel, or bring the open one to the front. */
function openChat() {
  if (!state.focus) return;

  if (chatWindow && !chatWindow.closed) {
    chatWindow.location = focusChatUrl();
    chatWindow.focus();
  } else {
    chatWindow = window.open(focusChatUrl(), 'sd-chat');
  }
}

/** An open chat popup follows the focus — without focusing it, the hotkeys must stay with the app. */
function followFocusInChat() {
  if (chatWindow && !chatWindow.closed) chatWindow.location = focusChatUrl();
}

/** Remove a channel from the pool and clean up any live/focus state. */
function removeChannel(name) {
  const idx = state.channels.findIndex((c) => c.name === name);
  if (idx === -1) return;

  const wasFocus = state.focus === name;

  // Clean up if this channel is live or focused
  if (state.liveSet.has(name)) removeLive(name);
  if (state.focus === name) state.focus = null;
  if (state.lastFocus === name) state.lastFocus = null;
  state.lru = state.lru.filter((n) => n !== name);

  state.channels.splice(idx, 1);
  const li = sidebarItems.get(name);
  if (li) {
    li.remove();
    sidebarItems.delete(name);
  }

  // Auto-focus another live channel if the focused one was removed
  if (wasFocus && !state.focus) {
    const next = getOrderedLiveChannels()[0];
    if (next) state.focus = next;
  }

  syncPlayers();
  renderSidebar();
  saveState();
}

// ═══════════════════════════════════════════════════════════════════
// Volume (per channel, remembered — streamers differ in loudness)
// ═══════════════════════════════════════════════════════════════════

function getChannelVolume(name) {
  return state.channels.find((c) => c.name === name)?.volume ?? DEFAULT_VOLUME;
}

function isChannelMuted(name) {
  return state.channels.find((c) => c.name === name)?.muted === true;
}

/** What the player plays: the set volume, or silence while muted (the volume is kept for unmuting). */
function getAudibleVolume(name) {
  return isChannelMuted(name) ? 0 : getChannelVolume(name);
}

function setChannelVolume(name, volume) {
  const channel = state.channels.find((c) => c.name === name);
  if (!channel) return;

  // Snap to whole-percent steps — no float drift from repeated ↑/↓
  const percent = Math.round((volume * 100) / VOLUME_STEP_PERCENT) * VOLUME_STEP_PERCENT;
  channel.volume = Math.min(100, Math.max(0, percent)) / 100;
  channel.muted = false; // changing the volume unmutes, as in Windows or YouTube

  applyChannelAudio(name);

  // Only the controls — a full renderSidebar() re-appends rows and breaks an ongoing drag
  syncVolumeControls(name);
  saveState();
}

function toggleMute(name) {
  const channel = state.channels.find((c) => c.name === name);
  if (!channel) return;

  channel.muted = !channel.muted;
  applyChannelAudio(name);
  syncVolumeControls(name);
  saveState();
}

function toggleFocusMute() {
  if (state.focus) toggleMute(state.focus);
}

/** Hands the audible volume to the player and shows it briefly on the focus. */
function applyChannelAudio(name) {
  const entry = players.get(name);
  if (!entry) return;

  entry.player.setVolume(getAudibleVolume(name));
  if (name === state.focus) showVolumeOsd(entry, formatVolume(name));
}

/** Adjust the focused channel's volume (direction: +1 or -1). */
function stepFocusVolume(direction) {
  if (!state.focus) return;

  setChannelVolume(
    state.focus,
    getChannelVolume(state.focus) + (direction * VOLUME_STEP_PERCENT) / 100,
  );
}

/** Range input 0–100 % bound to a channel's volume (focus overlay). */
function createVolumeSlider(name) {
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'volume-control-slider';
  slider.min = '0';
  slider.max = '100';
  slider.step = String(VOLUME_STEP_PERCENT);
  slider.addEventListener('input', () => setChannelVolume(name, slider.value / 100));

  // Hand the keyboard back to the hotkeys (←/→ would otherwise move the slider)
  slider.addEventListener('change', () => slider.blur());

  return slider;
}

/** Update the focus overlay showing a channel's volume. */
function syncVolumeControls(name) {
  const percent = String(Math.round(getChannelVolume(name) * 100));
  const muted = isChannelMuted(name);
  const label = formatVolume(name);

  const overlay = players.get(name)?.volumeControl;
  if (overlay) {
    overlay.slider.value = percent;
    overlay.slider.classList.toggle('is-muted', muted);
    overlay.label.textContent = label;
    overlay.muteButton.textContent = muted ? MUTED_ICON : SPEAKER_ICON;
    overlay.muteButton.title = muted ? 'Unmute (M)' : 'Mute (M)';
  }
}

function formatVolume(name) {
  if (isChannelMuted(name)) return `${MUTED_ICON} muted`;

  const percent = Math.round(getChannelVolume(name) * 100);

  return `${percent === 0 ? MUTED_ICON : SPEAKER_ICON} ${percent} %`;
}

function showVolumeOsd(entry, text) {
  const osd = entry.volumeOsd;
  osd.textContent = text;
  osd.classList.add('is-visible');

  clearTimeout(osd._hideTimer);
  osd._hideTimer = setTimeout(() => osd.classList.remove('is-visible'), VOLUME_OSD_DURATION_MS);
}

// ═══════════════════════════════════════════════════════════════════
// Sidebar Collapse
// ═══════════════════════════════════════════════════════════════════

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  applySidebarState();
  saveState();
}

function applySidebarState() {
  const isOpen = !state.sidebarCollapsed;
  dom.app.classList.toggle('sidebar-collapsed', !isOpen);

  // The button says what it does next — "Menu" alone did not tell that it also closes the menu
  dom.sidebarToggle.textContent = isOpen ? 'Hide menu' : 'Menu';
  dom.sidebarToggle.title = isOpen ? 'Hide the channel list (S)' : 'Show the channel list (S)';
  dom.sidebarToggle.classList.toggle('is-active', isOpen);
}

// ═══════════════════════════════════════════════════════════════════
// Player Lifecycle
// ═══════════════════════════════════════════════════════════════════

/**
 * Update CSS Grid layout. Wide content (see WIDE_ASPECT_RATIO) uses layoutWide();
 * everything else the L-shape arrangement made for 1920×1080 OBS capture:
 *
 * - Left column:  240px wide, full height, tiles stacked vertically
 * - Focus:        remaining width × 945px (16:9), top-right area
 * - Bottom row:   135px height, tiles from col 2 onward
 * - Bottom-left:  (col 1, last row) kept empty for facecam overlay
 *
 * Content area = 1920 − sidebar. With sidebar collapsed the grid
 * stretches; the left column stays 240px, focus fills the rest.
 */
function updateGridLayout() {
  const focusName = state.focus;
  const ordered = getOrderedLiveChannels();
  const tileNames = ordered.filter((n) => n !== focusName);
  const n = tileNames.length;
  const hasFocus = focusName && players.has(focusName);

  // Reset inline grid placement on all players
  for (const [, entry] of players) {
    const s = entry.container.style;
    s.gridRow = '';
    s.gridColumn = '';
    s.order = '';
  }

  dom.content.style.gridAutoRows = '';

  // ── Branding always in bottom-left (last row, col 1) ──
  // All branches below must set brandingRow before the end.

  // No players at all
  if (!hasFocus && n === 0) {
    dom.content.style.gridTemplateColumns = '240px 1fr';
    dom.content.style.gridTemplateRows = '1fr 135px';
    dom.branding.style.gridRow = '2';
    dom.branding.style.gridColumn = '1';
    return;
  }

  // Tiles only (no focus) → simple balanced grid
  if (!hasFocus) {
    const cols = Math.min(n, 5);
    dom.content.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    dom.content.style.gridTemplateRows = '1fr 135px';
    dom.content.style.gridAutoRows = '';
    dom.branding.style.gridRow = '2';
    dom.branding.style.gridColumn = '1';
    return;
  }

  if (isWideLayout()) {
    layoutWide(focusName, tileNames);
    return;
  }

  // Focus only (no tiles)
  if (n === 0) {
    dom.content.style.gridTemplateColumns = '240px 1fr';
    dom.content.style.gridTemplateRows = '1fr 135px';
    const fe = players.get(focusName);
    fe.container.style.gridRow = '1';
    fe.container.style.gridColumn = '1 / -1';
    dom.branding.style.gridRow = '2';
    dom.branding.style.gridColumn = '1';
    return;
  }

  // ── Focus + tiles → L-shape layout ──
  // Tiles alternate left/bottom until left has 7, then all to bottom.
  // Left rows are 1fr (stretch to fill), bottom row fixed 135px.

  const leftCount = Math.min(Math.ceil(n / 2), 7);
  const bottomCount = n - leftCount;

  // Right columns: at least 6 so bottom tiles stay close to 16:9 at 135px
  const rightCols = bottomCount > 0 ? Math.max(bottomCount, 6) : 1;

  dom.content.style.gridTemplateColumns = `240px repeat(${rightCols}, 1fr)`;

  // 8 equal rows: 7 for left tiles/focus, 1 for bottom tiles/branding.
  // All tiles get the same height (~131px at 1080p).
  const TOTAL_ROWS = 8;

  dom.content.style.gridTemplateRows = `repeat(${TOTAL_ROWS}, 1fr)`;

  // Focus spans all right columns, all left rows
  const fe = players.get(focusName);
  fe.container.style.gridColumn = '2 / -1';
  fe.container.style.gridRow = `1 / ${TOTAL_ROWS}`;

  let idx = 0;

  // Left column tiles — col 1, one per row
  for (let i = 0; i < leftCount; i++) {
    const entry = players.get(tileNames[idx++]);
    if (entry) {
      entry.container.style.gridColumn = '1';
      entry.container.style.gridRow = `${i + 1}`;
    }
  }

  // Bottom row tiles — 135px tall, col 2+
  const bottomRow = TOTAL_ROWS;
  for (let i = 0; i < bottomCount; i++) {
    const entry = players.get(tileNames[idx++]);
    if (entry) {
      entry.container.style.gridRow = `${bottomRow}`;
      entry.container.style.gridColumn = `${i + 2}`;
    }
  }

  // Branding in bottom-left
  dom.branding.style.gridRow = `${bottomRow}`;
  dom.branding.style.gridColumn = '1';
}

function isWideLayout() {
  const { clientWidth, clientHeight } = dom.content;

  return clientHeight > 0 && clientWidth / clientHeight >= WIDE_ASPECT_RATIO;
}

/**
 * Wide screens: focus centered at full height in 16:9, tiles alternating left and
 * right in one column each, branding at the bottom of the left column.
 */
function layoutWide(focusName, tileNames) {
  const { clientWidth: width, clientHeight: height } = dom.content;
  const focusWidth = Math.min(width - 2 * GRID_GAP_PX, Math.round(height * VIDEO_ASPECT_RATIO));
  const sideWidth = Math.max(0, (width - focusWidth - 2 * GRID_GAP_PX) / 2);

  const leftTiles = Math.ceil(tileNames.length / 2);
  const rightTiles = Math.floor(tileNames.length / 2);

  // As many rows as 16:9 tiles of the side width fit; more only when the tiles need them
  const fittingRows = Math.max(
    1,
    Math.floor(height / (sideWidth / VIDEO_ASPECT_RATIO + GRID_GAP_PX)),
  );
  const rows = Math.max(fittingRows, leftTiles + 1, rightTiles);

  dom.content.style.gridTemplateColumns = `minmax(0, 1fr) ${focusWidth}px minmax(0, 1fr)`;
  dom.content.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  const focus = players.get(focusName).container.style;
  focus.gridColumn = '2';
  focus.gridRow = '1 / -1';

  tileNames.forEach((name, index) => {
    const style = players.get(name)?.container.style;
    if (!style) return;

    style.gridColumn = index % 2 === 0 ? '1' : '3';
    style.gridRow = String(Math.floor(index / 2) + 1);
  });

  dom.branding.style.gridColumn = '1';
  dom.branding.style.gridRow = String(rows);
}

/**
 * Reconcile DOM players with desired state.
 * All players are direct children of .content (CSS Grid).
 * L-shape layout — pure class toggle, players are never re-parented.
 */
function syncPlayers() {
  const shouldBeFocus = state.focus;

  // 1. Detach stale players from map, hide containers (no grid reflow yet)
  const staleContainers = [];
  for (const name of [...players.keys()]) {
    if (!state.liveSet.has(name)) {
      const entry = players.get(name);
      entry.player.destroy();
      entry.container.style.display = 'none';
      staleContainers.push(entry.container);
      players.delete(name);
    }
  }

  // 2. Create missing live players
  const ordered = getOrderedLiveChannels();
  for (const name of ordered) {
    if (!players.has(name)) {
      createPlayerSlot(name);
    }
  }

  // 3. Toggle focus / tile CSS classes, quality and audio
  for (const [name, entry] of players) {
    const isFocus = name === shouldBeFocus;
    entry.container.classList.toggle('is-focus', isFocus);
    entry.container.classList.toggle('is-tile', !isFocus);
    entry.player.setFocused(isFocus);
  }

  // 4. Update grid layout (stale containers are hidden, won't affect layout)
  updateGridLayout();

  // 5. Remove stale containers from DOM after grid is stable
  for (const el of staleContainers) {
    el.remove();
  }

  // 6. Toggle empty state
  dom.focusEmpty.classList.toggle('hidden', players.size > 0);
}

function createPlayerSlot(name) {
  const container = document.createElement('div');
  container.className = 'player-slot is-tile';
  container.dataset.channel = name;

  // Click to focus (setFocus short-circuits if already focused)
  container.addEventListener('click', () => setFocus(name));

  // Label overlay
  const label = document.createElement('div');
  label.className = 'player-label';
  // Many channels are easier to recognize by their profile image than by name
  const avatar = document.createElement('img');
  avatar.className = 'player-avatar';
  avatar.src = `/api/avatar/${name}`;
  avatar.alt = '';
  avatar.addEventListener('error', () => avatar.remove());
  label.append(avatar, name);
  // Shown with the name while hovering the focus (see updateFocusResolution)
  const resolution = document.createElement('span');
  resolution.className = 'player-resolution';
  label.appendChild(resolution);
  container.appendChild(label);

  // Offline badge
  const badge = document.createElement('div');
  badge.className = 'player-badge hidden';
  badge.textContent = 'OFFLINE';
  container.appendChild(badge);

  // Volume indicator, briefly shown on ↑/↓
  const volumeOsd = document.createElement('div');
  volumeOsd.className = 'volume-osd';
  container.appendChild(volumeOsd);

  // Volume overlay, visible while hovering the focus
  const volumeControl = {
    element: document.createElement('div'),
    muteButton: document.createElement('button'),
    slider: createVolumeSlider(name),
    label: document.createElement('span'),
  };
  volumeControl.element.className = 'volume-control';
  volumeControl.muteButton.className = 'volume-control-mute';
  volumeControl.muteButton.addEventListener('click', () => toggleMute(name));
  volumeControl.label.className = 'volume-control-label';
  volumeControl.element.append(volumeControl.muteButton, volumeControl.slider, volumeControl.label);
  container.appendChild(volumeControl.element);

  // Quality debug badge (dev mode only)
  let qualityBadge = null;
  if (IS_DEV) {
    qualityBadge = document.createElement('div');
    qualityBadge.className = 'quality-badge';
    container.appendChild(qualityBadge);
  }

  // All players are direct grid children of .content
  dom.content.appendChild(container);

  const player = createPlayer(name, container, {
    audioRelay,
    onOnline() {
      badge.classList.add('hidden');
      onlineSet.add(name);
      renderSidebar();
    },
    onOffline() {
      badge.textContent = 'OFFLINE';
      badge.classList.remove('hidden');
      onlineSet.delete(name);
      liveStreams.delete(name);
      renderSidebar();
    },
    onUnavailable() {
      // Live, but Twitch refuses playback (subscriber-only, geo-blocked)
      badge.textContent = 'UNAVAILABLE';
      badge.classList.remove('hidden');
    },
  });

  player.setVolume(getAudibleVolume(name));

  players.set(name, { container, player, resolution, volumeOsd, volumeControl, qualityBadge });
  syncVolumeControls(name);
}

// ═══════════════════════════════════════════════════════════════════
// Resolution on the focus label + quality debug badge (dev mode)
// ═══════════════════════════════════════════════════════════════════

/** The focus label shows the rendition on screen — it changes from 360p to source after a switch. */
function updateFocusResolution() {
  const entry = players.get(state.focus);
  if (!entry) return;

  const rendition = entry.player.resolutionLabel();
  entry.resolution.textContent = rendition ? ` · ${rendition}` : '';
}

function updateQualityBadges() {
  for (const [, entry] of players) {
    entry.qualityBadge.textContent = entry.player.qualityLabel();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Sidebar Rendering
// ═══════════════════════════════════════════════════════════════════

/** Map of channel name → sidebar <li> element for DOM diffing. */
const sidebarItems = new Map();

/** Rows of followed channels and the status row — rebuilt on every render, they are few. */
let followedRows = [];

function renderSidebar() {
  const ownNames = new Set(state.channels.map((c) => c.name));
  const followedNames = new Set(followedConnected ? followedChannels.map((c) => c.login) : []);
  const followedOnly = followedConnected
    ? followedChannels.filter((channel) => !ownNames.has(channel.login))
    : [];

  // One list: own channels plus followed channels that are not in the list yet.
  // Sort: online (streaming) first, then active players, then own before followed
  // (own offline channels must not drown in many follows) — alpha within each
  const rows = [
    ...state.channels.map((c) => ({ name: c.name, online: onlineSet.has(c.name), followed: null })),
    ...followedOnly.map((f) => ({ name: f.login, online: f.live, followed: f })),
  ].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const aLive = state.liveSet.has(a.name);
    const bLive = state.liveSet.has(b.name);
    if (aLive !== bLive) return aLive ? -1 : 1;
    if (!a.followed !== !b.followed) return a.followed ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  // Remove items no longer in channel list
  for (const [name, li] of sidebarItems) {
    if (!ownNames.has(name)) {
      li.remove();
      sidebarItems.delete(name);
    }
  }
  for (const li of followedRows) li.remove();
  followedRows = [];

  for (const row of rows) {
    if (row.followed) {
      const li = createFollowedRow(row.followed);
      followedRows.push(li);
      dom.channelList.appendChild(li);
      continue;
    }

    let li = sidebarItems.get(row.name);
    if (!li) {
      li = createSidebarItem(row.name);
      sidebarItems.set(row.name, li);
    }

    const isLive = state.liveSet.has(row.name);
    li.classList.toggle('is-live', isLive);
    li.classList.toggle('is-focus', state.focus === row.name);
    li._checkbox.checked = isLive;
    syncVolumeControls(row.name);
    li._liveBadge.classList.toggle('hidden', !row.online);
    // Removing a followed channel would only bring it back as a ♥ row (losing its volume)
    li._deleteButton.classList.toggle('is-unavailable', followedNames.has(row.name));

    // Append in sorted order (moves existing nodes without recreating)
    dom.channelList.appendChild(li);
  }

  const statusRow = createFollowedStatusRow();
  if (statusRow) {
    followedRows.push(statusRow);
    dom.channelList.appendChild(statusRow);
  }

  // Rows were moved or rebuilt — the tooltip would point at the wrong one
  hideChannelTooltip();
}

function createSidebarItem(name) {
  const li = document.createElement('li');
  li.className = 'channel-item';
  li.dataset.channel = name;

  // Live toggle
  const toggle = document.createElement('label');
  toggle.className = 'live-toggle';
  toggle.title = 'Toggle player';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.addEventListener('change', () => toggleLive(name));

  const track = document.createElement('span');
  track.className = 'toggle-track';
  const thumb = document.createElement('span');
  thumb.className = 'toggle-thumb';

  toggle.append(checkbox, track, thumb);

  // Channel name button
  const nameBtn = document.createElement('button');
  nameBtn.className = 'channel-name';
  nameBtn.textContent = name;
  nameBtn.addEventListener('click', () => setFocus(name));

  // Live badge
  const liveBadge = document.createElement('span');
  liveBadge.className = 'live-badge hidden';
  liveBadge.textContent = 'LIVE';

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'channel-delete';
  delBtn.title = 'Remove channel';
  delBtn.textContent = '\u00d7';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeChannel(name);
  });

  // Delete before the badge: appearing on hover, it takes room from the name and the badge stays put
  li.append(toggle, nameBtn, delBtn, liveBadge);

  // Store refs for fast updates
  li._checkbox = checkbox;
  li._liveBadge = liveBadge;
  li._deleteButton = delBtn;

  return li;
}

// ═══════════════════════════════════════════════════════════════════
// Channel tooltip — what a live channel streams, like Twitch's sidebar
// ═══════════════════════════════════════════════════════════════════

const TOOLTIP_GAP_PX = 8;

function findLiveStream(name) {
  return (
    liveStreams.get(name) ??
    followedChannels.find((channel) => channel.login === name && channel.live) ??
    null
  );
}

function createTooltipLine(className, text) {
  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;

  return line;
}

/** Stream Together partner: name, and viewers when the partner streams too. */
function createLiveWithLine({ displayName, viewers }) {
  const line = createTooltipLine('channel-tooltip-partner', displayName);
  if (viewers != null) {
    line.append(createTooltipLine('channel-tooltip-partner-viewers', formatViewers(viewers)));
  }

  return line;
}

/**
 * "Name · Category", the stream title, "● Live | 513 viewers" and the
 * Stream Together partners ("Live with") next to the hovered row.
 */
function showChannelTooltip(row) {
  const stream = findLiveStream(row.dataset.channel);
  if (!stream) {
    hideChannelTooltip();
    return;
  }

  const heading = [stream.displayName || stream.login, stream.game].filter(Boolean).join(' · ');
  const lines = [createTooltipLine('channel-tooltip-heading', heading)];
  if (stream.title) lines.push(createTooltipLine('channel-tooltip-title', stream.title));
  lines.push(
    createTooltipLine('channel-tooltip-status', `Live | ${formatViewers(stream.viewers)} viewers`),
  );
  if (stream.liveWith) {
    lines.push(createTooltipLine('channel-tooltip-section', 'Live with:'));
    lines.push(...stream.liveWith.map(createLiveWithLine));
  }

  const tooltip = dom.channelTooltip;
  tooltip.replaceChildren(...lines);
  tooltip.classList.remove('hidden');

  // Beside the row, kept inside the window
  const rowBounds = row.getBoundingClientRect();
  const maxTop = innerHeight - tooltip.offsetHeight - TOOLTIP_GAP_PX;
  tooltip.style.left = `${rowBounds.right + TOOLTIP_GAP_PX}px`;
  tooltip.style.top = `${Math.max(TOOLTIP_GAP_PX, Math.min(rowBounds.top, maxTop))}px`;
}

function hideChannelTooltip() {
  dom.channelTooltip.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// Event Binding
// ═══════════════════════════════════════════════════════════════════

function bindEvents() {
  // Add channel form
  dom.addChannelForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = dom.addChannelInput;
    if (addChannel(input.value)) {
      input.value = '';
    } else {
      // Brief visual error feedback
      input.classList.add('input-error');
      setTimeout(() => input.classList.remove('input-error'), 400);
    }
  });

  dom.channelList.addEventListener('mouseover', (event) => {
    const row = event.target.closest('[data-channel]');
    if (row) showChannelTooltip(row);
    else hideChannelTooltip();
  });
  dom.channelList.addEventListener('mouseleave', hideChannelTooltip);

  // Sidebar toggle
  dom.sidebarToggle.addEventListener('click', toggleSidebar);
  dom.twitchLogin.addEventListener('click', toggleLogin);
  dom.chatBtn.addEventListener('click', openChat);

  // Reset window size — handled by the host window, so only offered inside it
  const host = window.chrome?.webview;
  dom.resetWindow.classList.toggle('hidden', !host);
  dom.resetWindow.addEventListener('mouseenter', () => {
    dom.resetWindow.title = `Back to a 1920×1080 window, e.g. after resizing (now ${innerWidth}×${innerHeight})`;
  });
  dom.resetWindow.addEventListener('click', () => host.postMessage(RESET_WINDOW_MESSAGE));

  // Import
  dom.importBtn.addEventListener('click', showImportModal);
  dom.importCancel.addEventListener('click', hideImportModal);
  dom.importOverlay.addEventListener('click', (e) => {
    if (e.target === dom.importOverlay) hideImportModal();
  });
  dom.importConfirm.addEventListener('click', () => {
    importChannels(dom.importTextarea.value);
    hideImportModal();
  });

  // Global hotkeys
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dom.importOverlay.classList.contains('hidden')) {
      hideImportModal();
      return;
    }
    handleHotkey(e);
  });
}

function handleHotkey(e) {
  // Ignore when typing in inputs
  if (e.target.matches('input, textarea, select')) return;

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      cycleFocus(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      cycleFocus(1);
      break;
    case 'f':
    case 'F':
      e.preventDefault();
      recallFocus();
      break;
    case 's':
    case 'S':
      e.preventDefault();
      toggleSidebar();
      break;
    case 'ArrowUp':
      e.preventDefault();
      stepFocusVolume(1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      stepFocusVolume(-1);
      break;
    case 'c':
    case 'C':
      e.preventDefault();
      openChat();
      break;
    case 'm':
    case 'M':
      e.preventDefault();
      toggleFocusMute();
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/** Returns live channel names ordered by their position in the channel list. */
function getOrderedLiveChannels() {
  return state.channels.map((c) => c.name).filter((n) => state.liveSet.has(n));
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

// ═══════════════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
