// Build-time helpers: read the JSON produced by scripts/build-data.mjs.
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'public', 'data');
const cache = new Map();
export const pad = (n) => String(n).padStart(3, '0');

function read(rel) {
  if (!cache.has(rel)) {
    const file = path.join(DATA, rel);
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run "npm run data" first.`);
    cache.set(rel, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return cache.get(rel);
}

export const getMeta = () => read('meta.json');
export const getSurah = (n) => read(`surah/${pad(n)}.json`);

// All ayahs on one mushaf page, in reading order.
export function getPage(p) {
  const start = getMeta().pages[p - 1];
  const out = [];
  for (let s = start.s; s <= 114; s++) {
    const sura = getSurah(s);
    for (const ay of sura.ayahs) {
      if (s === start.s && ay.a < start.a) continue;
      if (ay.page > p) return out;
      if (ay.page === p) out.push({ s, sura, ay });
    }
  }
  return out;
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const arNum = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[d]);

export const getLayout = (p) => read(`layout/${pad(p)}.json`);
