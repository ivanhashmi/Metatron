const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms at 16 kHz (3200 bytes of 16-bit PCM)

class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_SAMPLE_RATE;
    this.readIndex = 0;
    this.prevSample = 0;
    this.hasPrevSample = false;

    this.outBuffer = new Int16Array(CHUNK_SAMPLES);
    this.outOffset = 0;
    this.sumSquares = 0;
  }

  pushSample(floatSample) {
    const clamped = Math.max(-1, Math.min(1, floatSample));
    this.sumSquares += clamped * clamped;
    this.outBuffer[this.outOffset++] =
      clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);

    if (this.outOffset >= CHUNK_SAMPLES) {
      const rms = Math.sqrt(this.sumSquares / CHUNK_SAMPLES);
      const transferBuf = this.outBuffer.buffer;
      this.port.postMessage({ pcm: transferBuf, rms }, [transferBuf]);

      this.outBuffer = new Int16Array(CHUNK_SAMPLES);
      this.outOffset = 0;
      this.sumSquares = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true;
    }

    // Mix down to mono if multiple channels are present.
    const channelCount = input.length;
    const frameCount = input[0].length;
    let mono;
    if (channelCount === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(frameCount);
      for (let i = 0; i < frameCount; i++) {
        let sum = 0;
        for (let ch = 0; ch < channelCount; ch++) {
          sum += input[ch][i];
        }
        mono[i] = sum / channelCount;
      }
    }

    if (sampleRate === TARGET_SAMPLE_RATE) {
      for (let i = 0; i < frameCount; i++) {
        this.pushSample(mono[i]);
      }
      return true;
    }

    // Linear interpolation resampling from hardware sampleRate to 16 kHz.
    // Virtual buffer: index -1 is prevSample (when available), indices 0..frameCount-1 are mono.
    let pos = this.readIndex;
    while (pos < frameCount) {
      const idx0 = Math.floor(pos);
      const frac = pos - idx0;
      const s0 = idx0 < 0 ? (this.hasPrevSample ? this.prevSample : mono[0]) : mono[idx0];
      const idx1 = Math.min(idx0 + 1, frameCount - 1);
      const s1 = idx1 < 0 ? mono[0] : mono[idx1];
      const interpolated = s0 + (s1 - s0) * frac;

      this.pushSample(interpolated);
      pos += this.ratio;
    }

    this.readIndex = pos - frameCount;
    this.prevSample = mono[frameCount - 1];
    this.hasPrevSample = true;

    return true;
  }
}

registerProcessor('pcm-16k-processor', Pcm16kProcessor);
