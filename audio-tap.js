// ═══════════════════════════════════════════════════════════════════
// AudioWorklet: taps the mixed player audio and hands it out as
// 16-bit stereo PCM chunks (the host plays them from its own process)
// ═══════════════════════════════════════════════════════════════════

const CHUNK_FRAMES = 480; // 10 ms at 48 kHz — small chunks keep the added latency low
const CHANNELS = 2;
const INT16_MAX = 32767;

class AudioTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(CHUNK_FRAMES * CHANNELS);
    this.filledFrames = 0;
  }

  process(inputs) {
    const [left, right = left] = inputs[0] ?? [];
    const frames = left?.length ?? 128;

    for (let frame = 0; frame < frames; frame++) {
      // No input (nothing connected yet) is sent as silence so the host's clock keeps running
      this.chunk[this.filledFrames * CHANNELS] = toInt16(left?.[frame] ?? 0);
      this.chunk[this.filledFrames * CHANNELS + 1] = toInt16(right?.[frame] ?? 0);
      this.filledFrames++;

      if (this.filledFrames === CHUNK_FRAMES) {
        const buffer = this.chunk.slice().buffer;
        this.port.postMessage(buffer, [buffer]);
        this.filledFrames = 0;
      }
    }

    return true;
  }
}

function toInt16(sample) {
  return Math.max(-INT16_MAX, Math.min(INT16_MAX, Math.round(sample * INT16_MAX)));
}

registerProcessor('audio-tap', AudioTap);
