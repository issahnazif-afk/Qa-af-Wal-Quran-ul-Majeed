// Streaming text-constrained aligner.
//
// We already know what the reader should say. Instead of transcribing speech freely, the aligner
// follows the reader through the expected letters, frame by frame (25 frames a second), using the
// Qāf model's letter probabilities. Real reading habits are allowed for: pauses and held vowels
// (CTC blanks), skipping a word, and stepping back to repeat a word, each with a small cost.
//
// Pure JavaScript, no imports: used by the app and by the Node test harness.
//
// push(frames) takes log-probabilities [n × C] (C = letters + space + blank). It reports:
//   onProgress({ word, frac })              word index (in the current list) and how far into it
//   onWords([{ index, plain, score, heard }]) words just completed, with a pronunciation score
//                                             (average log-probability margin; 0 = perfect)

export function createAligner({ letters, blank, onProgress = () => {}, onWords = () => {}, opts = {} }) {
  const o = {
    skipWord: -9,      // cost of skipping a word
    backWord: -12,     // cost of stepping back to repeat a word
    stableFrames: 2,   // frames past a word's last letter before it counts as said
    ...opts,
  };
  const C = letters.length + 1;
  const space = letters.indexOf(' ');
  const index = new Map(letters.map((c, i) => [c, i]));

  let words = [];          // plain strings
  let st = [];             // states: { tok, w, li } (tok -1 = blank)
  let lastLetter = [];     // state index of each word's last letter
  let firstLetter = [];
  let delta = new Float64Array(0), next = new Float64Array(0);
  let done = 0;            // words completed so far (in this list)
  let pastCount = 0;
  let gop = [], gopN = [], seen = [], greedyText = [];
  let lastTok = -1;

  function build(list) {
    words = list.slice();
    st = [{ tok: -1, w: 0, li: -1 }];
    lastLetter = []; firstLetter = [];
    words.forEach((word, w) => {
      const ids = [...word].map((c) => index.get(c)).filter((x) => x !== undefined && x !== space);
      if (!ids.length) ids.push(index.get('ا'));
      ids.forEach((id, li) => {
        if (li === 0) firstLetter[w] = st.length;
        st.push({ tok: id, w, li, n: ids.length });
        st.push({ tok: -1, w, li });             // blank after each letter
      });
      lastLetter[w] = st.length - 2;
    });
    delta = new Float64Array(st.length).fill(-Infinity);
    next = new Float64Array(st.length);
    delta[0] = 0;
    done = 0; pastCount = 0;
    gop = words.map(() => 0); gopN = words.map(() => 0); seen = words.map(() => new Set()); greedyText = words.map(() => '');
  }

  function step(lp, off) {
    const S = st.length;
    // emissions: space is treated as a pause (blank)
    const eBlank = Math.max(lp[off + blank], space >= 0 ? lp[off + space] : -Infinity)
      + Math.log1p(Math.exp(-Math.abs(lp[off + blank] - (space >= 0 ? lp[off + space] : -Infinity))));
    let free = eBlank, freeTok = -1;
    for (let c = 0; c < C - 1; c++) if (c !== space && lp[off + c] > free) { free = lp[off + c]; freeTok = c; }

    for (let s = 0; s < S; s++) {
      const cur = st[s];
      let best = delta[s];                                         // stay
      if (s >= 1 && delta[s - 1] > best) best = delta[s - 1];      // advance
      if (s >= 2 && cur.tok >= 0 && st[s - 2].tok !== cur.tok && delta[s - 2] > best) best = delta[s - 2];   // skip a blank
      if (cur.tok >= 0 && cur.li === 0) {
        const w = cur.w;
        if (w >= 2) {                                              // skip word w-1
          const from = lastLetter[w - 2];
          const v = Math.max(delta[from], delta[from + 1]) + o.skipWord;
          if (v > best) best = v;
        } else if (w === 1) {
          const v = delta[0] + o.skipWord;
          if (v > best) best = v;
        }
        for (const back of [1, 2]) {                               // step back: from the end of word w+back to word w
          const fw = w + back;
          if (fw < words.length) {
            const from = lastLetter[fw];
            const v = Math.max(delta[from], delta[from + 1]) + o.backWord;
            if (v > best) best = v;
          }
        }
      }
      next[s] = best + (cur.tok >= 0 ? lp[off + cur.tok] : eBlank);
    }
    // normalise
    let m = -Infinity, arg = 0;
    for (let s = 0; s < S; s++) if (next[s] > m) { m = next[s]; arg = s; }
    for (let s = 0; s < S; s++) delta[s] = next[s] - m;

    const b = st[arg];
    // pronunciation score: how much the expected letter's probability trails the best free choice
    if (b.li >= 0) {                     // every frame spent inside a word counts (letters and the pauses between them)
      const e = b.tok >= 0 ? lp[off + b.tok] : eBlank;
      gop[b.w] += e - free; gopN[b.w]++;
      if (b.tok >= 0) seen[b.w].add(b.li);
    }
    if (freeTok >= 0 && freeTok !== lastTok && b.w >= done) greedyText[Math.min(b.w, words.length - 1)] += letters[freeTok];
    lastTok = freeTok;

    // progress within the current word
    {
      let w = b.w, frac;
      const n = st[firstLetter[Math.min(w, words.length - 1)]]?.n ?? 1;
      if (b.tok >= 0) frac = (b.li + 0.5) / n;
      else if (b.li < 0) frac = 0;
      else if (b.li === n - 1) { w = b.w + 1; frac = 0; }
      else frac = (b.li + 1) / n;
      if (w < words.length) onProgress({ word: w, frac });
    }

    // completed words: the best path has moved past their last letter for a few frames
    let through = -1;
    for (let k = done; k < words.length; k++) if (arg > lastLetter[k]) through = k; else break;
    if (through >= done) {
      pastCount++;
      if (pastCount >= o.stableFrames) {
        const out = [];
        for (let k = done; k <= through; k++) {
          const nl = st[firstLetter[k]]?.n ?? 1;
          out.push({ index: k, plain: words[k], score: gopN[k] ? gop[k] / gopN[k] : -10, covered: seen[k].size / nl, heard: greedyText[k] });
        }
        done = through + 1; pastCount = 0;
        onWords(out);
      }
    } else pastCount = 0;
  }

  return {
    reset(list) { build(list); },
    push(lp, n) { for (let t = 0; t < n; t++) step(lp, t * C); },
    get done() { return done; },
    get size() { return words.length; },
    // The page has moved past the completed words: continue with its new list, keeping the progress
    // already made into the next word (so a fast reader loses nothing). Falls back to a fresh start.
    rebase(list) {
      const rest = words.slice(done);
      const n = Math.min(rest.length, list.length);
      let same = n > 0;
      for (let i = 0; i < n && same; i++) same = rest[i] === list[i];
      if (!same || done === 0 || done >= words.length) { build(list); return; }
      const offset = firstLetter[done] - 1;                   // the pause just before the next word
      const keep = delta.slice(offset);
      build(list);
      const m = Math.min(keep.length, delta.length);
      for (let s = 0; s < m; s++) delta[s] = keep[s];
    },
  };
}
