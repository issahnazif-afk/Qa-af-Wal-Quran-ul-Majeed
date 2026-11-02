// One speech-recognition interface for the browser and for the Android / iOS app.
// In a browser this is the built-in Web Speech API. Inside the mobile app (Capacitor) the
// web view has no Web Speech API, so the phone's own recogniser is used through the
// @capacitor-community/speech-recognition plugin, wrapped to behave the same way.

import { LocalRecognition } from './asr-local.mjs';

// The reader can choose the on-device Qāf model (menu → Listening engine) once it is published.
export function getSpeechRecognition() {
  let engine = 'speech';
  try { engine = JSON.parse(localStorage.getItem('ql-engine') || '"speech"'); } catch {}
  if (engine === 'local' && navigator.mediaDevices?.getUserMedia) return LocalRecognition;
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.()) return NativeRecognition;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

let pluginPromise = null;
const plugin = () => (pluginPromise ??= import('@capacitor-community/speech-recognition').then((m) => m.SpeechRecognition));

class NativeRecognition {
  constructor() {
    this.lang = 'ar-SA';
    this.continuous = true;
    this.interimResults = true;
    this.maxAlternatives = 3;
    this.onresult = null; this.onend = null; this.onerror = null;
    this.results = [];
    this.handles = [];
    this.running = false;
  }
  async start() {
    const P = await plugin();
    try {
      const perm = await P.requestPermissions();
      if (perm?.speechRecognition && perm.speechRecognition !== 'granted') {
        this.onerror?.({ error: 'not-allowed' });
        return;
      }
      const ok = await P.available();
      if (ok && ok.available === false) { this.onerror?.({ error: 'service-not-allowed' }); return; }
      this.results = [];
      let current = -1;
      const emit = (texts, isFinal) => {
        if (current < 0) current = this.results.length;
        const res = texts.map((t) => ({ transcript: t }));
        res.isFinal = isFinal;
        this.results[current] = res;
        this.onresult?.({ resultIndex: current, results: this.results });
        if (isFinal) current = -1;
      };
      this.handles.push(await P.addListener('partialResults', (d) => { if (d?.matches?.length) { this.last = d.matches; emit(d.matches, false); } }));
      this.handles.push(await P.addListener('listeningState', (d) => {
        if (d?.status === 'stopped') {
          if (this.last && current >= 0) emit(this.last, true);
          this.last = null;
          this.finish();
        }
      }));
      this.running = true;
      await P.start({ language: this.lang, maxResults: this.maxAlternatives, partialResults: true, popup: false });
    } catch (e) {
      this.onerror?.({ error: 'network', message: String(e?.message ?? e) });
      this.finish();
    }
  }
  async finish() {
    if (!this.running) return;
    this.running = false;
    for (const h of this.handles) { try { await h.remove(); } catch {} }
    this.handles = [];
    this.onend?.();
  }
  stop() {
    plugin().then((P) => P.stop()).catch(() => {});
    this.finish();
  }
}

// Chrome can recognise speech on the device itself (no network round trip, lower delay) where a
// language pack is installed. Use it when the browser says Arabic is available locally.
let localSpeech = false, localState = 'unavailable';
const SRclass = () => window.SpeechRecognition || window.webkitSpeechRecognition;
(async () => {
  try {
    const S = SRclass();
    if (S?.available) { localState = await S.available({ langs: ['ar-SA'], processLocally: true }); localSpeech = localState === 'available'; }
  } catch {}
})();

// Chrome can download its Arabic speech pack once, after which recognition runs on the device:
// no network round trip, so words arrive noticeably sooner. Must be called from a tap.
export async function installLocalSpeech(onState = () => {}) {
  const S = SRclass();
  if (!S?.install || localSpeech) return localSpeech;
  if (localState !== 'downloadable' && localState !== 'downloading') return false;
  try {
    onState('downloading');
    const ok = await S.install({ langs: ['ar-SA'], processLocally: true });
    localSpeech = !!ok; localState = ok ? 'available' : localState;
    onState(ok ? 'ready' : 'failed');
  } catch { onState('failed'); }
  return localSpeech;
}
export const localSpeechState = () => localState;
export function tuneRecognition(rec) {
  try { if (localSpeech && 'processLocally' in rec) rec.processLocally = true; } catch {}
  return rec;
}

// Start loading the on-device model as soon as the page opens, so it is ready before the reader starts.
export function preloadEngine() {
  let engine = 'speech';
  try { engine = JSON.parse(localStorage.getItem('ql-engine') || '"speech"'); } catch {}
  if (engine !== 'local') return null;
  return import('./asr-local.mjs').then((m) => m.loadModel());
}

// Contextual biasing: newer Chrome versions let a page boost expected phrases. We pass the next
// words of the Quran text, so the recogniser favours them over everyday Arabic look-alikes.
const DIAC = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
export function biasTowards(rec, words) {
  try {
    const P = window.SpeechRecognitionPhrase;
    if (!P || !('phrases' in rec)) return;
    const seen = new Set(), list = [];
    for (const w of words) {
      const t = String(w).replace(DIAC, '').replace(/ٱ/g, 'ا').trim();
      if (t && !seen.has(t)) { seen.add(t); list.push(new P(t, 6.0)); }
      if (list.length >= 40) break;
    }
    rec.phrases = list;
  } catch {}
}
