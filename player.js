// ═══════════════════════════════════════════════════════════════════
// HLS player for one channel
//
// Tiles play a low rendition, the focus plays source. Quality switches
// use hls.nextLevel: it takes effect at the next fragment boundary while
// the current fragment keeps playing — no visible or audible gap.
// ═══════════════════════════════════════════════════════════════════

import Hls from './vendor/hls.light.mjs';

const TILE_MIN_HEIGHT = 360;
const BACK_BUFFER_SECONDS = 10;
const OFFLINE_RETRY_MS = 30_000;
const ERROR_RETRY_MS = 5_000;
const HTTP_NOT_FOUND = 404;

function findSourceLevel(levels) {
  return levels.reduce((bestIndex, level, index) => {
    const best = levels[bestIndex];
    const isBetter =
      level.height > best.height || (level.height === best.height && level.bitrate > best.bitrate);

    return isBetter ? index : bestIndex;
  }, 0);
}

function findTileLevel(levels) {
  const candidates = levels
    .map((level, index) => ({ height: level.height, index }))
    .filter((candidate) => candidate.height >= TILE_MIN_HEIGHT)
    .sort((a, b) => a.height - b.height);

  return candidates[0]?.index ?? findSourceLevel(levels);
}

/**
 * Creates a muted tile player inside `container`.
 * `onOnline` / `onOffline` report whether the channel is streaming.
 */
export function createPlayer(channel, container, { onOnline, onOffline }) {
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  container.append(video);

  let hls = null;
  let levels = null;
  let isFocused = false;
  let retryTimer = null;

  const desiredLevel = () => (isFocused ? levels.source : levels.tile);

  function start() {
    levels = null;
    hls = new Hls({ backBufferLength: BACK_BUFFER_SECONDS });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      levels = { source: findSourceLevel(hls.levels), tile: findTileLevel(hls.levels) };
      hls.currentLevel = desiredLevel();
      onOnline();
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }

      const isOffline = data.response?.code === HTTP_NOT_FOUND;
      if (isOffline) onOffline();
      restartAfter(isOffline ? OFFLINE_RETRY_MS : ERROR_RETRY_MS);
    });

    hls.loadSource(`/api/playlist/${channel}.m3u8`);
    hls.attachMedia(video);
  }

  function stop() {
    hls?.destroy();
    hls = null;
  }

  function restartAfter(delayMs) {
    stop();
    retryTimer = setTimeout(start, delayMs);
  }

  // Twitch ends the playlist when the broadcast stops
  video.addEventListener('ended', () => {
    onOffline();
    restartAfter(OFFLINE_RETRY_MS);
  });

  start();

  return {
    setFocused(focused) {
      if (focused === isFocused) return;

      isFocused = focused;
      video.muted = !focused;
      if (hls && levels) hls.nextLevel = desiredLevel();
    },

    /** Volume 0–1; only audible while focused (tiles stay muted). */
    setVolume(volume) {
      video.volume = volume;
    },

    /** Currently displayed rendition, e.g. "1080p60" (dev badge). */
    qualityLabel() {
      if (!hls || !video.videoHeight) return '…';

      const frameRate = hls.levels[hls.currentLevel]?.frameRate ?? 0;

      return `${video.videoHeight}p${Math.round(frameRate)}`;
    },

    destroy() {
      clearTimeout(retryTimer);
      stop();
      video.remove();
    },
  };
}
