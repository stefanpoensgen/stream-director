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
// Distance to the live edge. Twitch announces a 6 s target duration for 2 s segments, so hls.js's
// default (3 × target duration) would play 18 s behind. 4 s = 2 segments of buffer, enough for
// seamless quality switches; beyond 10 s (after stalls) the player jumps back to the live edge.
const LIVE_SYNC_SECONDS = 4;
const LIVE_MAX_LATENCY_SECONDS = 10;
const OFFLINE_RETRY_MS = 30_000;
const ERROR_RETRY_MS = 5_000;
const HTTP_FORBIDDEN = 403;
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
 * Where a player's sound goes: through the host's audio relay when there is one
 * (see audio-relay.js), otherwise out of the video element itself.
 */
function createAudioOutput(video, audioRelay) {
  if (!audioRelay) {
    return {
      apply(isAudible, volume) {
        video.muted = !isAudible;
        video.volume = volume;
      },
      disconnect() {},
    };
  }

  const route = audioRelay.connect(video);
  video.muted = false; // the relay's gain decides what is heard

  return {
    apply(isAudible, volume) {
      route.setGain(isAudible ? volume : 0);
    },
    disconnect: route.disconnect,
  };
}

/**
 * Creates a muted tile player inside `container`.
 * `onOnline` / `onOffline` report whether the channel is streaming,
 * `onUnavailable` that it streams but cannot be played (subscriber-only, geo-blocked).
 */
export function createPlayer(
  channel,
  container,
  { audioRelay, onOnline, onOffline, onUnavailable },
) {
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  container.append(video);
  const audio = createAudioOutput(video, audioRelay);

  let hls = null;
  let levels = null;
  let isFocused = false;
  let volume = 1;
  let retryTimer = null;
  let isDestroyed = false;

  const desiredLevel = () => (isFocused ? levels.source : levels.tile);

  function start() {
    levels = null;
    hls = new Hls({
      backBufferLength: BACK_BUFFER_SECONDS,
      liveSyncDuration: LIVE_SYNC_SECONDS,
      liveMaxLatencyDuration: LIVE_MAX_LATENCY_SECONDS,
    });

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

      const status = data.response?.code;
      if (status === HTTP_NOT_FOUND) onOffline();
      if (status === HTTP_FORBIDDEN) onUnavailable();

      const isPermanent = status === HTTP_NOT_FOUND || status === HTTP_FORBIDDEN;
      restartAfter(isPermanent ? OFFLINE_RETRY_MS : ERROR_RETRY_MS);
    });

    hls.loadSource(`/api/playlist/${channel}.m3u8`);
    hls.attachMedia(video);
  }

  function stop() {
    hls?.destroy();
    hls = null;
  }

  /** Exactly one pending restart at a time — an error and `ended` may both ask for one. */
  function restartAfter(delayMs) {
    if (isDestroyed) return;

    stop();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(start, delayMs);
  }

  // Twitch ends the playlist when the broadcast stops
  function onEnded() {
    onOffline();
    restartAfter(OFFLINE_RETRY_MS);
  }

  video.addEventListener('ended', onEnded);

  start();

  return {
    setFocused(focused) {
      if (focused === isFocused) return;

      isFocused = focused;
      audio.apply(isFocused, volume);
      if (hls && levels) hls.nextLevel = desiredLevel();
    },

    /** Volume 0–1; only audible while focused (tiles stay muted). */
    setVolume(newVolume) {
      volume = newVolume;
      audio.apply(isFocused, volume);
    },

    /**
     * Dev badge: displayed rendition and delay behind the live broadcast,
     * e.g. "1080p60 · 6.2 s" (from the stream's PROGRAM-DATE-TIME).
     */
    qualityLabel() {
      if (!hls || !video.videoHeight) return '…';

      const frameRate = hls.levels[hls.currentLevel]?.frameRate ?? 0;
      const rendition = `${video.videoHeight}p${Math.round(frameRate)}`;
      if (!hls.playingDate) return rendition;

      const delaySeconds = (Date.now() - hls.playingDate.getTime()) / 1000;

      return `${rendition} · ${delaySeconds.toFixed(1)} s`;
    },

    destroy() {
      isDestroyed = true;
      clearTimeout(retryTimer);
      video.removeEventListener('ended', onEnded);
      stop();
      audio.disconnect();
      video.remove();
    },
  };
}
