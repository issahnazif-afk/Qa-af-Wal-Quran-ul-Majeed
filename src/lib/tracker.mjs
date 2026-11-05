// Qāf tracker: follows a reader through a known text using the Qāf model's letter probabilities.
//
// Every update it re-aligns the most recent few seconds of audio frames against a window of the text around
// where the reader is (a semi-global CTC alignment: the reader may be anywhere in the window). Because the whole
// recent stretch is re-aligned each time, an early mistake by the tracker is corrected a moment later instead
// of sending it off course. Things a real reader does are allowed for:
//   pauses and held vowels (blank frames), starting further on, going back to repeat words, and saying
//   something that is not in the text at all (a "filler" path: coughs, a wrong word, the teacher talking).
// Pure JavaScript, no imports: used by the app (in a Web Worker) and by the Node test harness.
//
//   const t = createTracker({ letters, blank, words: ['بسم', 'الله', …] })   plain words of the whole passage
//   t.push(logprobs, n)       n frames (25 a second), each C = letters.length + 1 values
//   t.update() → { pos, frac, word, events }
//      pos     the next word not yet read (everything before it is committed)
//      word    the word the reader is in right now, frac how far into it (0–1): the live cursor
//      events  [{ index, kind: 'read' | 'weak' | 'unclear' | 'missed', score }] words committed by this update
//              (missed: something else was said in its place; unclear: passed too quickly to judge)
//   t.moveTo(i)               the page jumped (a new start point): follow from word i

export function createTracker({ letters, blank, words = [], opts = {} }) {
  const o = {
    history: 100,        // frames re-aligned each time (4 s)
    ahead: 25,           // words of text after the committed position that the reader may be in
    behind: 4,           // words before it (a reader going back over words)
    filler: -2.2,        // per frame cost of "not in the text" (vs. the best letter)
    toFiller: -4, fromFiller: -2,
    jump: -0.6,          // per word, cost of starting away from the committed position
    weak: -1.6,          // average letter margin below which a word counts as weakly read
    endBlanks: 5,        // blank frames after a word's last letter that end it (200 ms): the end of an ayah
    ...opts,
  };
  const C = letters.length + 1, space = letters.indexOf(' ');
  const idx = new Map(letters.map((c, i) => [c, i]));
  const toIds = (w) => { const a = [...w].map((c) => idx.get(c)).filter((x) => x !== undefined && x !== space); return a.length ? a : [idx.get('ا')]; };
  words = words.slice();
  let ids = words.map(toIds);

  const frames = [];       // rolling log-prob frames (Float32Array each)
  let dropped = 0;         // frames already removed from the front (frames[i] is absolute frame dropped + i)
  let anchor = 0;          // absolute frame just before the last committed word ended: the look-back starts here
  let pos = 0;             // committed: words before pos are done
  let started = false;     // a jump forward is only trusted when the reader first begins
  let live = { word: 0, frac: 0 };

  function push(lp, n) { write(dropped + frames.length, lp, n); }
  // write n frames starting at absolute frame `at`: frames already there are replaced (a later look at the audio,
  // having heard more after them, judges them better), new ones are added
  function write(at, lp, n) {
    for (let t = 0; t < n; t++) {
      const k = at + t - dropped;
      if (k < 0) continue;
      const row = lp.slice(t * C, (t + 1) * C);
      if (k < frames.length) frames[k] = row; else { while (frames.length < k) frames.push(row); frames.push(row); }
    }
    const keep = o.history * 3;
    if (frames.length > keep) { const k = frames.length - keep; frames.splice(0, k); dropped += k; }
  }
  function moveTo(i) { pos = Math.max(0, Math.min(words.length, i)); dropped += frames.length; frames.length = 0; anchor = dropped; started = false; live = { word: pos, frac: 0 }; }

  // emissions of one frame: blank (blank or space) and the best free choice
  function emis(f) {
    const b = f[blank], s = space >= 0 ? f[space] : -Infinity;
    const eB = Math.max(b, s) + Math.log1p(Math.exp(-Math.abs(b - s)));
    let free = eB; for (let c = 0; c < C - 1; c++) if (c !== space && f[c] > free) free = f[c];
    return { eB, free };
  }

  function update() {
    const events = [];
    if (!frames.length || pos >= words.length) return { pos, word: live.word, frac: live.frac, events };
    const w0 = Math.max(0, pos - o.behind), w1 = Math.min(words.length, pos + o.ahead);
    // states: 0 = filler; then per word: [letter, blank] × letters (blank after each letter)
    const tok = [0], wOf = [-1], liOf = [-1], nOf = [0], first = [], last = [];
    for (let w = w0; w < w1; w++) {
      first[w] = tok.length;
      ids[w].forEach((id, li) => { tok.push(id, -1); wOf.push(w, w); liOf.push(li, li); nOf.push(ids[w].length, ids[w].length); });
      last[w] = tok.length - 2;
    }
    const S = tok.length;
    const base = Math.max(frames.length - o.history, anchor - dropped, 0), F = frames.length - base;
    if (F < 3) return { pos, word: live.word, frac: live.frac, events };
    let d = new Float64Array(S).fill(-Infinity), nd = new Float64Array(S);
    const bp = new Int32Array(F * S);
    // start: anywhere in the window (a word's first letter), the filler, or the blank before the committed word
    const startCost = (w) => (w >= pos ? (w - pos) * (started ? 4 : 1) : (pos - w)) * o.jump;
    const reenter = (w) => o.fromFiller + (w >= pos ? Math.max(0, w - pos - 1) * 1.5 : (pos - w) * 0.5) * o.jump * 2;
    const e0 = emis(frames[base]);
    d[0] = o.toFiller + e0.free + o.filler;
    for (let w = w0; w < w1; w++) { const s = first[w]; d[s] = startCost(w) + frames[base][tok[s]] - e0.free; }
    if (pos > w0) { const s = last[pos - 1] + 1; d[s] = Math.max(d[s], e0.eB - e0.free); }
    for (let t = 1; t < F; t++) {
      const f = frames[base + t], { eB, free } = emis(f);
      for (let s = 0; s < S; s++) {
        let best = d[s], arg = s;
        if (s === 0) {                                   // filler: from itself, or out of any state
          for (let r = 1; r < S; r++) if (d[r] + o.toFiller > best) { best = d[r] + o.toFiller; arg = r; }
          nd[0] = best + free + o.filler - free; bp[t * S] = arg; continue;
        }
        if (s >= 2 && d[s - 1] > best) { best = d[s - 1]; arg = s - 1; }                       // advance
        if (tok[s] >= 0 && s >= 3 && tok[s - 2] >= 0 && tok[s - 2] !== tok[s] && d[s - 2] > best) { best = d[s - 2]; arg = s - 2; }  // skip a blank
        if (tok[s] >= 0 && liOf[s] === 0) {
          const w = wOf[s];
          if (w > w0) {                                  // from the end of the previous word (letter or its blank)
            const a = last[w - 1];
            if (d[a] > best) { best = d[a]; arg = a; }
            if (d[a + 1] > best) { best = d[a + 1]; arg = a + 1; }
          }
          const v = d[0] + reenter(w);
          if (v > best) { best = v; arg = 0; }
        }
        nd[s] = best + (tok[s] >= 0 ? f[tok[s]] : eB) - free; bp[t * S + s] = arg;
      }
      [d, nd] = [nd, d];
    }
    // where is the reader now: the best final state
    let end = 0; for (let s = 1; s < S; s++) if (d[s] > d[end]) end = s;
    // trace back: which frames went to which word, and how well
    const path = new Int32Array(F); path[F - 1] = end;
    for (let t = F - 1; t > 0; t--) path[t - 1] = bp[t * S + path[t]];
    const seen = new Map();    // word → { score, frames, letters: Set, lastT }
    const fillerBefore = new Map();   // word → filler frames just before the path reached it
    let blanksAtEnd = 0, fill = 0;
    for (let t = 0; t < F; t++) {
      const s = path[t]; if (s === 0) { fill++; continue; }
      if (fill) { const w = wOf[s]; fillerBefore.set(w, (fillerBefore.get(w) ?? 0) + fill); fill = 0; }
      const w = wOf[s]; let r = seen.get(w); if (!r) seen.set(w, (r = { score: 0, n: 0, letters: new Set(), lastT: t }));
      const f = frames[base + t], { eB, free } = emis(f);
      if (tok[s] >= 0) { r.score += f[tok[s]] - free; r.n++; r.letters.add(liOf[s]); }
      r.lastT = t;
    }
    for (let t = F - 1; t >= 0 && path[t] !== 0 && tok[path[t]] < 0; t--) blanksAtEnd++;

    const sNow = end, wNow = sNow === 0 ? live.word : wOf[sNow];
    const n = nOf[sNow] || 1;
    let frac = sNow === 0 ? live.frac : (liOf[sNow] + (tok[sNow] >= 0 ? 0.5 : 1)) / n;
    // finished a word: at its blank after the last letter for a moment, or already in a later word
    let doneUpTo = wNow - 1;
    if (sNow > 0 && tok[sNow] < 0 && liOf[sNow] === n - 1 && blanksAtEnd >= o.endBlanks) doneUpTo = wNow;
    if (sNow > 0 && wNow <= pos + 3) live = frac >= 1 && doneUpTo === wNow ? { word: wNow + 1, frac: 0 } : { word: wNow, frac: Math.min(1, frac) };
    if (live.word < pos) live = { word: pos, frac: 0 };

    // commit, never backwards. A word the path went through is read (or weak); a word it jumped over is skipped.
    if (doneUpTo >= pos) {
      // only trust a jump forward when the path really read the words it lands on
      const target = doneUpTo;
      let firstRead = -1; for (let w = pos; w <= target; w++) if (seen.get(w)?.n) { firstRead = w; break; }
      // the letters of two words were clearly heard (whatever their score), or it is a one-word step
      const heard = [...seen.entries()].filter(([w, r]) => w >= firstRead && w <= target && r.n >= 2 && r.letters.size / ids[w].length >= 0.5).length;
      const solid = firstRead === pos || (firstRead === pos + 1 && heard >= 1) || heard >= 2;
      if (solid) for (let w = pos; w <= target; w++) {
        const r = seen.get(w);
        // not on the path: a mistake only if the reader said something else there (filler frames); otherwise the
        // tracker simply ran over it (a quick or merged word): unclear, not a mistake
        if (!r || !r.n) { const nextSaid = [...fillerBefore.entries()].some(([k, n]) => k > w && k <= target + 1 && n >= 6); events.push({ index: w, kind: nextSaid ? 'missed' : 'unclear', score: -10 }); }
        else { const sc = r.score / r.n, cov = r.letters.size / ids[w].length; events.push({ index: w, kind: sc < o.weak || cov < 0.5 ? 'weak' : 'read', score: sc }); }
        pos = w + 1;
      }
      if (pos > target) {
        started = true;
        const r = seen.get(target);
        if (r) anchor = dropped + base + Math.max(0, r.lastT - 2);
      }
    }
    return { pos, word: live.word, frac: live.frac, events, inFiller: sNow === 0 };
  }

  // The page supplies the words from its own position on. extend(): same place, more words (or corrected ones)
  // from the committed position; advance(k): the page moved on k words by itself (the Sheikh said them, a hint).
  function extend(list) { words = words.slice(0, pos).concat(list); ids = words.map(toIds); }
  function advance(k) { pos = Math.min(words.length, pos + k); live = { word: pos, frac: 0 }; const a = dropped + frames.length - 2; if (a > anchor) anchor = a; }
  function reset(list) { words = list.slice(); ids = words.map(toIds); pos = 0; dropped += frames.length; frames.length = 0; anchor = dropped; started = false; live = { word: 0, frac: 0 }; }

  return { push, write, update, moveTo, extend, advance, reset, get pos() { return pos; }, get words() { return words; } };
}
