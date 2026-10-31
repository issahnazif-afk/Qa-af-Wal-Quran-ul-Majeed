// Browser-side helpers: local settings, data loading, audio addresses.
import { u } from './url.mjs';

export const pad = (n) => String(n).padStart(3, '0');
export const dataUrl = (p) => u('data/' + p);

export const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem('qc-' + k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('qc-' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('qc-' + k); } catch {} },
};

const jsonCache = new Map();
export function getJson(p) {
  if (!jsonCache.has(p)) {
    const pr = fetch(dataUrl(p)).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${p} (HTTP ${r.status})`);
      return r.json();
    });
    pr.catch(() => jsonCache.delete(p));
    jsonCache.set(p, pr);
  }
  return jsonCache.get(p);
}

export const audioUrl = (reciter, s, a) => `https://everyayah.com/data/${reciter}/${pad(s)}${pad(a)}.mp3`;
export const wordAudioUrl = (s, a, wi) => `https://audio.qurancdn.com/wbw/${pad(s)}_${pad(a)}_${pad(wi + 1)}.mp3`;
