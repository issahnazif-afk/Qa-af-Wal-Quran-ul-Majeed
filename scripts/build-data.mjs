// Builds every JSON file the site needs into public/data/.
// Runs automatically in GitHub Actions before `astro build`.
//
// Inputs
//   sources/tanzil/quran-uthmani.xml               Arabic text (committed, never edited)
//   sources/corpus/quranic-corpus-morphology-0_4.txt  Morphology (committed, never edited)
//   https://api.alquran.cloud/v1/meta               Surah names, page/juz boundaries
//   https://api.alquran.cloud/v1/quran/<edition>    Translations listed in site.config.mjs
//   Quran Foundation API (optional, needs secrets)  Word-by-word meanings
//
// Downloaded responses are cached in .cache/ so local re-runs are fast.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cfg from '../site.config.mjs';
import { tokenize, qpc } from '../src/lib/recite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data');
const CACHE = path.join(ROOT, '.cache');
const pad = (n) => String(n).padStart(3, '0');

const TANZIL_NOTICE =
  'Tanzil Quran Text (Uthmani, Version 1.1). Copyright (C) 2007-2026 Tanzil Project. ' +
  'License: Creative Commons Attribution 3.0. Verbatim copies only; changing the text is not allowed. ' +
  'Source: https://tanzil.net';
const CORPUS_NOTICE =
  'Quranic Arabic Corpus (morphology, version 0.4). Copyright (C) 2011 Kais Dukes. ' +
  'License: GNU General Public License. Source: http://corpus.quran.com';

// ── helpers ───────────────────────────────────────────────────
async function writeJson(rel, obj) {
  const file = path.join(OUT, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj));
}

async function getJson(url, cacheName, { headers = {}, tries = 4 } = {}) {
  const cacheFile = cacheName ? path.join(CACHE, cacheName) : null;
  if (cacheFile) {
    try { return JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch {}
  }
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const json = await res.json();
      if (cacheFile) {
        await fs.mkdir(CACHE, { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(json));
      }
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`  retry ${i}/${tries}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

// Plain Arabic for search: no diacritics, unified letter forms.
export function plainArabic(s) {
  return s
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[ٱأإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extended Buckwalter → Arabic (as used by the Quranic Arabic Corpus)
const BW = {
  "'": 'ء', '>': 'أ', '&': 'ؤ', '<': 'إ', '}': 'ئ', A: 'ا', b: 'ب', p: 'ة', t: 'ت', v: 'ث',
  j: 'ج', H: 'ح', x: 'خ', d: 'د', '*': 'ذ', r: 'ر', z: 'ز', s: 'س', $: 'ش', S: 'ص',
  D: 'ض', T: 'ط', Z: 'ظ', E: 'ع', g: 'غ', _: 'ـ', f: 'ف', q: 'ق', k: 'ك', l: 'ل',
  m: 'م', n: 'ن', h: 'ه', w: 'و', Y: 'ى', y: 'ي', F: 'ً', N: 'ٌ', K: 'ٍ', a: 'َ',
  u: 'ُ', i: 'ِ', '~': 'ّ', o: 'ْ', '^': 'ٓ', '#': 'ٔ', '`': 'ٰ', '{': 'ٱ', ':': 'ۜ',
  '@': '۟', '"': '۠', '[': 'ۢ', ';': 'ۣ', ',': 'ۥ', '.': 'ۦ', '!': 'ۨ', '-': '۪',
  '+': '۫', '%': '۬', ']': 'ۭ',
};
const bw = (s) => [...s].map((c) => BW[c] ?? c).join('');

// ── 1. Arabic text from Tanzil ────────────────────────────────
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
  if (surahs.length !== 114 || total !== 6236) {
    throw new Error(`Tanzil check failed: ${surahs.length} surahs, ${total} ayahs (expected 114 / 6236)`);
  }
  console.log('✓ Tanzil text: 114 surahs, 6236 ayahs');
  return surahs;
}

// ── 2. Metadata from AlQuran.cloud ────────────────────────────
async function readMeta() {
  const j = await getJson('https://api.alquran.cloud/v1/meta', 'meta.json');
  const d = j.data;
  console.log(`✓ Metadata: ${d.pages.references.length} pages, ${d.juzs.references.length} juz`);
  return d;
}

// ── 3. Translations ───────────────────────────────────────────
async function readTranslation(id) {
  const j = await getJson(`https://api.alquran.cloud/v1/quran/${id}`, `tr-${id}.json`);
  const bySurah = {};
  let juzPage = {};
  for (const s of j.data.surahs) {
    bySurah[s.number] = s.ayahs.map((x) => x.text);
    for (const x of s.ayahs) juzPage[`${s.number}:${x.numberInSurah}`] = { juz: x.juz, page: x.page };
  }
  console.log(`✓ Translation ${id}`);
  return { bySurah, juzPage, edition: j.data.edition };
}

// ── 4. Morphology ─────────────────────────────────────────────
async function readMorphology() {
  const txt = await fs.readFile(path.join(ROOT, 'sources/corpus/quranic-corpus-morphology-0_4.txt'), 'utf8');
  const out = {}; // surah -> ayah -> [words]
  let rows = 0;
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\((\d+):(\d+):(\d+):(\d+)\)\t([^\t]*)\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    rows++;
    const [, s, a, w, , form, tag, feat] = m;
    const ay = ((out[s] ??= {})[a] ??= []);
    const word = (ay[+w - 1] ??= { ar: '', segs: [] });
    word.ar += bw(form);
    const f = feat.split('|');
    const root = f.find((x) => x.startsWith('ROOT:'));
    const lem = f.find((x) => x.startsWith('LEM:'));
    if (root) word.root = [...bw(root.slice(5))].join(' ');
    if (lem) word.lem = bw(lem.slice(4));
    word.segs.push({ ar: bw(form), tag, f: f.filter((x) => !/^(ROOT|LEM):/.test(x)).join('|') });
  }
  console.log(`✓ Morphology: ${rows} segments`);
  return out;
}

// ── 5. Quran Foundation (optional, needs QF_CLIENT_ID / QF_CLIENT_SECRET) ──
async function qfSession() {
  const qf = cfg.quranFoundation;
  const id = process.env.QF_CLIENT_ID;
  const secret = process.env.QF_CLIENT_SECRET;
  if (!qf?.enabled || !id || !secret) return null;
  const tokRes = await fetch(qf.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=content',
  });
  if (!tokRes.ok) throw new Error(`token request failed: HTTP ${tokRes.status}`);
  const { access_token } = await tokRes.json();
  return { qf, headers: { 'x-auth-token': access_token, 'x-client-id': id } };
}

async function readWordByWord(session) {
  if (!session) { console.log('– Word by word skipped (QF_CLIENT_ID / QF_CLIENT_SECRET not set)'); return null; }
  const { qf, headers } = session;
  try {
    const all = {};
    for (let n = 1; n <= 114; n++) {
      const verses = {};
      let page = 1, totalPages = 1;
      do {
        const url = `${qf.apiBase}/verses/by_chapter/${n}?words=true&per_page=50&page=${page}` +
          `&language=${qf.wordTranslationLanguage}&word_fields=text_uthmani`;
        const j = await getJson(url, `wbw-${pad(n)}-${page}.json`, { headers });
        for (const v of j.verses) {
          verses[v.verse_number] = v.words
            .filter((w) => w.char_type_name === 'word')
            .map((w) => ({ t: w.translation?.text ?? '', tl: w.transliteration?.text ?? '' }));
        }
        totalPages = j.pagination?.total_pages ?? 1;
        page++;
      } while (page <= totalPages);
      all[n] = verses;
    }
    console.log('✓ Word by word (Quran Foundation)');
    return all;
  } catch (e) {
    console.warn(`– Word by word skipped: ${e.message}`);
    return null;
  }
}

// Tajweed-coloured text, one HTML snippet per word. Only <span class="tj-…"> survives sanitising.
export function tajweedWords(html, tanzilText = false) {
  const src = html.replace(/<span class=["']?end["']?>[^<]*<\/span>/g, '').trim();
  const words = [];
  const open = [];          // tajweed classes currently open
  let cur = '';
  const reopen = () => open.map((c) => `<span class="tj-${c}">`).join('');
  const close = () => '</span>'.repeat(open.length);
  const flush = () => {
    const w = cur + close();
    const txt = w.replace(/<[^>]+>/g, '');
    // pause marks stay with the word before them, as in tokenize()
    if (!/[\u0621-\u063A\u0641-\u064A\u0671]/.test(txt)) { if (txt.trim() && words.length) words[words.length - 1] += ' ' + w; }
    else words.push(w);
    cur = reopen();
  };
  for (const part of src.split(/(<[^>]+>)/)) {
    if (!part) continue;
    if (part.startsWith('<')) {
      const m = /^<tajweed\s+class=["']?([a-z_]+)["']?\s*>$/i.exec(part);
      if (m) { const c = m[1].toLowerCase(); open.push(c); cur += `<span class="tj-${c}">`; }
      else if (/^<\/tajweed>$/i.test(part) && open.length) { open.pop(); cur += '</span>'; }
      continue;   // any other tag is dropped
    }
    const clean = part.replace(/[<>&"]/g, '');
    (tanzilText ? qpc(clean) : clean).split(' ').forEach((txt, k) => { if (k > 0) flush(); cur += txt; });
  }
  flush();
  return words;
}

// AlQuran.cloud "quran-tajweed": rules are marked as [x[letters] or [x:123[letters]
const ALQ_RULES = { h: 'ham_wasl', s: 'slnt', l: 'laam_shamsiyah', n: 'madda_normal', p: 'madda_permissible',
  m: 'madda_necessary', o: 'madda_obligatory', q: 'qalaqah', c: 'ikhafa_shafawi', f: 'ikhafa', w: 'idgham_shafawi',
  i: 'iqlab', a: 'idgham_ghunnah', u: 'idgham_wo_ghunnah', d: 'idgham_mutajanisayn', b: 'idgham_mutaqaribayn', g: 'ghunnah' };
const alqToTags = (t) => t.replace(/\[([a-z])(?::\d+)?\[([^\]]*)\]/g, (m, k, x) => ALQ_RULES[k] ? `<tajweed class=${ALQ_RULES[k]}>${x}</tajweed>` : x);

async function readTajweedAlq(tanzil) {
  try {
    const j = await getJson('https://api.alquran.cloud/v1/quran/quran-tajweed', 'tr-quran-tajweed.json');
    const all = {};
    let ok = 0, bad = 0;
    for (const sj of j.data.surahs) {
      const s = tanzil[sj.number - 1];
      const out = {};
      for (const x of sj.ayahs) {
        // the first ayah of each surah may carry the Bismillah in front
        let src = x.text;
        const words = tajweedWords(alqToTags(src), true);
        const expected = tokenize(s.ayahs[x.numberInSurah - 1].ar, `${s.n}:${x.numberInSurah}`).length;
        let fit = words.length === expected ? words : words.length === expected + 4 && x.numberInSurah === 1 && s.n !== 1 ? words.slice(4) : null;
        if (fit) { out[x.numberInSurah] = fit; ok++; } else bad++;
      }
      all[sj.number] = out;
    }
    console.log(`✓ Tajweed text (AlQuran.cloud): ${ok} ayahs${bad ? `, ${bad} kept plain (word count did not match)` : ''}`);
    return ok > 6000 ? all : null;
  } catch (e) {
    console.warn(`– Tajweed from AlQuran.cloud unavailable: ${e.message}`);
    return null;
  }
}

async function readTajweed(session, tanzil) {
  const alq = await readTajweedAlq(tanzil);
  if (alq) return alq;
  if (!session) { console.log('– Tajweed text skipped (no other source; add QF_CLIENT_ID / QF_CLIENT_SECRET to try Quran Foundation)'); return null; }
  const { qf, headers } = session;
  const all = {};
  let ok = 0, bad = 0;
  try {
    for (const s of tanzil) {
      let verses;
      try {
        const j = await getJson(`${qf.apiBase}/quran/verses/uthmani_tajweed?chapter_number=${s.n}`, `tj-${pad(s.n)}.json`, { headers });
        verses = j.verses.map((v) => [Number(String(v.verse_key).split(':')[1]), v.text_uthmani_tajweed]);
      } catch {
        verses = [];
        let page = 1, totalPages = 1;
        do {
          const j = await getJson(`${qf.apiBase}/verses/by_chapter/${s.n}?per_page=50&page=${page}&fields=text_uthmani_tajweed`, `tjv-${pad(s.n)}-${page}.json`, { headers });
          for (const v of j.verses) verses.push([v.verse_number, v.text_uthmani_tajweed]);
          totalPages = j.pagination?.total_pages ?? 1;
          page++;
        } while (page <= totalPages);
      }
      const out = {};
      for (const [a, html] of verses) {
        if (!html) continue;
        const words = tajweedWords(html);
        const expected = tokenize(s.ayahs[a - 1].ar, `${s.n}:${a}`).length;
        if (words.length === expected) { out[a] = words; ok++; } else bad++;
      }
      all[s.n] = out;
    }
    console.log(`✓ Tajweed text: ${ok} ayahs${bad ? `, ${bad} skipped (word count did not match the layout)` : ''}`);
    return ok ? all : null;
  } catch (e) {
    console.warn(`– Tajweed text skipped: ${e.message}`);
    return null;
  }
}

// ── 5b. Other riwayat ─────────────────────────────────────────
// The fawazahmed0 copies swap three KFGQPC tanween marks for their Unicode "open" forms; the KFGQPC
// riwayah fonts expect the original marks, so they are swapped back for display.
function riwayahDisplay(t, id) {
  let x = t.replace(/\u08F2/g, '\u0656').replace(/\u08F0/g, '\u0657').replace(/\u08F1/g, '\u065E');
  if (id === 'doori' || id === 'soosi') x = x.replace(/\u065C/g, '\u06ED');
  return x;
}
async function readRiwayat() {
  const out = [];
  for (const r of cfg.riwayat ?? []) {
    try {
      const j = await getJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${r.edition}.json`, `rw-${r.id}.json`);
      const bySurah = {};
      for (const v of j.quran) (bySurah[v.chapter] ??= {})[v.verse] = riwayahDisplay(v.text, r.id);
      const n = Object.values(bySurah).reduce((t, x) => t + Object.keys(x).length, 0);
      if (n !== 6236) throw new Error(`${n} ayahs`);
      out.push({ ...r, bySurah });
      console.log(`✓ Riwayah ${r.name}`);
    } catch (e) {
      console.warn(`– Riwayah ${r.name} skipped: ${e.message}`);
    }
  }
  return out;
}

// ── 6. Mushaf layout (QUL, KFGQPC V2, 604 pages × 15 lines) ───
// Word ids in the layout count every word plus one ayah-end marker per ayah, in mushaf order.
async function readLayout(tanzil) {
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'sources/qul/layout-qpc-v2-15.json'), 'utf8'));
  const ref = [null];                       // word id → [surah, ayah, wordIndex] (-1 = ayah marker)
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
  const pageOf = {};                        // "s:a" → page of its first word
  for (const [p, lines] of pages) for (const l of lines) if (l.t === 'a') for (const [s, a] of l.w) pageOf[`${s}:${a}`] ??= p;
  console.log(`✓ Mushaf layout: ${pages.size} pages, ${raw.lines.length} lines`);
  return { pages, pageOf, source: raw.source };
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  const tanzil = await readTanzil();
  const meta = await readMeta();
  const trs = {};
  for (const t of cfg.translations) trs[t.id] = await readTranslation(t.id);
  const morph = await readMorphology();
  let session = null;
  try { session = await qfSession(); } catch (e) { console.warn(`– Quran Foundation sign-in failed: ${e.message}`); }
  const wbw = await readWordByWord(session);
  const tajweed = await readTajweed(session, tanzil);
  const riwayat = await readRiwayat();
  const layout = await readLayout(tanzil);
  const juzPage = trs[cfg.defaultTranslation].juzPage;
  // the QUL layout decides which page every ayah is on
  for (const k of Object.keys(juzPage)) if (layout.pageOf[k]) juzPage[k].page = layout.pageOf[k];

  const refs = meta.surahs.references;
  const sajdas = new Set(meta.sajdas.references.map((x) => `${x.surah}:${x.ayah}`));
  const pageStarts = [...layout.pages.keys()].sort((x, y) => x - y).map((p) => {
    const first = layout.pages.get(p).find((l) => l.t === 'a').w[0];
    return { n: p, s: first[0], a: first[1] };
  });
  const juzStarts = meta.juzs.references.map((r, i) => ({ n: i + 1, s: r.surah, a: r.ayah }));

  const surahIndex = tanzil.map((s) => {
    const r = refs[s.n - 1];
    return {
      n: s.n, ar: s.ar, en: r.englishName, meaning: r.englishNameTranslation,
      type: r.revelationType, ayahs: s.ayahs.length, page: juzPage[`${s.n}:1`].page,
    };
  });

  await writeJson('meta.json', {
    surahs: surahIndex, pages: pageStarts, juzs: juzStarts,
    translations: cfg.translations, wbw: !!wbw, tajweed: !!tajweed,
    riwayat: riwayat.map(({ id, name, font }) => ({ id, name, font })), _copyright: TANZIL_NOTICE,
  });

  const search = [];
  const fullArabic = [];
  const reciteIndex = []; // plain words per ayah, used to find where a reader is reciting
  for (const s of tanzil) {
    const info = surahIndex[s.n - 1];
    const ayahs = s.ayahs.map((x, i) => {
      const k = `${s.n}:${x.a}`;
      const tr = {};
      for (const t of cfg.translations) tr[t.id] = trs[t.id].bySurah[s.n][i];
      search.push([s.n, x.a, plainArabic(x.ar), tr[cfg.defaultTranslation]]);
      reciteIndex.push([s.n, x.a, tokenize(x.ar, k).map((w) => w.plain).join(' ')]);
      fullArabic.push({ s: s.n, a: x.a, text: x.ar });
      return { a: x.a, ar: x.ar, juz: juzPage[k].juz, page: juzPage[k].page, sajda: sajdas.has(k) || undefined, tr };
    });
    await writeJson(`surah/${pad(s.n)}.json`, { ...info, bismillah: s.bismillah, ayahs, _copyright: TANZIL_NOTICE });
    await writeJson(`morph/${pad(s.n)}.json`, { ...morph[s.n], _copyright: CORPUS_NOTICE });
    if (wbw) await writeJson(`wbw/${pad(s.n)}.json`, wbw[s.n]);
    if (tajweed) await writeJson(`tajweed/${pad(s.n)}.json`, tajweed[s.n] ?? {});
    for (const r of riwayat) await writeJson(`riwayah/${r.id}/${pad(s.n)}.json`, r.bySurah[s.n] ?? {});
  }
  await writeJson('search.json', search);
  for (const [p, lines] of layout.pages) {
    const first = lines.find((l) => l.t === 'a').w[0];
    await writeJson(`layout/${pad(p)}.json`, { p, juz: juzPage[`${first[0]}:${first[1]}`].juz, lines });
  }
  await writeJson('recite-index.json', reciteIndex);

  // Whole-dataset downloads for the Resources page
  await writeJson('download/quran-uthmani.json', { _copyright: TANZIL_NOTICE, ayahs: fullArabic });
  for (const t of cfg.translations) {
    const rows = [];
    for (const s of tanzil) trs[t.id].bySurah[s.n].forEach((text, i) => rows.push({ s: s.n, a: i + 1, text }));
    await writeJson(`download/${t.id}.json`, { edition: trs[t.id].edition, source: 'https://alquran.cloud', ayahs: rows });
  }
  await writeJson('download/metadata.json', { surahs: surahIndex, pages: pageStarts, juzs: juzStarts, sajdas: [...sajdas] });
  console.log(`✓ Wrote public/data/`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => {
  console.error('✗ Data build failed:', e.message);
  process.exit(1);
});
