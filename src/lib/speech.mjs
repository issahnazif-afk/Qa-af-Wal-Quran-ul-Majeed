// Speech recognition for the classroom, tuned for speed.
//
// 1. On-device recognition (Chrome 139+): Chrome can download an Arabic speech pack once and then recognise
//    speech on the computer itself. No round trip to a server, so words appear sooner. prepareFastListening()
//    checks for it and installs it (a one-time download) when the student continues from the camera check.
// 2. Contextual biasing (Chrome 140+): the recogniser is told which words to expect next (the next words of the
//    passage), so it hears Quranic words more reliably and settles on them sooner.
// 3. The Qāf model from the main app (public/models/qaaf-asr.onnx), when published, runs on the computer too.
// Anything missing falls back quietly to the browser's normal (online) speech recognition.
import { LocalRecognition } from './asr-local.mjs';

const LANG = 'ar-SA';
const Native = () => (typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null);

export function getSpeechRecognition({ localAsr = false } = {}) {
  if (localAsr && navigator.mediaDevices?.getUserMedia) return { SR: LocalRecognition, engine: 'qaaf' };
  const SR = Native();
  return { SR, engine: SR ? (onDevice ? 'on-device' : 'browser') : null };
}

// ── on-device listening ───────────────────────────────────────
let onDevice = false;          // the Arabic pack is installed and will be used
let phrasesOk = true;          // contextual biasing accepted (switched off if the engine refuses it)
export const fastListening = () => onDevice;

// status: 'ready' | 'downloading' | 'unsupported' | 'unavailable'
export async function prepareFastListening({ install = false, onStatus = () => {} } = {}) {
  const S = Native();
  if (!S?.available) { onStatus('unsupported'); return false; }
  try {
    const st = await S.available({ langs: [LANG], processLocally: true });
    if (st === 'available') { onDevice = true; onStatus('ready'); return true; }
    if (st === 'unavailable') { onStatus('unavailable'); return false; }
    if (!install) { onStatus(st === 'downloading' ? 'downloading' : 'downloadable'); return false; }
    onStatus('downloading');
    const ok = await S.install({ langs: [LANG], processLocally: true });
    onDevice = !!ok;
    onStatus(ok ? 'ready' : 'unavailable');
    return onDevice;
  } catch { onStatus('unsupported'); return false; }
}
prepareFastListening().catch(() => {});

// Arabic as a speech engine writes it: no harakat or Quranic marks, plain alif for alif wasla.
export function plainArabic(s) {
  return String(s)
    .replace(/ٰ/g, 'ا')
    .replace(/[ؐ-ًؚ-ٟۖ-ۭـ]/g, '')
    .replace(/ٱ/g, 'ا')
    .replace(/\s+/g, ' ')
    .trim();
}

// Set up a recogniser: on-device when available, and biased towards the words expected next.
export function tuneRecognition(rec, { expect = [] } = {}) {
  try { if (onDevice && 'processLocally' in rec) rec.processLocally = true; } catch {}
  setExpected(rec, expect);
  return rec;
}

// Tell the recogniser which words come next. Safe to call while it is listening.
export function setExpected(rec, words) {
  if (!phrasesOk || !rec || !('phrases' in rec) || typeof window.SpeechRecognitionPhrase !== 'function') return;
  try {
    const seen = new Set();
    const list = [];
    for (const w of words) {
      const p = plainArabic(w);
      if (p.length < 2 || seen.has(p)) continue;
      seen.add(p);
      list.push(new window.SpeechRecognitionPhrase(p, list.length < 8 ? 6 : 3));   // the very next words count most
      if (list.length >= 40) break;
    }
    rec.phrases = list;
  } catch { phrasesOk = false; }
}

// Engines without biasing report 'phrases-not-supported': stop using it and carry on.
export function phrasesRefused(e) {
  if (e?.error === 'phrases-not-supported') { phrasesOk = false; return true; }
  return false;
}
