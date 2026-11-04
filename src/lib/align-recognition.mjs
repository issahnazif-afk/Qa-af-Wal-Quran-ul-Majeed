// "Qāf aligner" listening engine.
// Microphone → Qāf model (on the device, every ~0.15 s on the last ~2.4 s of audio) → aligner that follows
// the reader through the expected text. It behaves like the Web Speech API (start, stop, onresult), so the
// existing tracker accepts its words unchanged, and it also reports letter-level progress for the cursor.
//
// The page supplies the words it expects next: rec.getExpected = () => [plain words from the current word on].
import { loadModel } from './asr-local.mjs';
import { createAligner } from './aligner.mjs';

const SR16 = 16000;
const FRAME = 640;                 // samples per model output frame (40 ms)
const WINDOW = 16000 * 2.4;        // audio the model looks at each time
const RIGHT = 3;                   // newest frames held back until the model has heard a little after them

export class AlignRecognition {
  constructor() {
    this.lang = 'ar'; this.continuous = true; this.interimResults = true; this.maxAlternatives = 1;
    this.onresult = null; this.onend = null; this.onerror = null;
    this.results = [];
    this.getExpected = () => [];
  }

  async start() {
    try { this.m = await loadModel(); } catch (e) { this.onerror?.({ error: 'network', message: String(e) }); this.onend?.(); return; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    } catch { this.onerror?.({ error: 'not-allowed' }); this.onend?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC({ sampleRate: SR16 }); } catch { this.ctx = new AC(); }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
    this.ratio = this.ctx.sampleRate / SR16;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(1024, 1, 1);
    src.connect(this.proc); this.proc.connect(this.ctx.destination);

    this.buf = new Float32Array(SR16 * 6); this.bufLen = 0; this.bufStart = 0;   // last 6 s of audio, absolute start
    this.total = 0; this.lastRun = 0; this.emitted = -1; this.hop = 2400; this.busy = false;
    const { vocab } = this.m;
    this.C = vocab.letters.length + 1;
    this.aligner = createAligner({
      letters: vocab.letters, blank: vocab.blank,
      onProgress: (p) => { this.progress = p; window.dispatchEvent(new CustomEvent('ql:align', { detail: { offset: p.word, frac: p.frac, t: performance.now() } })); },
      onWords: (ws) => this.words(ws),
    });
    this.aligner.reset(this.getExpected());
    this.proc.onaudioprocess = (e) => this.push(e.inputBuffer.getChannelData(0));
    this.timer = setInterval(() => this.tick(), 40);
    this.running = true;
    window.__qaafAligner = this;   // for diagnostics
  }

  push(input) {
    let x;
    if (this.ratio !== 1) {
      const n = Math.floor(input.length / this.ratio);
      x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = input[Math.min(input.length - 1, Math.round(i * this.ratio))];
    } else x = input;
    if (this.bufLen + x.length > this.buf.length) {           // keep the newest audio
      const drop = this.bufLen + x.length - this.buf.length;
      this.buf.copyWithin(0, drop, this.bufLen); this.bufLen -= drop; this.bufStart += drop;
    }
    this.buf.set(x, this.bufLen); this.bufLen += x.length; this.total += x.length;
  }

  async tick() {
    if (!this.running || this.busy || this.total - this.lastRun < this.hop) return;
    this.busy = true;
    const t0 = performance.now();
    try {
      let start = Math.max(this.bufStart, this.total - WINDOW);
      start = Math.ceil(start / FRAME) * FRAME;
      const audio = this.buf.subarray(start - this.bufStart, this.bufLen);
      this.lastRun = this.total;
      const { ort, sess, featurize } = this.m;
      const { data, frames } = featurize(audio);
      const out = await sess.run({
        features: new ort.Tensor('float32', data, [1, 80, frames]),
        length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
      });
      const lp = out.logprobs.data, steps = Math.min(out.logprobs.dims[1], Number(out.out_length.data[0]));
      const first = start / FRAME;                               // absolute index of this window's first frame
      const from = Math.max(this.emitted + 1, first + 4), upto = first + steps - 1 - RIGHT;
      if (upto >= from) {
        const n = upto - from + 1, C = this.C;
        this.aligner.push(lp.subarray((from - first) * C, (upto - first + 1) * C), n);
        this.emitted = upto;
      }
      const ms = performance.now() - t0;
      this.hop = Math.min(SR16 * 0.4, Math.max(SR16 * 0.12, ms * 1.3 * 16));   // keep up on slower devices
      window.dispatchEvent(new CustomEvent('ql:asr', { detail: { text: `aligner: ${ms.toFixed(0)} ms per step, every ${(this.hop / 16).toFixed(0)} ms` } }));
    } catch (e) {
      this.onerror?.({ error: 'network', message: String(e) });
    } finally { this.busy = false; }
  }

  words(ws) {
    // a well-matched word is passed on as itself; a clearly different one as what it sounded like,
    // so the tracker marks it; a word the reader skipped over is left out (the tracker treats it as dropped)
    const said = [];
    for (const w of ws) {
      if (w.covered < 0.3) continue;
      const wrong = w.covered < 0.7 || w.score < -2.5;
      said.push(wrong && w.heard && w.heard !== w.plain ? w.heard : w.plain);
    }
    if (said.length) {
      const res = [{ transcript: said.join(' ') }]; res.isFinal = true;
      this.results.push(res);
      this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
    }
    this.aligner.rebase(this.getExpected());                   // the page has moved on: follow from there
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    try { this.proc.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    setTimeout(() => this.onend?.(), 0);
  }
}
