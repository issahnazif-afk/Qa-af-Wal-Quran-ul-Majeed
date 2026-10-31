// Levels, the session tally, grades and the Sheikh's short review.
//
// What the Sheikh can judge depends on the speech model. The Qāf model (and the browser's speech
// recognition) hear the letters of each word without its harakat, so the classroom checks memorisation
// and word errors: wrong words, forgotten words, hints, unclear words, going back, and looking away.
// Tajweed (harakat, madd, ghunnah, …) needs a model trained for it and is not checked yet.

export const LEVELS = {
  beginner: {
    name: 'Beginner', checking: 'lenient', silenceMs: 8000, hints: true, unclearIsMistake: false,
    text: 'Gentle checking. The Sheikh waits 8 seconds before helping, and hints are allowed.',
  },
  intermediate: {
    name: 'Intermediate', checking: 'normal', silenceMs: 6000, hints: true, unclearIsMistake: false,
    text: 'Normal checking. The Sheikh helps after 6 seconds of silence.',
  },
  advanced: {
    name: 'Advanced', checking: 'strict', silenceMs: 5000, hints: true, unclearIsMistake: false,
    text: 'Strict checking of every word. The Sheikh helps after 5 seconds.',
  },
  ijazah: {
    name: 'Ijazah', checking: 'strict', silenceMs: 4000, hints: false, unclearIsMistake: true,
    text: 'Strictest. No hints, unclear words count as mistakes, and the Sheikh helps after 4 seconds.',
  },
};

export const CATEGORIES = {
  wrong: 'Wrong word',
  prompt: 'Forgotten word (Sheikh prompted)',
  hint: 'Hint used',
  unclear: 'Unclear word',
  back: 'Went back over words',
};

export function newTally() {
  return { words: 0, first: 0, wrong: 0, prompt: 0, hint: 0, unclear: 0, back: 0, lookAways: 0, awayMs: 0 };
}

export function gradeOf(t) {
  if (!t.words) return 'No recitation';
  const known = t.first / t.words;
  if (known >= 0.95 && t.prompt === 0 && t.hint === 0) return 'Excellent';
  if (known >= 0.85) return 'Very good';
  if (known >= 0.70) return 'Good';
  return 'Needs revision';
}

export function mistakesTotal(t, level) {
  return t.wrong + t.prompt + (LEVELS[level]?.unclearIsMistake ? t.unclear : 0);
}

export function topMistakes(t) {
  return Object.keys(CATEGORIES)
    .map((k) => ({ k, label: CATEGORIES[k], n: t[k] }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
}

// One or two plain sentences, as the Sheikh would say them.
export function review(t, { mode, passage, weakAyahs = [] }) {
  if (!t.words) return 'No recitation was heard in this session.';
  const g = gradeOf(t);
  const parts = [];
  const what = mode === 'hifz' ? 'memorisation of ' + passage : 'reading of ' + passage;
  if (g === 'Excellent') parts.push(t.unclear || t.back ? `Excellent ${what}.` : `Excellent ${what}, with every word right first time.`);
  else if (g === 'Very good') parts.push(`Very good ${what}.`);
  else if (g === 'Good') parts.push(`Good ${what}, with some places to strengthen.`);
  else parts.push(`${what[0].toUpperCase() + what.slice(1)} needs more revision.`);
  const top = topMistakes(t)[0];
  if (top) {
    const where = weakAyahs.length ? ` (${weakAyahs.slice(0, 3).join(', ')})` : '';
    const tips = {
      wrong: `Most mistakes were wrong words${where}; read these ayahs from the mushaf several times before the next test.`,
      prompt: `The Sheikh had to prompt ${t.prompt} time${t.prompt === 1 ? '' : 's'}${where}; revise the links between these ayahs.`,
      hint: `${t.hint} hint${t.hint === 1 ? ' was' : 's were'} used${where}; try the passage again without hints.`,
      unclear: `Some words were not heard clearly${where}; recite a little slower and more clearly.`,
      back: 'You often went back over words; aim for one smooth pass.',
    };
    parts.push(tips[top.k]);
  }
  if (t.lookAways) parts.push(`Looked away from the screen ${t.lookAways} time${t.lookAways === 1 ? '' : 's'} during the test.`);
  return parts.join(' ');
}

export function newSessionId(classCode) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `QC-${String(classCode || 'X').replace(/[^A-Za-z0-9]/g, '').slice(0, 10)}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${rnd}`;
}
