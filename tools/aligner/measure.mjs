// Measures the Qāf aligner on real recitations, exactly as the app runs it (same features, same model,
// same window and hop), but faster than real time. Reports, per condition:
//   tracked      words the aligner followed, in order
//   latency      time from the end of each word (reference alignment) to the moment it is written
//   false wrong  correctly recited words the aligner would flag
//   caught       deliberately changed words that it flags
//
//   node tools/aligner/measure.mjs <model dir> <audio dir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFeaturizer } from '../../src/lib/features.mjs';
import { createAligner } from '../../src/lib/aligner.mjs';
import { tokenize } from '../../src/lib/recite.mjs';

let ort;
try { ort = (await import('onnxruntime-node')).default; } catch { ort = await import('onnxruntime-web'); }
const [modelDir, audioDir] = process.argv.slice(2);
const feat = JSON.parse(fs.readFileSync(path.join(modelDir, 'features.json')));
const vocab = JSON.parse(fs.readFileSync(path.join(modelDir, 'vocab.json')));
const sess = await ort.InferenceSession.create(path.join(modelDir, 'qaaf-asr.onnx'), { intraOpNumThreads: 1 });
const featurize = makeFeaturizer(feat);
const C = vocab.letters.length + 1, FRAME = 640, WINDOW = 16000 * 2.4, RIGHT = 3;

const xml = fs.readFileSync('sources/tanzil/quran-uthmani.xml', 'utf8');
const text = new Map();
for (const m of xml.matchAll(/<sura index="(\d+)"[^>]*>([\s\S]*?)<\/sura>/g))
  for (const a of m[2].matchAll(/<aya index="(\d+)" text="([^"]+)"/g)) text.set(`${m[1]}:${a[1]}`, a[2]);

async function logprobs(audio) {
  const { data, frames } = featurize(audio);
  const out = await sess.run({ features: new ort.Tensor('float32', data, [1, 80, frames]), length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]) });
  return { lp: out.logprobs.data, steps: Math.min(out.logprobs.dims[1], Number(out.out_length.data[0])) };
}
function decode(file, filters) {
  const args = ['-v', 'quiet', '-i', file];
  if (filters) args.push('-af', filters);
  args.push('-f', 'f32le', '-ac', '1', '-ar', '16000', '-');
  const b = execFileSync('ffmpeg', args, { maxBuffer: 1 << 28 });
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
const classify = (w) => (w.covered < 0.7 || w.score < -2.5 ? 'wrong' : 'ok');

// reference: whole ayah at once, then the same aligner; a word "ends" two frames before it is reported
async function reference(audio, words) {
  const { lp, steps } = await logprobs(audio);
  const ends = new Array(words.length).fill(null);
  let f = 0;
  const a = createAligner({ letters: vocab.letters, blank: vocab.blank, onWords: (ws) => ws.forEach((w) => { ends[w.index] = (f - 2) * 0.04; }) });
  a.reset(words);
  for (f = 0; f < steps; f++) a.push(lp.subarray(f * C, (f + 1) * C), 1);
  return ends;
}

// streaming, as in the app: every hop, the model looks at the last 2.4 s
async function stream(audio, words, hop = 0.16) {
  const got = [];                 // { index, at, cls }
  let now = 0;
  const a = createAligner({ letters: vocab.letters, blank: vocab.blank, onWords: (ws) => ws.forEach((w) => got.push({ index: w.index, at: now, cls: classify(w) })) });
  a.reset(words);
  let emitted = -1;
  const tail = new Float32Array(16000 * 1.0);      // a second of silence after the ayah
  const all = new Float32Array(audio.length + tail.length); all.set(audio);
  for (let end = Math.round(hop * 16000); end <= all.length; end += Math.round(hop * 16000)) {
    let start = Math.max(0, end - WINDOW); start = Math.ceil(start / FRAME) * FRAME;
    const t0 = performance.now();
    const { lp, steps } = await logprobs(all.subarray(start, end));
    const first = start / FRAME, from = Math.max(emitted + 1, first + 4), upto = first + steps - 1 - RIGHT;
    const compute = (performance.now() - t0) / 1000;
    now = end / 16000 + compute;                   // when the app would know
    if (upto >= from) { a.push(lp.subarray((from - first) * C, (upto - first + 1) * C), upto - from + 1); emitted = upto; }
  }
  return got;
}

const conditions = { studio: null, 'phone-like (noise, band-limit, 1.1x)': 'atempo=1.1,highpass=f=200,lowpass=f=3800,volume=0.6' };
const files = fs.readdirSync(audioDir).filter((f) => f.endsWith('.mp3')).sort();
const report = [];
for (const [name, filters] of Object.entries(conditions)) {
  let total = 0, tracked = 0, falseWrong = 0, caught = 0, changed = 0;
  const lat = [];
  for (const f of files) {
    const [rec, sa] = f.replace('.mp3', '').split('__');
    const key = `${+sa.slice(0, 3)}:${+sa.slice(3)}`;
    const words = tokenize(text.get(key), key).map((w) => w.plain);
    if (words.length < 3) continue;
    const audio = decode(path.join(audioDir, f), filters);
    const ends = await reference(audio, words);
    const got = await stream(audio, words);
    total += words.length;
    const seen = new Set();
    for (const g of got) {
      if (seen.has(g.index)) continue; seen.add(g.index);
      tracked++;
      if (g.cls === 'wrong') falseWrong++;
      if (ends[g.index] != null) lat.push(g.at - ends[g.index]);
    }
    // a deliberately wrong expected word: does the aligner flag it?
    const k = Math.min(2, words.length - 2);
    const swapped = words.slice(); swapped[k] = words[k] === 'الله' ? 'الرحمان' : 'الله';
    const g2 = await stream(audio, swapped);
    changed++;
    const hit = g2.find((g) => g.index === k);
    if (!hit || hit.cls === 'wrong') caught++;
  }
  lat.sort((x, y) => x - y);
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] * 1000 : NaN).toFixed(0);
  report.push(`${name}: tracked ${(100 * tracked / total).toFixed(1)}% of ${total} words | latency median ${q(0.5)} ms, 90% under ${q(0.9)} ms | false "wrong" ${(100 * falseWrong / Math.max(1, tracked)).toFixed(1)}% | changed words caught ${caught}/${changed}`);
}
console.log('\n=== ALIGNER RESULTS ===\n' + report.join('\n'));
fs.writeFileSync('aligner-report.txt', report.join('\n'));
