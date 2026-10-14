// ═══════════════════════════════════════════════════════════════════
// StreamDirector — Multiview Twitch Dashboard
// ═══════════════════════════════════════════════════════════════════

import { createPlayer } from './player.js';

// ─── Configuration ──────────────────────────────────────────────────
const STORAGE_KEY = 'stream-director';
const DEFAULT_MAX_PLAYERS = 14;
const LIVE_CHECK_INTERVAL_MS = 60_000;
const QUALITY_BADGE_INTERVAL_MS = 2000;
const IS_DEV = new URL(location.href).searchParams.has('dev');

// ─── Application State ─────────────────────────────────────────────
const state = {
  channels: [], // persisted in localStorage
  liveSet: new Set(), // channel names with active players
  focus: null, // currently focused channel name
  lru: [], // LRU tracking — most recently used at end
  lastFocus: null, // previous focus for 'F' hotkey recall
  sidebarCollapsed: false, // sidebar visibility
};

// ─── Player Registry ────────────────────────────────────────────────
// Maps channel name → { container: HTMLElement, player, qualityBadge: HTMLElement|null }
const players = new Map();

// Tracks which channels are actually streaming
const onlineSet = new Set();

// ─── DOM Cache ──────────────────────────────────────────────────────
const dom = {};

function cacheDom() {
  dom.app = document.getElementById('app');
  dom.content = document.getElementById('content');
  dom.focusEmpty = document.getElementById('focus-empty');
  dom.channelList = document.getElementById('channel-list');
  dom.sidebarToggle = document.getElementById('sidebar-toggle');
  dom.addChannelForm = document.getElementById('add-channel-form');
  dom.addChannelInput = document.getElementById('add-channel-input');
  dom.twitchLogin = document.getElementById('twitch-login');
  dom.branding = document.getElementById('branding');
  dom.chatBtn = document.getElementById('chat-btn');
  dom.closeBtn = document.getElementById('close-btn');
  dom.importBtn = document.getElementById('import-btn');
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

  restoreState();
  applySidebarState();

  renderSidebar();
  syncPlayers();
  bindEvents();

  checkAllLive();
  setInterval(checkAllLive, LIVE_CHECK_INTERVAL_MS);

  if (IS_DEV) {
    setInterval(updateQualityBadges, QUALITY_BADGE_INTERVAL_MS);
  }
}

/** Ask the main process which of `names` are streaming. Returns null on failure. */
async function fetchLiveChannels(names) {
  if (names.length === 0) return new Set();

  try {
    const response = await fetch(`/api/live?channels=${names.join(',')}`);
    if (!response.ok) return null;

    return new Set(await response.json());
  } catch {
    return null;
  }
}

let liveCheckRunning = false;

/** Refresh the online state of all channels; keeps the previous state on failure. */
async function checkAllLive() {
  if (liveCheckRunning) return;
  liveCheckRunning = true;

  try {
    const liveNames = await fetchLiveChannels(state.channels.map((channel) => channel.name));
    if (!liveNames) return;

    onlineSet.clear();
    for (const name of liveNames) {
      onlineSet.add(name);
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

function restoreState() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!data) return;

    if (Array.isArray(data.channels)) {
      state.channels = data.channels;
    }

    const valid = new Set(state.channels.map((c) => c.name));

    state.lru = (data.lru ?? []).filter((n) => valid.has(n));
    state.liveSet = new Set((data.live ?? []).filter((n) => valid.has(n)));
    state.focus = valid.has(data.focus) ? data.focus : null;
    state.lastFocus = valid.has(data.lastFocus) ? data.lastFocus : null;
    state.sidebarCollapsed = data.sidebarCollapsed ?? false;

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

  // Update chat popup if open
  if (chatWindow && !chatWindow.closed) openChat();

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
  if (!normalized || !/^[a-z0-9_]+$/.test(normalized)) return false;
  if (state.channels.some((c) => c.name === normalized)) return false;

  state.channels.push({ name: normalized });
  fetchLiveChannels([normalized]).then((liveNames) => {
    if (liveNames?.has(normalized)) onlineSet.add(normalized);
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
    .filter((s) => s && /^[a-z0-9_]+$/.test(s));

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

/** Open or update Twitch chat popup for the currently focused channel. */
let chatWindow = null;

function openChat() {
  if (!state.focus) return;
  const url = `https://www.twitch.tv/popout/${state.focus}/chat?popout=`;
  if (chatWindow && !chatWindow.closed) {
    chatWindow.location = url;
    chatWindow.focus();
  } else {
    chatWindow = window.open(url, 'sd-chat');
  }
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
// Sidebar Collapse
// ═══════════════════════════════════════════════════════════════════

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  applySidebarState();
  saveState();
}

function applySidebarState() {
  dom.app.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
}

// ═══════════════════════════════════════════════════════════════════
// Player Lifecycle
// ═══════════════════════════════════════════════════════════════════

/**
 * Update CSS Grid layout: L-shape arrangement.
 *
 * Fixed pixel layout for 1920×1080 (minus sidebar):
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
      onlineSet.delete(name);
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
  label.textContent = name;
  container.appendChild(label);

  // Offline badge
  const badge = document.createElement('div');
  badge.className = 'player-badge hidden';
  badge.textContent = 'OFFLINE';
  container.appendChild(badge);

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
    onOnline() {
      badge.classList.add('hidden');
      onlineSet.add(name);
      renderSidebar();
    },
    onOffline() {
      badge.classList.remove('hidden');
      onlineSet.delete(name);
      renderSidebar();
    },
  });

  players.set(name, { container, player, qualityBadge });
}

// ═══════════════════════════════════════════════════════════════════
// Quality Debug Badge (dev mode)
// ═══════════════════════════════════════════════════════════════════

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

function renderSidebar() {
  // Sort: online (streaming) first, then active players, then rest — alpha within each
  const sorted = [...state.channels].sort((a, b) => {
    const aOnline = onlineSet.has(a.name);
    const bOnline = onlineSet.has(b.name);
    if (aOnline !== bOnline) return aOnline ? -1 : 1;
    const aLive = state.liveSet.has(a.name);
    const bLive = state.liveSet.has(b.name);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const sortedNames = new Set(sorted.map((c) => c.name));

  // Remove items no longer in channel list
  for (const [name, li] of sidebarItems) {
    if (!sortedNames.has(name)) {
      li.remove();
      sidebarItems.delete(name);
    }
  }

  // Create or update items
  for (const ch of sorted) {
    const isLive = state.liveSet.has(ch.name);
    const isFocus = state.focus === ch.name;
    const isOnline = onlineSet.has(ch.name);

    let li = sidebarItems.get(ch.name);
    if (!li) {
      li = createSidebarItem(ch.name);
      sidebarItems.set(ch.name, li);
    }

    // Update state classes
    li.classList.toggle('is-live', isLive);
    li.classList.toggle('is-focus', isFocus);

    // Update toggle checkbox
    li._checkbox.checked = isLive;

    // Update live badge
    li._liveBadge.classList.toggle('hidden', !isOnline);

    // Append in sorted order (moves existing nodes without recreating)
    dom.channelList.appendChild(li);
  }
}

function createSidebarItem(name) {
  const li = document.createElement('li');
  li.className = 'channel-item';

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
  nameBtn.title = 'Click to focus';
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

  li.append(toggle, nameBtn, liveBadge, delBtn);

  // Store refs for fast updates
  li._checkbox = checkbox;
  li._liveBadge = liveBadge;

  return li;
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

  // Sidebar toggle
  dom.sidebarToggle.addEventListener('click', toggleSidebar);
  dom.twitchLogin.addEventListener('click', () => {
    window.open('https://www.twitch.tv/login', '_blank');
  });
  dom.chatBtn.addEventListener('click', openChat);
  dom.closeBtn.addEventListener('click', () => window.close());

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
    case 'c':
    case 'C':
      e.preventDefault();
      openChat();
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
