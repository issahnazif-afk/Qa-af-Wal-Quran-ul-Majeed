// On-device recitation recogniser: the Qāf model trained on CAIR, run in the browser / app with
// onnxruntime-web. Behaves like the Web Speech API (start, stop, onresult with interim and final
// results), so the tracker works with it unchanged. Audio never leaves the device.
//
// Files (from CAIR's ~/qaaf_asr/export, published as the GitHub release "qaaf-asr-model"):
//   models/qaaf-asr.onnx, models/features.json, models/vocab.json
import { u } from './url.mjs';

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
let loading = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src));
    document.head.append(s);
  });
}

export function loadModel() {
  loading ??= (async () => {
    if (!window.ort) await loadScript(ORT + 'ort.min.js');
    window.ort.env.wasm.wasmPaths = ORT;
    window.ort.env.wasm.numThreads = 1;
    const [sess, feat, vocab] = await Promise.all([
      window.ort.InferenceSession.create(u('models/qaaf-asr.onnx'), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
      fetch(u('models/features.json')).then((r) => r.json()),
      fetch(u('models/vocab.json')).then((r) => r.json()),
    ]);
    return { ort: window.ort, sess, feat, vocab, featurize: makeFeaturizer(feat) };
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

import { makeFeaturizer } from './features.mjs';
export { makeFeaturizer };

function greedy(logp, steps, classes, vocab) {
  let out = '', last = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0, bv = -Infinity;
    for (let c = 0; c < classes; c++) { const v = logp[t * classes + c]; if (v > bv) { bv = v; best = c; } }
    if (best !== last && best !== vocab.blank) out += vocab.letters[best];
    last = best;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export class LocalRecognition {
  constructor() {
    this.lang = 'ar'; this.continuous = true; this.interimResults = true; this.maxAlternatives = 1;
    this.onresult = null; this.onend = null; this.onerror = null;
    this.results = [];
  }

  async start() {
    try { this.m = await loadModel(); } catch (e) { this.onerror?.({ error: 'network', message: String(e) }); this.onend?.(); return; }
    try {
      // raw voice (no noise suppression, which smears recitation), with automatic gain so quiet readers are heard
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    } catch { this.onerror?.({ error: 'not-allowed' }); this.onend?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC({ sampleRate: 16000 }); } catch { this.ctx = new AC(); }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
    this.ratio = this.ctx.sampleRate / 16000;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
    src.connect(this.proc); this.proc.connect(this.ctx.destination);
    this.seg = []; this.segLen = 0; this.pre = []; this.silent = 0; this.speaking = false; this.floor = 0.004; this.cur = -1;
    this.proc.onaudioprocess = (e) => this.push(e.inputBuffer.getChannelData(0));
    this.timer = setInterval(() => this.tick(), 150);
    this.running = true;
  }

  push(input) {
    let x = input;
    if (this.ratio !== 1) {                       // simple resampling to 16 kHz when the device ignores the request
      const n = Math.floor(input.length / this.ratio);
      x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = input[Math.min(input.length - 1, Math.round(i * this.ratio))];
    } else x = Float32Array.from(input);
    let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    const rms = Math.sqrt(e / x.length);
    const loud = rms > Math.max(0.0035, this.floor * 2.5);      // sensitive enough for a quiet voice
    if (!loud) this.floor = 0.95 * this.floor + 0.05 * rms;
    const ms = (x.length / 16000) * 1000;
    if (loud) { if (!this.speaking) { this.seg = [...this.pre]; this.segLen = this.seg.reduce((t, c) => t + c.length, 0); } this.speaking = true; this.silent = 0; }
    else this.silent += ms;
    if (this.speaking) { this.seg.push(x); this.segLen += x.length; }
    this.pre.push(x); if (this.pre.length > 4) this.pre.shift();
  }

  async tick() {
    if (!this.running || this.busy || !this.speaking || this.segLen < 4000) return;
    this.busy = true;
    try {
      const final = this.silent > 650 || this.segLen > 16000 * 14;
      const audio = new Float32Array(this.segLen);
      let o = 0; for (const c of this.seg) { audio.set(c, o); o += c.length; }
      const { ort, sess, featurize, vocab } = this.m;
      const { data, frames } = featurize(audio);
      const out = await sess.run({
        features: new ort.Tensor('float32', data, [1, 80, frames]),
        length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
      });
      const lp = out.logprobs, [, steps, classes] = lp.dims;
      const used = Number(out.out_length.data[0]);
      const text = greedy(lp.data, Math.min(steps, used), classes, vocab);
      window.dispatchEvent(new CustomEvent('ql:asr', { detail: { text, seconds: audio.length / 16000 } }));
      if (this.cur < 0) this.cur = this.results.length;
      const res = [{ transcript: text }]; res.isFinal = final;
      this.results[this.cur] = res;
      this.onresult?.({ resultIndex: this.cur, results: this.results });
      if (final) { this.cur = -1; this.seg = []; this.segLen = 0; this.speaking = false; }
    } catch (e) {
      this.onerror?.({ error: 'network', message: String(e) });
    } finally { this.busy = false; }
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
