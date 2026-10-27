// One speech-recognition interface for the browser and for the Android / iOS app.
// In a browser this is the built-in Web Speech API. Inside the mobile app (Capacitor) the
// web view has no Web Speech API, so the phone's own recogniser is used through the
// @capacitor-community/speech-recognition plugin, wrapped to behave the same way.

export function getSpeechRecognition() {
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
