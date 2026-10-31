// What the Sheikh says, in the student's own gender, and how it is voiced.
//
// Every phrase has a masculine (m) and feminine (f) form; phrases that are the same for both have one.
// Students choose their gender when they create their account. Without one, the neutral form is used.
//
// Voice: if a teacher has recorded a phrase, the recording plays (public/audio/sheikh/<file>.mp3;
// see the list in README). Otherwise the calmest Arabic voice the browser offers is used, slowed a
// little: Edge's natural voices (Hamed, Shakir) and Chrome's Google Arabic voice sound best.
import { u } from './url.mjs';

export const PHRASES = {
  // praise
  ahsant:       { m: ['أَحْسَنْتَ', 'ahsanta'], f: ['أَحْسَنْتِ', 'ahsanti'], n: ['مَا شَاءَ ٱللَّه', 'mashaallah'], en: 'Well done.' },
  mumtaz:       { m: ['مُمْتَاز', 'mumtaz'], f: ['مُمْتَازَة', 'mumtazah'], n: ['مُمْتَاز', 'mumtaz'], en: 'Excellent.' },
  jayyid:       { m: ['جَيِّدٌ جِدًّا', 'jayyid-jiddan'], f: ['جَيِّدٌ جِدًّا', 'jayyid-jiddan'], en: 'Very good.' },
  mashaallah:   { m: ['مَا شَاءَ ٱللَّه', 'mashaallah'], f: ['مَا شَاءَ ٱللَّه', 'mashaallah'], en: 'Masha’Allah.' },
  barakallah:   { m: ['بَارَكَ ٱللَّهُ فِيكَ', 'barakallahu-fik'], f: ['بَارَكَ ٱللَّهُ فِيكِ', 'barakallahu-fiki'], n: ['بَارَكَ ٱللَّهُ فِيك', 'barakallahu-fik'], en: 'May Allah bless you.' },
  // instructions
  recitefrom:   { m: ['ٱقْرَأْ مِنْ قَوْلِهِ تَعَالَى', 'iqra-min'], f: ['ٱقْرَئِي مِنْ قَوْلِهِ تَعَالَى', 'iqrai-min'], en: 'Recite from where Allah says:' },
  goahead:      { m: ['تَفَضَّلْ، ٱقْرَأْ', 'tafaddal-iqra'], f: ['تَفَضَّلِي، ٱقْرَئِي', 'tafaddali-iqrai'], en: 'Go ahead, recite.' },
  read:         { m: ['ٱقْرَأْ', 'iqra'], f: ['ٱقْرَئِي', 'iqrai'], en: 'Read.' },
  carryon:      { m: ['تَابِعْ', 'tabi'], f: ['تَابِعِي', 'tabii'], en: 'Carry on.' },
  takecare:     { m: ['ٱنْتَبِهْ', 'intabih'], f: ['ٱنْتَبِهِي', 'intabihi'], en: 'Take care, that is not right.' },
  again:        { m: ['أَعِدْ', 'aid'], f: ['أَعِيدِي', 'aidi'], en: 'Try that word again.' },
  listen:       { m: ['ٱسْتَمِعْ', 'istami'], f: ['ٱسْتَمِعِي', 'istamii'], en: 'Listen.' },
  lookatme:     { m: ['ٱنْظُرْ إِلَيَّ', 'unzur'], f: ['ٱنْظُرِي إِلَيَّ', 'unzuri'], en: 'Look at the screen.' },
  enough:       { m: ['حَسْبُكَ', 'hasbuka'], f: ['حَسْبُكِ', 'hasbuki'], en: 'That is enough.' },
  revise:       { m: ['رَاجِعْ هَذَا ٱلْمَوْضِعَ', 'raji'], f: ['رَاجِعِي هَذَا ٱلْمَوْضِعَ', 'rajii'], en: 'Revise this passage.' },
  testover:     { m: ['ٱنْتَهَى ٱلِٱخْتِبَارُ، جَزَاكَ ٱللَّهُ خَيْرًا', 'test-over-m'], f: ['ٱنْتَهَى ٱلِٱخْتِبَارُ، جَزَاكِ ٱللَّهُ خَيْرًا', 'test-over-f'], en: 'The test is over. May Allah reward you.' },
};

export function phrase(key, gender) {
  const p = PHRASES[key];
  if (!p) return { ar: '', file: '', en: '' };
  const [ar, file] = gender === 'f' ? p.f : gender === 'm' ? p.m : (p.n ?? p.m);
  return { ar, file, en: p.en };
}

// Praise for a finished passage, from how well it went.
export function praiseFor(ratio, prompts, hints) {
  if (ratio === 1 && !prompts && !hints) return 'mumtaz';
  if (ratio >= 0.85) return 'jayyid';
  return 'ahsant';
}

// ── the voice ─────────────────────────────────────────────────
let recordings = null;   // the list written at build time by scripts/copy-vendor.mjs
function hasRecording(file) {
  recordings ??= fetch(u('audio/sheikh/recordings.json')).then((r) => (r.ok ? r.json() : []), () => []).then((xs) => new Set(xs));
  return recordings.then((set) => set.has(file));
}

let voice = null;
function pickVoice() {
  const vs = (window.speechSynthesis?.getVoices() ?? []).filter((v) => /^ar([-_]|$)/i.test(v.lang));
  const score = (v) => (/natural|neural|online/i.test(v.name) ? 4 : 0) + (/hamed|shakir|taim|hamdan/i.test(v.name) ? 3 : 0) + (/google/i.test(v.name) ? 2 : 0) + (/^ar-(SA|EG)/i.test(v.lang) ? 1 : 0);
  voice = vs.sort((a, b) => score(b) - score(a))[0] ?? null;
}
if (typeof window !== 'undefined' && 'speechSynthesis' in window) { pickVoice(); speechSynthesis.addEventListener?.('voiceschanged', pickVoice); }

const clip = typeof Audio !== 'undefined' ? new Audio() : null;
export function stopVoice() { try { clip?.pause(); } catch {} try { speechSynthesis.cancel(); } catch {} }

// Say a phrase aloud. Resolves when it has finished (or after a safe timeout).
export async function speak(p, { enabled = true } = {}) {
  if (!enabled || !p?.ar) return false;
  if (p.file && clip && (await hasRecording(p.file))) {
    return new Promise((resolve) => {
      let done = false;
      const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
      clip.onended = () => fin(true); clip.onerror = () => fin(false);
      clip.src = u(`audio/sheikh/${p.file}.mp3`);
      clip.volume = 0.9;
      clip.play().catch(() => fin(false));
      setTimeout(() => fin(true), 6000);
    });
  }
  if (!voice) return false;
  return new Promise((resolve) => {
    const ut = new SpeechSynthesisUtterance(p.ar);
    ut.voice = voice; ut.lang = voice.lang;
    ut.rate = 0.8;      // unhurried
    ut.pitch = 0.92;    // a little deeper and softer
    ut.volume = 0.9;
    let done = false;
    const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
    ut.onend = () => fin(true); ut.onerror = () => fin(false);
    speechSynthesis.cancel();
    speechSynthesis.speak(ut);
    setTimeout(() => fin(true), 5000);
  });
}
