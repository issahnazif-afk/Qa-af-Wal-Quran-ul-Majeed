// Copies the MediaPipe runtime (used for the look-away check) into public/mediapipe/, so the
// site serves it itself instead of loading it from a CDN.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm');
const OUT = path.join(ROOT, 'public/mediapipe');
await fs.mkdir(OUT, { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  await fs.copyFile(path.join(SRC, f), path.join(OUT, f));
}
console.log('✓ MediaPipe runtime copied to public/mediapipe/');

// Recordings the school adds (the Sheikh's phrases, letter names, anasheed): write a list per folder, so the
// site only asks for recordings that exist.
for (const dir of ['sheikh', 'letters', 'nasheed']) {
  const AUD = path.join(ROOT, 'public/audio', dir);
  await fs.mkdir(AUD, { recursive: true });
  const clips = (await fs.readdir(AUD)).filter((f) => f.endsWith('.mp3')).map((f) => f.replace(/\.mp3$/, ''));
  await fs.writeFile(path.join(AUD, 'recordings.json'), JSON.stringify(clips));
  console.log(`✓ audio/${dir}: ${clips.length} recording(s)`);
}
