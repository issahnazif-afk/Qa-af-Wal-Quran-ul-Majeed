// Builds the JSON files the classroom needs into public/data/, from files committed in sources/.
// No network access is needed, so it runs the same on a laptop and in GitHub Actions.
//
// Inputs
//   sources/tanzil/quran-uthmani.xml       Arabic text (Tanzil, committed, never edited)
//   sources/qul/layout-qpc-v2-15.json      Mushaf layout, 604 pages × 15 lines (QUL)
//   sources/surah-names.json               English surah names
//
// Outputs
//   meta.json          surahs, page starts, juz starts, whether the speech model is present
//   surah/NNN.json     ayahs with their page and juz
//   layout/NNN.json    the lines of each mushaf page

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../src/lib/recite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data');
const pad = (n) => String(n).padStart(3, '0');

const TANZIL_NOTICE =
  'Tanzil Quran Text (Uthmani, Version 1.1). Copyright (C) 2007-2026 Tanzil Project. ' +
  'License: Creative Commons Attribution 3.0. Verbatim copies only; changing the text is not allowed. ' +
  'Source: https://tanzil.net';

// The first ayah of each juz (Hafs, Madani mushaf)
const JUZ_STARTS = [
  [1, 1], [2, 142], [2, 253], [3, 93], [4, 24], [4, 148], [5, 82], [6, 111], [7, 88], [8, 41],
  [9, 93], [11, 6], [12, 53], [15, 1], [17, 1], [18, 75], [21, 1], [23, 1], [25, 21], [27, 56],
  [29, 46], [33, 31], [36, 28], [39, 32], [41, 47], [46, 1], [51, 31], [58, 1], [67, 1], [78, 1],
];

async function writeJson(rel, obj) {
  const file = path.join(OUT, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj));
}

async function readTanzil() {
  const xml = await fs.readFile(path.join(ROOT, 'sources/tanzil/quran-uthmani.xml'), 'utf8');
  const surahs = [];
  const suraRe = /<sura index="(\d+)" name="([^"]+)">([\s\S]*?)<\/sura>/g;
  const ayaRe = /<aya index="(\d+)" text="([^"]+)"(?: bismillah="([^"]+)")?\s*\/>/g;
  let m;
  while ((m = suraRe.exec(xml))) {
    const ayahs = [];
    let bismillah = null;
    let a;
    while ((a = ayaRe.exec(m[3]))) {
      if (a[3]) bismillah = a[3];
      ayahs.push({ a: +a[1], ar: a[2] });
    }
    surahs.push({ n: +m[1], ar: m[2], bismillah, ayahs });
  }
  const total = surahs.reduce((t, s) => t + s.ayahs.length, 0);
  if (surahs.length !== 114 || total !== 6236) throw new Error(`Tanzil check failed: ${surahs.length} surahs, ${total} ayahs`);
  console.log('✓ Tanzil text: 114 surahs, 6236 ayahs');
  return surahs;
}

// Word ids in the layout count every word plus one ayah-end marker per ayah, in mushaf order.
async function readLayout(tanzil) {
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'sources/qul/layout-qpc-v2-15.json'), 'utf8'));
  const ref = [null];
  for (const s of tanzil) for (const x of s.ayahs) {
    const n = tokenize(x.ar, `${s.n}:${x.a}`).length;
    for (let i = 0; i < n; i++) ref.push([s.n, x.a, i]);
    ref.push([s.n, x.a, -1]);
  }
  const maxId = Math.max(...raw.lines.map((l) => l[5]));
  if (ref.length - 1 !== maxId) throw new Error(`Layout check failed: ${ref.length - 1} words in the text, ${maxId} in the layout`);
  const pages = new Map();
  let lastSurah = 0;
  for (const [p, , t, c, f, la, s] of raw.lines) {
    if (!pages.has(p)) pages.set(p, []);
    if (t === 's') { lastSurah = s; pages.get(p).push({ t: 's', s }); }
    else if (t === 'b') pages.get(p).push({ t: 'b', s: lastSurah });
    else pages.get(p).push({ t: 'a', c: c ? 1 : 0, w: ref.slice(f, la + 1) });
  }
  const pageOf = {};
  for (const [p, lines] of pages) for (const l of lines) if (l.t === 'a') for (const [s, a] of l.w) pageOf[`${s}:${a}`] ??= p;
  if (pages.size !== 604) throw new Error(`Layout check failed: ${pages.size} pages`);
  console.log(`✓ Mushaf layout: ${pages.size} pages, ${raw.lines.length} lines`);
  return { pages, pageOf };
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  const tanzil = await readTanzil();
  const names = JSON.parse(await fs.readFile(path.join(ROOT, 'sources/surah-names.json'), 'utf8'));
  if (names.length !== 114) throw new Error('sources/surah-names.json must list 114 names');
  const layout = await readLayout(tanzil);

  const juzStart = new Map(JUZ_STARTS.map(([s, a], i) => [`${s}:${a}`, i + 1]));
  let juz = 0;
  const juzOf = {};
  for (const s of tanzil) for (const x of s.ayahs) { juz = juzStart.get(`${s.n}:${x.a}`) ?? juz; juzOf[`${s.n}:${x.a}`] = juz; }

  const pageStarts = [...layout.pages.keys()].sort((x, y) => x - y).map((p) => {
    const first = layout.pages.get(p).find((l) => l.t === 'a').w[0];
    return { n: p, s: first[0], a: first[1] };
  });
  const surahIndex = tanzil.map((s) => ({ n: s.n, ar: s.ar, en: names[s.n - 1], ayahs: s.ayahs.length, page: layout.pageOf[`${s.n}:1`] }));

  await writeJson('meta.json', {
    surahs: surahIndex,
    pages: pageStarts,
    juzs: JUZ_STARTS.map(([s, a], i) => ({ n: i + 1, s, a })),
    localAsr: await fs.access(path.join(ROOT, 'public', 'models', 'qaaf-asr.onnx')).then(() => true, () => false),
    _copyright: TANZIL_NOTICE,
  });
  for (const s of tanzil) {
    const info = surahIndex[s.n - 1];
    const ayahs = s.ayahs.map((x) => ({ a: x.a, ar: x.ar, juz: juzOf[`${s.n}:${x.a}`], page: layout.pageOf[`${s.n}:${x.a}`] }));
    await writeJson(`surah/${pad(s.n)}.json`, { ...info, bismillah: s.bismillah, ayahs, _copyright: TANZIL_NOTICE });
  }
  for (const [p, lines] of layout.pages) {
    const first = lines.find((l) => l.t === 'a').w[0];
    await writeJson(`layout/${pad(p)}.json`, { p, juz: juzOf[`${first[0]}:${first[1]}`], lines });
  }
  console.log('✓ Wrote public/data/');
}

main().catch((e) => { console.error(e); process.exit(1); });
