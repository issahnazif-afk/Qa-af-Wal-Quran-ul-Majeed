// Turns the speech engine's running guesses into steps through the expected words.
// Shared by the Recite page and the Hifz test.
//
// Speech engines revise their guesses, mishear words recited with tajweed, and add stray words.
// This follower is built to keep moving with the reader despite that:
//  • it re-finds its place when a guess is revised,
//  • it keeps going when one or two words were garbled but the reader clearly carried on,
//  • it ignores a stray word that is followed by the right one,
//  • it recognises the reader stepping back over words already written,
//  • and it only calls a word wrong when the engine is sure of it and it really is not the next word.
import { normalize, matchAt, similarity } from './recite.mjs';

const words = (alt) => normalize(alt.transcript).split(' ').filter(Boolean);

export function createFollower(o) {
  // o: { getFlat(), getPos(), threshold(), accept(count, kind), wrong(heard), replay(idx), endReplay(), skipOptional?(spoken, i, th) }
  let used = {}, last = {}, back = null, misses = 0;

  function reset() { used = {}; last = {}; back = null; misses = 0; }
  function clearBack() { if (back !== null) { back = null; o.endReplay(); } }
  function offset(r) { return used[r] ?? 0; }
  function consumeAll(results) {
    if (!results) return;
    for (let r = 0; r < results.length; r++) {
      const sp = words(results[r][0]);
      used[r] = sp.length; last[r] = sp[sp.length - 1];
    }
  }
  function commit(r, i, spoken) { used[r] = i; last[r] = spoken[i - 1]; }

  // If the engine rewrote the start of its guess, find where we had got to.
  function realign(r, spoken) {
    let i = used[r] ?? 0;
    if (i === 0 || spoken[i - 1] === last[r]) return Math.min(i, spoken.length);
    for (const d of [0, -1, 1, -2, 2, -3]) {
      const j = i + d;
      if (j >= 1 && j <= spoken.length && spoken[j - 1] && similarity(spoken[j - 1], last[r]) >= 0.8) return j;
    }
    return Math.min(i, spoken.length);
  }

  // `count` spoken words from i match the expected words from p, in order
  function runMatches(spoken, i, flat, p, count, th) {
    for (let k = 0; k < count; k++) {
      if (!spoken[i] || p >= flat.length) return false;
      const m = matchAt(spoken, i, flat, p, th);
      if (!m.n) return false;
      i += m.n; p += m.e;
    }
    return true;
  }

  function altHeard(res, i, flat, pos, th) {
    for (let k = 1; k < res.length; k++) {
      const alt = words(res[k]);
      for (const j of [i, i - 1, i + 1]) if (alt[j] && matchAt(alt, j, flat, pos, th).n) return true;
    }
    return false;
  }

  function findBacktrack(spoken, i, flat, pos, th, isFinal) {
    let near = null;
    for (let k = 1; k <= 12 && pos - k >= 0; k++) {
      const idx = pos - k;
      if (flat[idx].state === 'skipped') break;
      if (!matchAt(spoken, i, flat, idx, th).n) continue;
      if (runMatches(spoken, i, flat, idx, 2, th) && idx + 1 < pos) return idx;
      if (k <= 3 && isFinal) near ??= idx;   // one word is only trusted for a short step back, once final
    }
    return near;
  }

  function handle(results, from) {
    const th = o.threshold();
    for (let r = from; r < results.length; r++) {
      const res = results[r];
      const spoken = words(res[0]);
      let i = realign(r, spoken);
      while (i < spoken.length) {
        const flat = o.getFlat();
        let pos = o.getPos();
        if (pos >= flat.length) break;

        // 1. stepping back over words already written
        if (back !== null) {
          const mb = matchAt(spoken, i, flat, back, th);
          if (mb.n) {
            for (let k = 0; k < mb.e; k++) o.replay(back + k);
            back += mb.e; i += mb.n; commit(r, i, spoken);
            if (back >= pos) clearBack();
            continue;
          }
        }

        // 2. the next word (or an optional Bismillah the reader went past)
        let m = matchAt(spoken, i, flat, pos, th);
        if (!m.n && o.skipOptional) {
          const np = o.skipOptional(spoken, i, th);
          if (np != null) { pos = np; m = matchAt(spoken, i, flat, pos, th); }
        }
        if (m.n) { clearBack(); misses = 0; i += m.n; commit(r, i, spoken); o.accept(m.e); continue; }

        // 3. another of the engine's guesses heard the right word
        if (altHeard(res, i, flat, pos, th)) { clearBack(); misses = 0; i++; commit(r, i, spoken); o.accept(1); continue; }

        // 4. a stray word, followed by the right one
        if (spoken[i + 1] && matchAt(spoken, i + 1, flat, pos, th).n) { i++; commit(r, i, spoken); continue; }

        // 5. stepping back a few words
        const bt = findBacktrack(spoken, i, flat, pos, th, res.isFinal);
        if (bt !== null) {
          back = bt;
          const mb = matchAt(spoken, i, flat, back, th);
          for (let k = 0; k < mb.e; k++) o.replay(back + k);
          back += mb.e; i += mb.n; commit(r, i, spoken);
          if (back >= pos) clearBack();
          continue;
        }

        // 6. the engine garbled or dropped 1–2 words, but the reader clearly carried on
        const need = res.isFinal ? 1 : 2;
        if (runMatches(spoken, i + 1, flat, pos + 1, need, th)) {          // garbled: this word stands for the expected one
          misses = 0; i++; commit(r, i, spoken); o.accept(1, 'unclear'); continue;
        }
        let dropped = 0;
        for (let s = 1; s <= 2 && !dropped; s++) if (runMatches(spoken, i, flat, pos + s, need, th)) dropped = s;
        if (dropped) { misses = 0; o.accept(dropped, 'unclear'); continue; }

        // 7. interim guesses can still change: wait
        if (!res.isFinal) break;

        // 8. a wrong word: close to the expected word but not it, or a second miss in a row
        misses++;
        const close = similarity(spoken[i], flat[pos].plain) >= 0.4;
        i++; commit(r, i, spoken);
        if (close || misses >= 2) { misses = 0; o.wrong(spoken[i - 1]); }
      }
    }
  }

  return { handle, reset, consumeAll, clearBack, offset, get back() { return back; } };
}
