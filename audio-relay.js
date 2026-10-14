// ═══════════════════════════════════════════════════════════════════
// Audio relay: player audio → Web Audio → host → played by StreamDirector.exe
//
// WebView2 plays sound from its own processes, which OBS's "Capture Audio"
// cannot see for the StreamDirector window. The players' audio is therefore
// routed through Web Audio (WebView2 itself stays silent) and the host plays
// it from its own process. Measured cost: 10–20 ms more latency than
// WebView2's direct output — far below what is noticeable for audio after video.
// ═══════════════════════════════════════════════════════════════════

const SAMPLE_RATE = 48_000;
const AUDIO_MESSAGE_PREFIX = 'audio:';

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);

  return btoa(binary);
}

/**
 * Returns the relay, or null outside the WebView2 host (players then use
 * the video element's own audio output).
 */
export function createAudioRelay() {
  const host = window.chrome?.webview;
  if (!host) return null;

  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  const mix = context.createGain();

  // The host allows autoplay; should the context still start suspended, the first click resumes it
  document.addEventListener('click', () => context.resume(), { once: true });

  context.audioWorklet.addModule('audio-tap.js').then(() => {
    const tap = new AudioWorkletNode(context, 'audio-tap', { numberOfOutputs: 0 });
    tap.port.onmessage = ({ data }) => host.postMessage(AUDIO_MESSAGE_PREFIX + toBase64(data));
    mix.connect(tap);
  });

  return {
    /** Routes a video's audio into the relay; returns its gain control (0–1). */
    connect(video) {
      const source = context.createMediaElementSource(video);
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(mix);

      return {
        setGain(value) {
          gain.gain.value = value;
        },
        disconnect() {
          source.disconnect();
          gain.disconnect();
        },
      };
    },
  };
}
