// Browser-side helpers shared by every page: settings, bookmarks, audio.
import cfg from '../../site.config.mjs';
import { u } from './url.mjs';

export const pad = (n) => String(n).padStart(3, '0');
export const dataUrl = (p) => u('data/' + p);

const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem('ql-' + k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('ql-' + k, JSON.stringify(v)); } catch {} },
};
export { store };

export const settings = {
  get translation() { return store.get('translation', cfg.defaultTranslation); },
  set translation(v) { store.set('translation', v); },
  get reciter() { return store.get('reciter', cfg.defaultReciter); },
  set reciter(v) { store.set('reciter', v); },
  get wbw() { return store.get('wbw', false); },
  set wbw(v) { store.set('wbw', v); },
};

export const bookmarks = {
  all() { return store.get('bookmarks', []); },
  has(k) { return this.all().includes(k); },
  toggle(k) {
    const list = this.all();
    const i = list.indexOf(k);
    if (i >= 0) list.splice(i, 1); else list.unshift(k);
    store.set('bookmarks', list);
    return i < 0;
  },
};

export const lastRead = {
  get() { return store.get('last-read', null); },
  set(v) { store.set('last-read', v); },
};

const jsonCache = new Map();
export function getJson(p) {
  if (!jsonCache.has(p)) {
    jsonCache.set(p, fetch(dataUrl(p)).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${p} (HTTP ${r.status})`);
      return r.json();
    }));
  }
  return jsonCache.get(p);
}

export const audioUrl = (reciter, s, a) => `https://everyayah.com/data/${reciter}/${pad(s)}${pad(a)}.mp3`;

// ── Audio player (one per page) ───────────────────────────────
// Markup comes from src/components/Player.astro.
export function initPlayer({ lazy = false } = {}) {
  const bar = document.getElementById('player');
  if (!bar) return null;
  const audio = new Audio();
  audio.preload = 'auto';
  const playBtn = bar.querySelector('[data-p="play"]');
  const title = bar.querySelector('[data-p="title"]');
  const sub = bar.querySelector('[data-p="sub"]');
  const fill = bar.querySelector('[data-p="fill"]');
  const repeatBtn = bar.querySelector('[data-p="repeat"]');
  const speedBtn = bar.querySelector('[data-p="speed"]');
  const reciterSel = bar.querySelector('[data-p="reciter"]');
  const err = bar.querySelector('[data-p="error"]');
  let queue = [], idx = -1, repeat = false;
  const speeds = [1, 1.25, 1.5, 0.75];

  reciterSel.value = settings.reciter;
  const reciterName = () => cfg.reciters.find((r) => r.id === settings.reciter)?.name ?? settings.reciter;

  function setPlaying(on) {
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    playBtn.querySelector('[data-i="play"]').hidden = on;
    playBtn.querySelector('[data-i="pause"]').hidden = !on;
  }
  function load(i) {
    show();
    idx = i;
    const item = queue[idx];
    if (!item) { stop(); return; }
    err.hidden = true;
    audio.src = audioUrl(settings.reciter, item.s, item.a);
    audio.play().catch(() => {});
    title.textContent = item.label ?? `${item.s}:${item.a}`;
    sub.textContent = reciterName();
    document.dispatchEvent(new CustomEvent('ql:ayah', { detail: { key: `${item.s}:${item.a}` } }));
  }
  function stop() {
    audio.pause();
    setPlaying(false);
    document.dispatchEvent(new CustomEvent('ql:ayah', { detail: { key: null } }));
  }

  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('timeupdate', () => {
    fill.style.width = audio.duration ? `${(audio.currentTime / audio.duration) * 100}%` : '0';
  });
  audio.addEventListener('ended', () => (repeat ? load(idx) : load(idx + 1)));
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    err.hidden = false;
    setPlaying(false);
  });

  playBtn.addEventListener('click', () => {
    if (idx < 0) return load(0);
    audio.paused ? audio.play() : audio.pause();
  });
  bar.querySelector('[data-p="next"]').addEventListener('click', () => load(Math.min(idx + 1, queue.length - 1)));
  bar.querySelector('[data-p="prev"]').addEventListener('click', () => load(Math.max(idx - 1, 0)));
  repeatBtn.addEventListener('click', () => {
    repeat = !repeat;
    repeatBtn.setAttribute('aria-pressed', String(repeat));
  });
  speedBtn.addEventListener('click', () => {
    const next = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length];
    audio.playbackRate = next;
    speedBtn.textContent = `${next}×`;
  });
  reciterSel.addEventListener('change', () => {
    settings.reciter = reciterSel.value;
    if (idx >= 0) load(idx);
  });

  const show = () => { bar.hidden = false; document.body.classList.add('has-player'); };
  if (!lazy) show();

  return {
    setQueue(list) { queue = list; },
    playAt(key) {
      const i = queue.findIndex((q) => `${q.s}:${q.a}` === key);
      if (i >= 0) load(i);
    },
    playAll() { load(0); },
  };
}
