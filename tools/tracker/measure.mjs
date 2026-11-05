// Measures the Qāf tracker on real recitations, exactly as the app runs it (same features, model, 1.6 s window,
// frame rewriting and tracker), in simulated real time. A look costs its measured time × DEVICE (default 2, a
// student laptop). For each recording (an ayah, followed in the text by the next two ayahs) it reports:
//   tracked   words the tracker confirmed (of the words recited)
//   delay     from the end of each word (offline reference alignment) to the moment it is confirmed
//   flagged   correctly recited words it marks weak / missed (false mistakes)
//   overrun   words beyond the recording that it wrongly confirms
//
//   node tools/tracker/measure.mjs <model dir> <audio dir>      audio: <Reciter>__SSSAAA.mp3 (everyayah names)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFeaturizer } from '../../src/lib/features.mjs';
import { createAligner } from '../../src/lib/aligner.mjs';
import { createTracker } from '../../src/lib/tracker.mjs';
import { tokenize } from '../../src/lib/recite.mjs';

let ort;
try { ort = (await import('onnxruntime-node')).default; } catch { ort = await import('onnxruntime-web'); }
const [modelDir, audioDir] = process.argv.slice(2);
const DEVICE = Number(process.env.DEVICE || 2);
const feat = JSON.parse(fs.readFileSync(path.join(modelDir, 'features.json')));
const vocab = JSON.parse(fs.readFileSync(path.join(modelDir, 'vocab.json')));
const sess = await ort.InferenceSession.create(path.join(modelDir, fs.existsSync(path.join(modelDir, 'qaaf-asr.int8.onnx')) && process.env.INT8 ? 'qaaf-asr.int8.onnx' : 'qaaf-asr.onnx'), { intraOpNumThreads: 1 });
const featurize = makeFeaturizer(feat);
const C = vocab.letters.length + 1, FRAME = 640, WINDOW = 16000 * 1.6, RIGHT = 2, LEFT = 15;

const xml = fs.readFileSync('sources/tanzil/quran-uthmani.xml', 'utf8');
const text = new Map();
for (const m of xml.matchAll(/<sura index="(\d+)"[^>]*>([\s\S]*?)<\/sura>/g))
  for (const a of m[2].matchAll(/<aya index="(\d+)" text="([^"]+)"/g)) text.set(`${m[1]}:${a[1]}`, a[2]);
const plainOf = (k) => tokenize(text.get(k) ?? '', k).map((w) => w.plain);

async function run(audio) {
  const t0 = performance.now(); const { data, frames } = featurize(audio);
  const out = await sess.run({ features: new ort.Tensor('float32', data, [1, 80, frames]), length: new ort.Tensor('int64', BigInt64Array.from([BigInt(frames)]), [1]) });
  return { lp: out.logprobs.data, steps: Math.min(out.logprobs.dims[1], Number(out.out_length.data[0])), ms: performance.now() - t0 };
}
function decode(file) {
  const b = execFileSync('ffmpeg', ['-v', 'quiet', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 1 << 28 });
  const x = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const y = new Float32Array(x.length + 16000); y.set(x); return y;     // a second of silence after, as a reader stops
}
async function reference(audio, words) {
  const ends = new Array(words.length).fill(null);
  const { lp, steps } = await run(audio);
  let f = 0;
  const a = createAligner({ letters: vocab.letters, blank: vocab.blank, onWords: (ws) => ws.forEach((w) => { ends[w.index] = (f - 2) * 0.04; }) });
  a.reset(words);
  for (f = 0; f < steps; f++) a.push(lp.subarray(f * C, (f + 1) * C), 1);
  return ends;
}
async function stream(audio, words) {
  const got = new Array(words.length).fill(null), kind = [];
  const tr = createTracker({ letters: vocab.letters, blank: vocab.blank, words });
  const DUR = audio.length / 16000;
  let hop = 0.12, lastRun = 0;
  for (let t = 0.04; t <= DUR; t += 0.01) {
    const total = Math.min(audio.length, Math.floor(t * 16000));
    if (total - lastRun < hop * 16000) continue;
    let start = Math.max(0, total - WINDOW); start = Math.ceil(start / FRAME) * FRAME;
    const r = await run(audio.subarray(start, total)); lastRun = total;
    const dev = r.ms * DEVICE; t += dev / 1000;
    const first = start / FRAME, a = first === 0 ? 0 : first + LEFT, b = first + r.steps - 1 - RIGHT;
    if (b >= a) tr.write(a, r.lp.subarray((a - first) * C, (b - first + 1) * C), b - a + 1);
    hop = Math.min(0.4, Math.max(0.12, (dev * 1.3) / 1000));
    for (const e of tr.update().events) { if (got[e.index] == null) got[e.index] = t; kind[e.index] = e.kind; }
  }
  return { got, kind };
}

const files = fs.readdirSync(audioDir).filter((f) => /__\d{6}\.mp3$/.test(f)).sort();
const all = { said: 0, tracked: 0, flagged: 0, overrun: 0, delays: [] };
const lines = [];
for (const f of files) {
  const [reciter, code] = f.replace('.mp3', '').split('__');
  const s = Number(code.slice(0, 3)), a = Number(code.slice(3));
  const said = plainOf(`${s}:${a}`); if (!said.length) continue;
  const words = [...said, ...plainOf(`${s}:${a + 1}`), ...plainOf(`${s}:${a + 2}`)];
  const audio = decode(path.join(audioDir, f));
  const ref = await reference(audio, said);
  const { got, kind } = await stream(audio, words);
  let tracked = 0, flagged = 0; const d = [];
  for (let k = 0; k < said.length; k++) { if (got[k] != null) { tracked++; if (ref[k] != null) d.push(got[k] - ref[k]); if (kind[k] === 'weak' || kind[k] === 'missed') flagged++; } }
  const overrun = got.slice(said.length).filter((x) => x != null).length;
  d.sort((x, y) => x - y);
  all.said += said.length; all.tracked += tracked; all.flagged += flagged; all.overrun += overrun; all.delays.push(...d);
  lines.push(`${reciter.padEnd(28)} ${s}:${a}  tracked ${tracked}/${said.length}  delay median ${(d[Math.floor(d.length / 2)] ?? NaN).toFixed(2)} s worst ${(d[d.length - 1] ?? NaN).toFixed(2)} s  flagged ${flagged}  overrun ${overrun}`);
  console.log(lines[lines.length - 1]);
}
const D = all.delays.sort((x, y) => x - y), q = (p) => D[Math.min(D.length - 1, Math.floor(p * D.length))] ?? NaN;
const summary = `\nAll: tracked ${all.tracked}/${all.said} (${((100 * all.tracked) / all.said).toFixed(1)}%), delay median ${q(0.5).toFixed(2)} s, p90 ${q(0.9).toFixed(2)} s, worst ${q(1).toFixed(2)} s, ` +
  `correct words flagged ${all.flagged} (${((100 * all.flagged) / Math.max(1, all.tracked)).toFixed(1)}%), words wrongly run on to ${all.overrun}  · device ×${DEVICE}`;
console.log(summary);
fs.writeFileSync('tracker-report.txt', lines.join('\n') + summary + '\n');
