// The Sheikh's recitation engine for the classroom, taken from the Hifz test page of
// Qa-af Wal Quran-ul-Majeed (src/pages/test/index.astro) and extended for two kinds of session:
//
//   hifz     The Sheikh recites the opening of a random ayah; the words are hidden and appear as the
//            student recites them from memory, until the Sheikh stops them. Several questions.
//   reading  Mujawwadah: the mushaf page is shown; the student reads from the start of the range and
//            each word turns green as it is read correctly. One pass through the range.
//
// All drawing outside the mushaf page is done by the page through the `ui` callbacks.
import { getJson, pad, audioUrl, wordAudioUrl } from './client.mjs';
import { tokenize, normalize, matchAt, THRESHOLDS } from './recite.mjs';
import { createFollower } from './follow.mjs';
import { tuneRecognition, setExpected, phrasesRefused } from './speech.mjs';
import { buildPaper, fitPaper } from './mushaf.mjs';
import { LEVELS, newTally } from './session.mjs';
import { phrase, praiseFor, speak, stopVoice } from './phrases.mjs';

const AR = '٠١٢٣٤٥٦٧٨٩';
const arNum = (n) => String(n).replace(/\d/g, (d) => AR[d]);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const STANDARD_WORDS = 60;   // roughly half a mushaf page

export function createEngine({ stage, SR, level = 'intermediate', reciter, gender = '', speakInstructions = true, ui }) {
  const L = LEVELS[level] ?? LEVELS.intermediate;
  const threshold = () => THRESHOLDS[L.checking] ?? THRESHOLDS.normal;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let mode = 'hifz';
  let meta = null;
  let scopeAyahs = [];
  let questions = [];
  let qi = -1;
  let phase = 'idle';    // idle | sheikh | answer | paused | stopped | done
  let pausedFrom = null;
  let items = [], flat = [], pos = 0, shownPage = 0, wrongStreak = 0;
  let q = null;
  const tally = newTally();
  const ayahMarks = new Map();   // "s:a" → { label, marks: Set }
  let inReplay = false;
  let startedAt = 0;

  const markAyah = (w, kind) => {
    const it = w.item;
    if (!it.a) return;
    if (!ayahMarks.has(it.key)) ayahMarks.set(it.key, { s: it.s, a: it.a, label: it.label, marks: new Set() });
    if (kind) ayahMarks.get(it.key).marks.add(kind);
  };
  const note = (kind, w, extra = {}) => ui.note?.({ kind, word: w?.display ?? '', key: w ? `${w.item.s}:${w.item.a}` : '', label: w?.item.label ?? '', ayah: w?.item.a ?? 0, ...extra });

  // ── building questions ──────────────────────────────────────
  function makeItem(s, sura, ay, isBism) {
    const it = isBism
      ? { s, a: 0, key: `${s}:0`, label: `${sura.en}, Bismillah`, ar: sura.bismillah, page: ay.page }
      : { s, a: ay.a, key: `${s}:${ay.a}`, label: `${sura.en} ${s}:${ay.a}`, ar: ay.ar, page: ay.page };
    it.words = tokenize(it.ar, it.a ? it.key : null);
    it.words.forEach((w, i) => Object.assign(w, { item: it, wi: i, state: mode === 'reading' ? 'todo' : 'hidden', page: it.page, mistake: false }));
    return it;
  }
  function buildQuestion(qn) {
    const out = [];
    let ayahs = 0, words = 0;
    for (let k = qn.start; k < scopeAyahs.length && k <= qn.end; k++) {
      const { s, sura, ay } = scopeAyahs[k];
      if (k > qn.start && ay.a === 1 && sura.bismillah && s !== 1) out.push(makeItem(s, sura, ay, true));
      if (mode === 'reading' && k === qn.start && ay.a === 1 && sura.bismillah && s !== 1) out.push(makeItem(s, sura, ay, true));
      const it = makeItem(s, sura, ay, false);
      out.push(it);
      ayahs++; words += it.words.length;
      if (mode === 'hifz' && qn.span && (ayahs >= qn.span || (qn.standard && words >= STANDARD_WORDS))) break;
    }
    return out;
  }

  async function loadScope(range) {
    meta ??= await getJson('meta.json');
    const out = [];
    let { s1, s2, a1 = 1, a2 = null } = range;
    if (s2 < s1) [s1, s2] = [s2, s1];
    for (let s = s1; s <= s2; s++) {
      const sura = await getJson(`surah/${pad(s)}.json`);
      for (const ay of sura.ayahs) {
        if (s === s1 && ay.a < a1) continue;
        if (s === s2 && a2 && ay.a > a2) continue;
        out.push({ s, sura, ay });
      }
    }
    return out;
  }

  // ── starting ────────────────────────────────────────────────
  async function startHifz(range, { questionsN = null, span = null } = {}) {
    mode = 'hifz';
    scopeAyahs = await loadScope(range);
    if (!scopeAyahs.length) throw new Error('There are no ayahs in that range.');
    const pages = new Set(scopeAyahs.map((x) => x.ay.page)).size;
    let n = questionsN ? Math.min(20, Math.max(1, questionsN)) : Math.min(10, Math.max(1, Math.round(pages / 2)));
    const sp = span || 5;
    n = Math.max(1, Math.min(n, Math.floor(scopeAyahs.length / sp) || 1));
    const starts = [];
    for (let k = 0; k < n; k++) {
      const lo = Math.floor((k * scopeAyahs.length) / n);
      const hi = Math.max(lo, Math.floor(((k + 1) * scopeAyahs.length) / n) - 1);
      const last = Math.max(lo, hi - sp + 1);
      starts.push(lo + Math.floor(Math.random() * (last - lo + 1)));
    }
    questions = starts.map((start, k) => ({ start, end: Math.max(start, Math.floor(((k + 1) * scopeAyahs.length) / n) - 1), span: sp, standard: !span }));
    for (let k = questions.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [questions[k], questions[j]] = [questions[j], questions[k]]; }
    qi = -1;
    startedAt = Date.now();
    nextQuestion();
    return { questions: questions.length };
  }

  async function startReading(range) {
    mode = 'reading';
    scopeAyahs = await loadScope(range);
    if (!scopeAyahs.length) throw new Error('There are no ayahs in that range.');
    questions = [{ start: 0, end: scopeAyahs.length - 1 }];
    qi = -1;
    startedAt = Date.now();
    nextQuestion();
    return { questions: 1 };
  }

  async function nextQuestion() {
    stopListening();
    clearSilence();
    qi++;
    if (qi >= questions.length) return finish();
    q = questions[qi];
    q.items = buildQuestion(q);
    q.stats = { words: 0, first: 0, prompts: 0, help: 0, skipped: false };
    items = q.items; flat = items.flatMap((it) => it.words);
    q.flat = flat;
    pos = 0; wrongStreak = 0; queue.length = 0; follower.clearBack();
    ui.progress?.({ qi, n: questions.length, mode });
    await renderPage(flat[0].page, qi > 0);
    if (mode === 'hifz') await sheikhRecites();
    else beginReading();
  }

  function beginReading() {
    phase = 'answer';
    const first = items.find((it) => it.a) ?? items[0];
    say('listening', 'read', `Read from ${first.label}. The Sheikh is listening.`);
    status('Read aloud from the highlighted word. Each word turns green when it is read correctly.');
    updateCurrent();
    startListening();
    armSilence();
  }

  // ── the Sheikh ──────────────────────────────────────────────
  function sheikh(state, ar, en) { ui.sheikh?.(state, ar, en); }
  function status(text, kind = '') { ui.status?.(text, kind); }

  // the Sheikh's words, in the student's gender (see phrases.mjs)
  const P = (key) => phrase(key, gender);
  const say = (state, key, en) => { const p = P(key); sheikh(state, p.ar, en ?? p.en); return p; };
  const speakP = (p) => speak(p, { enabled: speakInstructions });
  function openingWords(it) {
    const n = it.words.length;
    if (n <= 2) return n;
    return Math.min(6, n - 1, Math.max(1, Math.ceil(n / 3)));
  }
  function openingShare(it, k) {
    const len = (w) => w.plain.length + 1;
    const part = it.words.slice(0, k).reduce((t, w) => t + len(w), 0);
    return part / it.words.reduce((t, w) => t + len(w), 0);
  }

  const voice = new Audio();
  async function sheikhRecites(again) {
    phase = 'sheikh';
    stopListening();
    const first = items[0];
    if (!again) {
      const p = say('speaking', 'recitefrom');
      status('The Sheikh is about to recite an ayah. Listen, then start from that same ayah.');
      await speakP(p);
    }
    if (phase === 'done' || phase === 'paused') return;
    const k = openingWords(first);
    sheikh('speaking', P('recitefrom').ar + '…', k < first.words.length ? 'Listen to the opening of the ayah.' : 'Listen to the ayah.');
    const ok = await playAudio(audioUrl(reciter, first.s, first.a), k < first.words.length ? openingShare(first, k) : 1);
    if (phase === 'done' || phase === 'paused') return;
    if (!ok) {
      sheikh('listening', first.words.slice(0, k).map((w) => w.display).join(' ') + ' …', 'The recitation could not be played, so here are the opening words.');
      status('The recitation could not be played. Check your connection.', 'bad');
    } else {
      say('listening', 'goahead', 'Go ahead. Recite that ayah from its start and carry on.');
      status('Your turn. Start from the beginning of the ayah you just heard.');
    }
    phase = 'answer';
    updateCurrent();
    startListening();
    armSilence();
  }

  const LEAD = 0.3, TAIL = 0.3;
  function playAudio(src, share = 1) {
    return new Promise((resolve) => {
      let stopAt = null, fading = false, finished = false;
      const timer = setInterval(() => {
        if (share >= 1 || stopAt === null || fading) return;
        if (voice.currentTime >= stopAt) {
          fading = true;
          let v = 1;
          const fade = setInterval(() => {
            v -= 0.12;
            try { voice.volume = Math.max(0, v); } catch {}
            if (v <= 0) { clearInterval(fade); end(true); }
          }, 35);
        }
      }, 40);
      function end(ok) {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        voice.pause();
        try { voice.volume = 1; } catch {}
        resolve(ok);
      }
      voice.loop = false;
      voice.onloadedmetadata = () => {
        const d = voice.duration;
        if (Number.isFinite(d) && d > 0) stopAt = Math.min(d, LEAD + Math.max(0, d - LEAD - TAIL) * share + 0.25);
      };
      voice.onended = () => end(true);
      voice.onerror = () => end(false);
      voice.onpause = () => { if (!finished && !fading && voice.currentTime > 0 && !voice.ended) end(true); };
      try { voice.volume = 1; } catch {}
      voice.src = src;
      voice.play().catch(() => end(false));
    });
  }

  // ── the mushaf page ─────────────────────────────────────────
  function wordSpan(w) {
    let cls = 'w hidden';
    if (w.state === 'shown') cls = 'w read';
    else if (w.state === 'skipped') cls = 'w out';
    else if (w.state === 'todo' || w.state === 'queued') cls = mode === 'reading' ? 'w todo' : 'w hidden';
    const sp = el('span', cls, w.display);
    if (w.state === 'shown') { if (w.helped) sp.classList.add('helped'); else if (w.mistake) sp.classList.add('weak'); else if (w.unclear) sp.classList.add('unclear'); }
    else if (w.mistake) sp.classList.add('missed');
    w.el = sp;
    return sp;
  }
  function markerSpan(it, a) {
    const mk = el('span', 'mk w' + (it.done || mode === 'reading' ? '' : ' hidden'), `﴿${arNum(a)}﴾`);
    it.mk = mk;
    return mk;
  }
  async function renderPage(p, animate) {
    const map = new Map(items.map((it) => [it.key, it]));
    const paper = await buildPaper(p, { getJson, pad, items: map, wordSpan, markerSpan, script: 'plain' });
    paper.classList.add(mode === 'reading' ? 'context' : 'outlines');
    await swapPaper(paper, animate);
    shownPage = p;
    ui.page?.(p);
  }
  async function swapPaper(paper, animate) {
    stage.replaceChildren(paper);
    await fitPaper(paper);
    if (animate && !reduceMotion && typeof paper.animate === 'function') {
      try { paper.animate([{ opacity: 0, transform: 'translateX(-40px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' }); } catch {}
    }
    stage.scrollTop = 0;
  }
  let fitT;
  const onResize = () => { clearTimeout(fitT); fitT = setTimeout(() => fitPaper(stage.querySelector('.paper')), 150); };
  addEventListener('resize', onResize);

  let lastFollow = 0;
  function follow(node) {
    if (!node) return;
    const now = Date.now();
    if (now - lastFollow < 300) return;
    const r = node.getBoundingClientRect(), box = stage.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom - 60) {
      lastFollow = now;
      stage.scrollBy({ top: r.top - (box.top + box.height * 0.35), behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  // ── writing words ───────────────────────────────────────────
  const queue = [];
  let running = false;
  function enqueue(fn) { queue.push(fn); if (!running) drain(); }
  async function drain() {
    running = true;
    while (queue.length) await queue.shift()();
    running = false;
    updateCurrent();
    if (phase === 'answer' && pos >= flat.length) sheikhStops();
  }
  function revealStep(w) {
    return async () => {
      if (w.page !== shownPage) await renderPage(w.page, true);
      if (!w.el?.isConnected) await renderPage(w.page, false);
      const sp = w.el;
      if (!sp) return;
      const dur = 0;   // words appear the moment they are heard
      sp.classList.remove('hidden', 'todo', 'hint', 'current', 'wrong', 'missed');
      sp.classList.add(w.helped ? 'helped' : w.mistake ? 'weak' : 'fresh');
      if (w.unclear && !w.mistake && !w.helped) sp.classList.add('unclear');
      sp.style.setProperty('--dur', `${dur}ms`);
      sp.classList.add('ink');
      follow(sp);
      w.state = 'shown';
      setTimeout(() => { sp.classList.remove('ink'); sp.style.removeProperty('--dur'); }, dur + 20);
      setTimeout(() => { sp.classList.remove('fresh'); sp.classList.add('read'); if (w.helped) sp.classList.add('helped'); else if (w.mistake) sp.classList.add('weak'); }, dur + 650);
      if (w.wi === w.item.words.length - 1) {
        const it = w.item;
        it.done = true;
        if (it.a && phase === 'answer' && it.words.every((x) => !x.mistake && !x.helped)) { const p = P('ahsant'); sheikh('listening', p.ar, `${p.en} Carry on.`); }
        setTimeout(() => it.mk?.classList.remove('hidden'), dur * 0.6);
      }
    };
  }

  let lastPos = '';
  function updateCurrent() {
    stage.querySelectorAll('.w.current').forEach((x) => x.classList.remove('current'));
    const w = flat[pos];
    if (!w || phase !== 'answer') return;
    if (w.page === shownPage && !w.el?.isConnected && !running) { renderPage(shownPage, false).then(updateCurrent); return; }
    if (w.page !== shownPage && !running && mode === 'reading') { renderPage(w.page, true).then(updateCurrent); return; }
    if (w.page === shownPage) { w.el?.classList.add('current'); follow(w.el); }
    const k = `${w.item.s}:${w.item.a}`;
    if (k !== lastPos) { lastPos = k; ui.where?.({ label: w.item.label, s: w.item.s, a: w.item.a }); setExpected(rec, upcoming()); }
  }

  // kind: undefined (read correctly) | 'help' (hint) | 'prompt' (Sheikh said it) | 'unclear'
  function accept(count, kind) {
    for (let k = 0; k < count && pos < flat.length; k++) {
      const w = flat[pos];
      w.state = 'queued';
      if (kind === 'help') { w.helped = true; q.stats.help++; tally.hint++; markAyah(w, 'hint'); note('hint', w); }
      else if (kind === 'prompt') { w.mistake = true; tally.prompt++; markAyah(w, 'prompt'); note('prompt', w); }
      else if (kind === 'unclear') {
        w.unclear = true; tally.unclear++; markAyah(w, 'unclear'); note('unclear', w);
        if (L.unclearIsMistake) w.mistake = true;
        else if (!w.mistake) { q.stats.first++; tally.first++; }
      }
      else { if (!w.mistake) { q.stats.first++; tally.first++; } markAyah(w); }
      q.stats.words++; tally.words++;
      pos++;
      enqueue(revealStep(w));
    }
    wrongStreak = 0;
    if (kind !== 'prompt') status(kind === 'help' ? 'Shown. Carry on.' : 'Correct. Keep going.', 'good');
    if ((!kind || kind === 'unclear') && phase === 'answer') say('listening', 'carryon');
    updateCurrent();
    armSilence();
  }
  function reject(heard) {
    const w = flat[pos];
    if (!w) return;
    if (!w.mistake) { tally.wrong++; markAyah(w, 'wrong'); note('wrong', w, { heard }); }
    w.mistake = true;
    wrongStreak++;
    if (w.el) { w.el.classList.add('current', 'wrong', 'missed'); setTimeout(() => w.el?.classList.remove('wrong'), 800); }
    status(`Heard “${heard}”. That is not the next word.`, 'bad');
    if (wrongStreak === 1) say('listening', 'takecare');
    else if (wrongStreak === 2) say('listening', 'again');
    if (wrongStreak >= 3) sheikhPrompts();
  }

  let silenceTimer = null;
  function clearSilence() { clearTimeout(silenceTimer); silenceTimer = null; }
  function armSilence() {
    clearSilence();
    if (phase !== 'answer') return;
    silenceTimer = setTimeout(() => { if (phase === 'answer' && !running) sheikhPrompts(); else armSilence(); }, L.silenceMs);
  }
  async function sheikhPrompts() {
    if (phase !== 'answer' || pos >= flat.length) return;
    clearSilence();
    const w = flat[pos];
    q.stats.prompts++;
    phase = 'sheikh';
    stopListening();
    sheikh('prompt', w.display, 'The Sheikh gives you the next word.');
    status('The Sheikh is prompting you with the next word.');
    const ok = w.item.a ? await playAudio(wordAudioUrl(w.item.s, w.item.a, w.wi)) : false;
    if (!ok) await wait(1200);
    if (phase === 'done' || phase === 'paused') return;
    accept(1, 'prompt');
    phase = 'answer';
    say('listening', 'carryon', 'Carry on from there.');
    status('Carry on from there.');
    startListening();
    armSilence();
  }
  async function sheikhStops() {
    phase = 'stopped';
    clearSilence();
    stopListening();
    const st = q.stats;
    const ratio = st.words ? st.first / st.words : 0;
    // praise in the student's gender: Mumtaaz(a), Jayyid jiddan or Ahsanta/Ahsanti, then the Sheikh's word
    const praise = P(praiseFor(ratio, st.prompts, st.help));
    const tail = mode === 'reading' ? P('barakallah') : ratio >= 0.85 ? P('barakallah') : P('revise');
    const head = mode === 'reading' ? null : P('enough');
    const ar = [head?.ar, praise.ar, tail.ar].filter(Boolean).join('، ');
    const en = [mode === 'reading' ? 'You have reached the end of the passage.' : head.en, praise.en, tail.en].join(' ');
    sheikh('stop', ar, en);
    status(mode === 'reading' ? 'Reading complete.' : 'Question complete.', 'good');
    ui.questionDone?.({ qi, n: questions.length });
    chime();
    if (head) await speakP(head);
    await speakP(praise);
    await speakP(tail);
    if (qi + 1 < questions.length) {
      await wait(2500);
      if (phase === 'stopped' && questions[qi] === q) nextQuestion();
    } else {
      await wait(1500);
      if (phase === 'stopped') {
        if (mode === 'hifz') { const p = say('stop', 'testover'); await speakP(p); }
        if (phase === 'stopped') finish();
      }
    }
  }
  function chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.65);
    } catch {}
  }

  // ── the end ─────────────────────────────────────────────────
  function passageText() {
    const bySurah = new Map();
    for (const x of questions) for (const w of x.flat ?? []) {
      if (w.state !== 'shown' || !w.item.a) continue;
      if (!bySurah.has(w.item.s)) bySurah.set(w.item.s, { en: scopeAyahs.find((y) => y.s === w.item.s)?.sura.en ?? String(w.item.s), ayahs: new Set() });
      bySurah.get(w.item.s).ayahs.add(w.item.a);
    }
    const parts = [];
    let count = 0;
    for (const [, v] of [...bySurah].sort((a, b) => a[0] - b[0])) {
      const xs = [...v.ayahs].sort((a, b) => a - b);
      count += xs.length;
      const runs = [];
      for (const a of xs) { const r = runs[runs.length - 1]; if (r && a === r[1] + 1) r[1] = a; else runs.push([a, a]); }
      parts.push(`${v.en} ${runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')}`);
    }
    return { text: parts.join('; '), count };
  }
  function finish() {
    if (phase === 'done') return;
    phase = 'done';
    clearSilence(); stopListening(); voice.pause(); stopVoice();
    removeEventListener('resize', onResize);
    const asked = questions.filter((x) => x.stats);
    const passage = passageText();
    const perAyah = [...ayahMarks.values()].sort((a, b) => a.s - b.s || a.a - b.a).map((x) => ({ ...x, marks: [...x.marks] }));
    const weakAyahs = perAyah.filter((x) => x.marks.some((m) => m === 'wrong' || m === 'prompt')).map((x) => `${x.s}:${x.a}`);
    ui.finished?.({ mode, tally: { ...tally }, questions: asked.length, passage: passage.text, ayahCount: passage.count, perAyah, weakAyahs, ms: Date.now() - startedAt });
  }

  // ── listening ───────────────────────────────────────────────
  let rec = null, listening = false;
  const upcoming = () => flat.slice(pos, pos + 40).map((w) => w.display);
  const follower = createFollower({
    getFlat: () => flat,
    getPos: () => pos,
    threshold,
    accept: (n, kind) => accept(n, kind),
    wrong: (heard) => reject(heard),
    replay: (idx) => {
      if (!inReplay) { inReplay = true; tally.back++; const w = flat[idx]; if (w) { markAyah(w, 'back'); note('back', w); } }
      const w = flat[idx]; if (w?.el && w.page === shownPage) w.el.classList.add('replay');
      status('Going back over it…', 'good');
    },
    endReplay: () => { inReplay = false; setTimeout(() => stage.querySelectorAll('.w.replay').forEach((x) => x.classList.remove('replay')), 900); },
    skipOptional: (spoken, i, th) => {
      const w = flat[pos];
      if (!w || w.item.a !== 0 || w.wi !== 0) return null;
      const after = pos + w.item.words.length;
      if (!flat[after] || !matchAt(spoken, i, flat, after, th).n) return null;
      w.item.words.forEach((x) => { x.state = 'skipped'; if (x.el) x.el.className = 'w out'; });
      pos = after;
      return pos;
    },
  });
  function startListening() {
    if (!SR || listening) return;
    rec = tuneRecognition(new SR(), { expect: upcoming() });
    rec.lang = 'ar-SA';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    follower.reset();
    const me = rec;
    rec.onresult = (e) => { if (me === rec && phase === 'answer') { armSilence(); follower.handle(e.results, e.resultIndex); } };
    rec.onerror = (e) => {
      if (phrasesRefused(e)) return;   // biasing not supported here: the restart below carries on without it
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { listening = false; ui.mic?.(false); status('Microphone access is blocked. Allow the microphone for this site in the browser settings.', 'bad'); }
      else if (e.error === 'network') status('The speech service could not be reached. Check your internet connection.', 'bad');
    };
    rec.onend = () => { if (listening && me === rec) { follower.reset(); try { rec.start(); } catch {} } };
    try { rec.start(); listening = true; ui.mic?.(true); } catch { status('Could not start the microphone. Reload the page and try again.', 'bad'); }
  }
  function stopListening() {
    listening = false;
    try { rec?.stop(); } catch {}
    ui.mic?.(false);
  }

  // ── controls the page can call ──────────────────────────────
  return {
    startHifz, startReading,
    get phase() { return phase; },
    get mode() { return mode; },
    get hintsAllowed() { return L.hints; },
    hint() { if (L.hints && phase === 'answer' && pos < flat.length) accept(1, 'help'); },
    async repeatOpening() { if (mode === 'hifz' && phase === 'answer') { clearSilence(); await sheikhRecites(true); } },
    async listen() {
      // reading mode: hear the current ayah from the Sheikh's voice
      if (phase !== 'answer') return;
      const w = flat[pos];
      if (!w?.item.a) return;
      clearSilence(); stopListening(); phase = 'sheikh';
      say('speaking', 'listen', `Listen to ${w.item.label}.`);
      await playAudio(audioUrl(reciter, w.item.s, w.item.a));
      if (phase !== 'sheikh') return;
      phase = 'answer';
      say('listening', 'goahead', 'Now read it yourself.');
      startListening(); armSilence();
    },
    restartAyah() {
      if (phase !== 'answer' || mode !== 'reading') return;
      const w = flat[pos];
      if (!w) return;
      follower.reset();
      status(`Start ${w.item.label} again from its first word.`);
    },
    skip() { if (q && phase !== 'done' && mode === 'hifz') { q.stats.skipped = true; nextQuestion(); } },
    toggleMic() {
      if (listening) { stopListening(); clearSilence(); status('Microphone paused. Press it to carry on.'); }
      else if (phase === 'answer') { startListening(); armSilence(); status('Listening. Carry on.'); }
    },
    pause(reason) {
      if (phase === 'done' || phase === 'paused') return false;
      pausedFrom = phase === 'answer' || phase === 'sheikh' ? 'answer' : phase;
      phase = 'paused';
      clearSilence(); stopListening(); voice.pause(); stopVoice();
      if (reason === 'away') { tally.lookAways++; const w = flat[pos]; if (w) markAyah(w, 'away'); note('away', w); }
      return true;
    },
    resume() {
      if (phase !== 'paused') return;
      phase = pausedFrom === 'stopped' ? 'stopped' : 'answer';
      if (phase === 'answer') { say('listening', 'carryon', 'Carry on from where you stopped.'); status('Carry on from where you stopped.'); updateCurrent(); startListening(); armSilence(); }
    },
    addAwayTime(ms) { tally.awayMs += ms; },
    end() { finish(); },
  };
}
