// The Qāf listening worker: everything heavy happens here, off the page's thread, so the page never stutters.
//
// Microphone audio arrives (from an AudioWorklet, straight through a MessagePort) → every ~0.12–0.4 s the Qāf model
// looks at the last 1.6 s → the new letter-probability frames go to the tracker (tracker.mjs) → the tracker says
// where the reader is (the live cursor, several times a second) and which words are now done.
//
// Messages in:   { type: 'load', model, features, vocab, ort }      once
//                { type: 'mic', port, rate }                         the audio port (or { type: 'audio', data, rate })
//                { type: 'start', words, gen } | { type: 'extend', words } | { type: 'advance', k } | { type: 'stop' }
// Messages out:  { type: 'ready' } | { type: 'error', message }
//                { type: 'track', pos, word, frac, events, ms }      after every look
import { makeFeaturizer } from './features.mjs';
import { createTracker } from './tracker.mjs';

const SR = 16000, FRAME = 640, WINDOW = SR * 1.6, RIGHT = 2, LEFT = 15;   // frames: 40 ms each
let ort = null, sess = null, featurize = null, vocab = null, C = 0, tracker = null, running = false;
let buf = new Float32Array(SR * 4), bufLen = 0, bufStart = 0, total = 0, lastRun = 0, emitted = -1, hop = SR * 0.12, busy = false;
let rate = SR, carry = 0, gen = 0;

async function load({ model, features, vocab: vurl, ort: ortUrl }) {
  try {
    ort = await import(/* @vite-ignore */ ortUrl + 'ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = ortUrl;
    ort.env.wasm.numThreads = 1;
    const [s, f, v] = await Promise.all([
      ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
      fetch(features).then((r) => r.json()),
      fetch(vurl).then((r) => r.json()),
    ]);
    sess = s; featurize = makeFeaturizer(f); vocab = v; C = v.letters.length + 1;
    // one short warm-up look, so the first real one is fast
    const { data, frames } = featurize(new Float32Array(SR));
    await sess.run({ features: new ort.Tensor('float32', data, [1, 80, frames]), length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]) });
    postMessage({ type: 'ready' });
  } catch (e) { postMessage({ type: 'error', message: String(e?.message ?? e) }); }
}

// audio at any rate → 16 kHz, kept as the last 4 s
let tape = null;     // diagnostics: everything heard, at 16 kHz ({ type: 'tape' } turns it on, { type: 'dump' } sends it)
function take(x, r) {
  let y = x;
  if (r !== SR) {
    const step = r / SR, n = Math.floor((x.length - carry) / step);
    y = new Float32Array(Math.max(0, n));
    for (let i = 0; i < n; i++) { const p = carry + i * step, k = Math.floor(p), a = p - k; y[i] = x[k] * (1 - a) + (x[k + 1] ?? x[k]) * a; }
    carry = carry + n * step - x.length;
  }
  if (bufLen + y.length > buf.length) { const drop = bufLen + y.length - buf.length; buf.copyWithin(0, drop, bufLen); bufLen -= drop; bufStart += drop; }
  buf.set(y, bufLen); bufLen += y.length; total += y.length;
  if (tape) tape.push(y.slice());
  if (running) look();
}

async function look() {
  if (busy || !sess || !tracker || total - lastRun < hop) return;
  busy = true;
  const t0 = performance.now();
  try {
    let start = Math.max(bufStart, total - WINDOW);
    start = Math.ceil(start / FRAME) * FRAME;
    const audio = buf.slice(start - bufStart, bufLen);
    lastRun = total;
    const { data, frames } = featurize(audio);
    const out = await sess.run({
      features: new ort.Tensor('float32', data, [1, 80, frames]),
      length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
    });
    const lp = out.logprobs.data, steps = Math.min(out.logprobs.dims[1], Number(out.out_length.data[0]));
    const first = start / FRAME;
    // every frame with enough audio before it in this window is (re)written: a later look, having heard more after
    // a letter, judges it better, and the tracker re-aligns its whole recent history anyway
    const a = first === 0 ? 0 : first + LEFT, b = first + steps - 1 - RIGHT;
    if (b >= a && running) { tracker.write(a, lp.subarray((a - first) * C, (b - first + 1) * C), b - a + 1); emitted = Math.max(emitted, b); }
    const ms = performance.now() - t0;
    hop = Math.min(SR * 0.4, Math.max(SR * 0.12, ms * 1.3 * 16));     // keep up on slower devices
    if (running) { const u = tracker.update(); postMessage({ type: 'track', gen, pos: u.pos, word: u.word, frac: u.frac, events: u.events, filler: !!u.inFiller, ms }); }
  } catch (e) {
    postMessage({ type: 'error', message: String(e?.message ?? e) });
  } finally { busy = false; }
  if (running && total - lastRun >= hop) look();
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') load(m);
  else if (m.type === 'mic') { rate = m.rate || SR; carry = 0; m.port.onmessage = (ev) => take(ev.data, rate); }
  else if (m.type === 'audio') take(m.data, m.rate || SR);
  else if (m.type === 'start') {
    tracker = createTracker({ letters: vocab.letters, blank: vocab.blank, words: m.words });
    gen = m.gen ?? 0; running = true;
    bufLen = 0; bufStart = 0; total = 0; lastRun = 0; emitted = -1; hop = SR * 0.12;
  }
  else if (m.type === 'extend') tracker?.extend(m.words);
  else if (m.type === 'advance') tracker?.advance(m.k);
  else if (m.type === 'stop') running = false;
  else if (m.type === 'tape') tape = [];
  else if (m.type === 'dump') { const n = (tape ?? []).reduce((a, c) => a + c.length, 0), out = new Float32Array(n); let o = 0; for (const c of tape ?? []) { out.set(c, o); o += c.length; } postMessage({ type: 'dump', audio: out }, [out.buffer]); }
};
