// Gentle sound for the Alif Ba games, following the school's guidance: environmental ambience (a soft night
// breeze and a fountain in a masjid courtyard, made in the browser, no music), a warm chime when a lantern
// lights, and anasheed only at milestones (if the school adds one: public/audio/nasheed/<name>.mp3).
import { u } from './url.mjs';

let ctx = null, master = null, bed = null, muted = false;
const audio = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

function noise(c, seconds = 4) {
  const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < d.length; i++) {           // pink-ish noise: softer than white
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
  }
  const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
  return src;
}

export function startAmbience() {
  if (bed || muted) return;
  const c = audio();
  c.resume?.();
  master = c.createGain(); master.gain.value = 0; master.connect(c.destination);
  // breeze: low, slowly swelling
  const wind = noise(c, 6), wf = c.createBiquadFilter(), wg = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
  wf.type = 'lowpass'; wf.frequency.value = 380; wg.gain.value = 0.35;
  lfo.frequency.value = 0.07; lg.gain.value = 0.18; lfo.connect(lg).connect(wg.gain);
  wind.connect(wf).connect(wg).connect(master);
  // fountain: a quiet, higher trickle
  const water = noise(c, 3), ff = c.createBiquadFilter(), fg = c.createGain();
  ff.type = 'bandpass'; ff.frequency.value = 2400; ff.Q.value = 0.7; fg.gain.value = 0.06;
  water.connect(ff).connect(fg).connect(master);
  wind.start(); water.start(); lfo.start();
  master.gain.linearRampToValueAtTime(0.5, c.currentTime + 2.5);
  bed = { stop: () => { try { master.gain.linearRampToValueAtTime(0, c.currentTime + 0.8); setTimeout(() => { wind.stop(); water.stop(); lfo.stop(); }, 900); } catch {} } };
}
export function stopAmbience() { bed?.stop(); bed = null; }
export function setMuted(m) { muted = m; if (m) stopAmbience(); }
export const isMuted = () => muted;

// A soft bell when a lantern lights (two gentle partials, slow decay).
export function glow() {
  if (muted) return;
  const c = audio();
  [[660, 0.12], [990, 0.06], [1320, 0.03]].forEach(([f, v]) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(v, c.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 1.6);
    o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 1.7);
  });
}
// A quiet, low tone for a wrong choice: no buzzer.
export function soft() {
  if (muted) return;
  const c = audio(), o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = 220;
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.06, c.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.35);
  o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.4);
}

// Anasheed at milestones, only if the school has added one (listed at build time).
let nasheeds = null;
export async function nasheed(name = 'milestone') {
  if (muted) return;
  nasheeds ??= fetch(u('audio/nasheed/recordings.json')).then((r) => (r.ok ? r.json() : []), () => []);
  if (!(await nasheeds).includes(name)) return;
  const a = new Audio(u(`audio/nasheed/${name}.mp3`));
  a.volume = 0.7;
  a.play().catch(() => {});
}
