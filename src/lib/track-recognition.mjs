// The Qāf tracker as a speech recogniser: same shape as the Web Speech API (start, stop, onresult, onend, onerror),
// so the pages use it unchanged. It does not transcribe freely: it follows the reader through the words the page
// expects (rec.getExpected = () => plain words from the current word on), on the device, with no network.
//
// Each result is final and carries rec-level verdicts in result.track: [{ plain, kind }] with kind
//   'read' | 'weak' (heard, not clearly) | 'unclear' (passed too quickly to judge) | 'missed' (something else was said)
// The live position is sent as the window event 'ql:align' { offset, frac, t } (offset: words after the current one),
// several times a second, for the live cursor. Audio never leaves the device.
//
// Everything heavy runs in a Web Worker (qaaf-worker.mjs); the microphone audio goes straight to it from an
// AudioWorklet, so the page's own thread only draws.
import { u } from './url.mjs';

export const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const MODEL = () => (window.__qaafModel ?? 'models/qaaf-asr.onnx');

let worker = null, ready = null, current = null;
function getWorker() {
  if (ready) return ready;
  worker = new Worker(new URL('./qaaf-worker.mjs', import.meta.url), { type: 'module' });
  ready = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') resolve(worker);
      else if (m.type === 'dump') window.__qaafTape?.(m.audio);
      else if (m.type === 'error' && !current) reject(new Error(m.message));
      else current?.message(m);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'worker failed'));
  });
  worker.postMessage({ type: 'load', model: new URL(u(MODEL()), location.href).href, features: new URL(u('models/features.json'), location.href).href, vocab: new URL(u('models/vocab.json'), location.href).href, ort: ORT_URL });
  ready.catch(() => { ready = null; worker?.terminate(); worker = null; });
  return ready;
}
// Start loading the model as soon as the page opens, so it is ready before the reader starts.
export const preloadTracker = () => getWorker();
export const trackerReady = () => !!worker && !!ready;
// diagnostics (tests): keep and fetch the audio the tracker heard
if (typeof window !== 'undefined') { window.__qaafTapeOn = () => getWorker().then((w) => w.postMessage({ type: 'tape' })); window.__qaafDump = () => worker?.postMessage({ type: 'dump' }); }

// The microphone, at 16 kHz where the device allows; an AudioWorklet posts it straight to the worker.
const WORKLET = `class QaafMic extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(1024); this.n = 0; this.out = null; this.port.onmessage = (e) => { this.out = e.data; }; }
  process(inputs) { const x = inputs[0] && inputs[0][0]; if (x && this.out) { for (let i = 0; i < x.length; i++) { this.b[this.n++] = x[i]; if (this.n === this.b.length) { this.out.postMessage(this.b); this.b = new Float32Array(1024); this.n = 0; } } } return true; }
}
registerProcessor('qaaf-mic', QaafMic);`;

export class TrackRecognition {
  constructor() {
    this.lang = 'ar'; this.continuous = true; this.interimResults = true; this.maxAlternatives = 1;
    this.onresult = null; this.onend = null; this.onerror = null; this.onstart = null;
    this.results = [];
    this.getExpected = () => [];
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.results = [];
    // No text to follow yet (the Recite page's "start anywhere"): the browser's own speech recognition finds the
    // place, and the tracker takes over by itself as soon as the page knows what comes next.
    if (!this.getExpected().length && (window.SpeechRecognition || window.webkitSpeechRecognition)) { this.locate(); return; }
    return this.track();
  }

  locate() {
    const S = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = (this.proxy = new S());
    Object.assign(r, { lang: 'ar-SA', continuous: true, interimResults: true, maxAlternatives: this.maxAlternatives || 3 });
    r.onresult = (e) => {
      this.onresult?.(e);
      if (this.running && this.proxy === r && this.getExpected().length) {   // found: follow from here with the tracker
        this.proxy = null; r.onend = null; try { r.stop(); } catch {}
        this.results = []; this.track();
      }
    };
    r.onerror = (e) => this.onerror?.(e);
    r.onend = () => { if (this.running && this.proxy === r) { try { r.start(); } catch {} } };
    try { r.start(); this.onstart?.(); } catch (e) { this.onerror?.({ error: 'network', message: String(e) }); }
  }

  async track() {
    let w;
    try { w = await getWorker(); } catch (e) { this.running = false; this.onerror?.({ error: 'network', message: String(e) }); this.onend?.(); return; }
    try {
      // the raw voice: noise suppression and echo cancellation smear recitation; automatic gain helps quiet readers
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    } catch { this.running = false; this.onerror?.({ error: 'not-allowed' }); this.onend?.(); return; }
    if (!this.running) { this.stream.getTracks().forEach((t) => t.stop()); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = new AC({ sampleRate: 16000 }); } catch { this.ctx = new AC(); }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.words = this.getExpected().slice(); this.pos = 0; this.gen = (this.gen ?? 0) + 1;
    current = this;
    w.postMessage({ type: 'start', words: this.words, gen: this.gen });
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, 'qaaf-mic');
      const ch = new MessageChannel();
      this.node.port.postMessage(ch.port1, [ch.port1]);
      w.postMessage({ type: 'mic', port: ch.port2, rate: this.ctx.sampleRate }, [ch.port2]);
      src.connect(this.node);
      // the node must be pulled to run; a muted gain keeps it silent
      const mute = this.ctx.createGain(); mute.gain.value = 0; this.node.connect(mute).connect(this.ctx.destination);
    } catch {
      // older browsers: a ScriptProcessor on the page's thread, still decoded in the worker
      this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
      const rate = this.ctx.sampleRate;
      this.proc.onaudioprocess = (e) => { if (this.running) w.postMessage({ type: 'audio', data: e.inputBuffer.getChannelData(0).slice(), rate }); };
      src.connect(this.proc); this.proc.connect(this.ctx.destination);
    }
    if (!this.proxy) this.onstart?.();
  }

  // from the worker
  message(m) {
    if (m.type === 'error') { this.onerror?.({ error: 'network', message: m.message }); return; }
    if (window.__qaafDebug && m.type === 'track') console.debug('qaaf', JSON.stringify({ gen: m.gen, mine: this.gen, pos: m.pos, word: m.word, frac: +m.frac.toFixed(2), filler: m.filler, ev: m.events.map((e) => e.index + e.kind) }));
    if (m.type !== 'track' || !this.running || m.gen !== this.gen) return;
    this.pos = Math.max(this.pos, m.pos);
    window.dispatchEvent(new CustomEvent('ql:align', { detail: { offset: Math.max(0, m.word - m.pos), frac: m.frac, t: performance.now(), filler: m.filler } }));
    window.dispatchEvent(new CustomEvent('ql:asr', { detail: { text: `Qāf tracker: ${m.ms.toFixed(0)} ms a look` } }));
    if (m.events.length) {
      const track = m.events.map((e) => ({ plain: this.words[e.index], kind: e.kind, score: e.score }));
      const res = [{ transcript: track.map((x) => x.plain).join(' ') }];
      res.isFinal = true; res.track = track;
      this.results.push(res);
      this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
    }
    this.sync();
  }

  // keep the tracker's words in step with the page: more words as the reader goes on, and the page moving by
  // itself (the Sheikh said a word, a hint)
  sync() {
    const exp = this.getExpected();
    if (!exp.length) return;
    const pos = this.pos;
    const same = (k) => exp.slice(0, 3).every((x, i) => this.words[k + i] === x || this.words[k + i] === undefined);
    if (same(pos)) {
      if (this.words.length - pos < 16 && exp.length > this.words.length - pos) { this.words = this.words.slice(0, pos).concat(exp); worker?.postMessage({ type: 'extend', words: exp }); }
      return;
    }
    for (let k = 1; k <= 4; k++) if (same(pos + k)) { if (window.__qaafDebug) console.debug('qaaf sync: page ahead by', k); this.pos = pos + k; worker?.postMessage({ type: 'advance', k }); return; }
    if (window.__qaafDebug) console.debug('qaaf sync: restart', JSON.stringify({ pos, exp: exp.slice(0, 3), mine: this.words.slice(pos, pos + 3) }));
    // somewhere else altogether (a new question, a jump): start again from there
    this.words = exp.slice(); this.pos = 0; this.gen++;
    worker?.postMessage({ type: 'start', words: this.words, gen: this.gen });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.proxy) { const r = this.proxy; this.proxy = null; r.onend = null; try { r.stop(); } catch {} }
    if (current === this) { current = null; worker?.postMessage({ type: 'stop' }); }
    try { this.node?.disconnect(); this.proc?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    setTimeout(() => this.onend?.(), 0);
  }
  abort() { this.stop(); }
}
