// AudioWorklet processors for the web call (lib/voice/call.ts). The Voice
// Agent API speaks PCM16 mono at 24 kHz both ways; the AudioContext runs at
// whatever rate the device wants, so both directions resample here (linear --
// fine for speech).
const RATE = 24000;

// Mic -> 24 kHz Int16 chunks of ~50 ms, posted as ArrayBuffers.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / RATE; // input samples per output sample
    this.pos = 0;
    this.prev = 0;
    this.out = new Int16Array(1200);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // pos walks the input in fractional steps; index -1 is the previous block's last sample
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1], b = ch[i];
      const s = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.out[this.n++] = Math.round(s * 32767);
      if (this.n === this.out.length) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(1200);
        this.n = 0;
      }
      this.pos += this.step;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}

// 24 kHz Int16 in (port messages) -> speaker. { clear: true } drops the queue
// (barge-in). Posts { drained: true } when it runs dry after playing.
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];     // Float32Array chunks at 24 kHz
    this.pos = 0;    // fractional read position in q[0]
    this.step = RATE / sampleRate;
    this.playing = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.clear) { this.q = []; this.pos = 0; return; }
      const pcm = new Int16Array(e.data);
      const f = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      this.q.push(f);
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let k = 0; k < out.length; k++) {
      while (this.q.length && this.pos >= this.q[0].length) { this.pos -= this.q[0].length; this.q.shift(); }
      if (!this.q.length) { out[k] = 0; continue; }
      const c = this.q[0], i = Math.floor(this.pos), f = this.pos - i;
      const next = i + 1 < c.length ? c[i + 1] : (this.q[1] ? this.q[1][0] : c[i]);
      out[k] = c[i] + (next - c[i]) * f;
      this.pos += this.step;
    }
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
    const busy = this.q.length > 0;
    if (this.playing && !busy) this.port.postMessage({ drained: true });
    this.playing = busy;
    return true;
  }
}

registerProcessor('mic', MicProcessor);
registerProcessor('player', PlayerProcessor);
