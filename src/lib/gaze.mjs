// Is the student looking at the screen? Runs MediaPipe Face Landmarker on the camera, in the browser.
// No video leaves the computer.
//
// The head's turn (left/right) and tilt (up/down) are measured from face landmarks and compared with
// the student's own neutral pose, recorded on the camera check screen. Eyes looking down or to the side
// are read from the model's blendshapes. A look-away is reported only after it lasts AWAY_MS, so a
// blink or a quick glance does not count.
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { u } from './url.mjs';

const AWAY_MS = 1500;      // how long a look-away must last before it counts
const NOFACE_MS = 2500;    // how long the face may be missing before it counts
const FRAME_W = 640;     // width of the frame copy that is analysed
const LIMITS = { yaw: 0.28, pitch: 0.09, eyesDown: 0.6, eyesSide: 0.75 };

let landmarkerP = null;
export function loadGaze() {
  landmarkerP ??= (async () => {
    const files = await FilesetResolver.forVisionTasks(u('mediapipe'));
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: u('models/face_landmarker.task'), delegate },
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
    });
    const want = /[?&]gaze=cpu/.test(location.search) ? 'CPU' : 'GPU';
    try { return await FaceLandmarker.createFromOptions(files, opts(want)); }
    catch { return await FaceLandmarker.createFromOptions(files, opts('CPU')); }
  })();
  landmarkerP.catch(() => { landmarkerP = null; });
  return landmarkerP;
}

// Pose numbers from one result: yaw and pitch ratios (≈0 when facing the camera) and eye blendshapes.
function measure(res) {
  const lm = res.faceLandmarks?.[0];
  if (!lm) return null;
  const nose = lm[1], rEye = lm[33], lEye = lm[263], chin = lm[152], top = lm[10];
  const eyeDist = Math.hypot(lEye.x - rEye.x, lEye.y - rEye.y) || 1e-6;
  const midX = (lEye.x + rEye.x) / 2;
  const yaw = (nose.x - midX) / eyeDist;
  const pitch = (nose.y - top.y) / ((chin.y - top.y) || 1e-6);
  const bs = Object.fromEntries((res.faceBlendshapes?.[0]?.categories ?? []).map((c) => [c.categoryName, c.score]));
  const eyesDown = Math.min(bs.eyeLookDownLeft ?? 0, bs.eyeLookDownRight ?? 0);
  const eyesSide = Math.max(Math.min(bs.eyeLookOutLeft ?? 0, bs.eyeLookInRight ?? 0), Math.min(bs.eyeLookInLeft ?? 0, bs.eyeLookOutRight ?? 0));
  return { yaw, pitch, eyesDown, eyesSide };
}

const DEBUG = typeof location !== 'undefined' && /[?&]debug=1/.test(location.search);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

// watcher.onChange(state, why): state 'ok' | 'away' | 'noface'
export function createGazeWatcher(video, { onChange = () => {}, onFrame = () => {} } = {}) {
  let lm = null, running = false, raf = 0, lastT = -1;
  let baseline = null;
  let calib = null;           // samples while calibrating
  let state = 'ok', badSince = 0, why = '';
  let frames = 0, faces = 0;
  const frame = document.createElement('canvas');
  const fctx = frame.getContext('2d', { willReadFrequently: false });

  function verdict(m) {
    if (!m) return { bad: true, kind: 'noface', why: 'face not visible' };
    const b = baseline ?? { yaw: 0, pitch: m.pitch };
    if (Math.abs(m.yaw - b.yaw) > LIMITS.yaw) return { bad: true, kind: 'away', why: 'head turned away' };
    if (Math.abs(m.pitch - b.pitch) > LIMITS.pitch) return { bad: true, kind: 'away', why: m.pitch > b.pitch ? 'looking down' : 'looking up' };
    if (m.eyesDown > LIMITS.eyesDown) return { bad: true, kind: 'away', why: 'eyes looking down' };
    if (m.eyesSide > LIMITS.eyesSide) return { bad: true, kind: 'away', why: 'eyes looking to the side' };
    return { bad: false };
  }

  function tick() {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    if (!lm || video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    // a small copy of the frame: cheaper to analyse, and works with every camera driver
    const w = FRAME_W, h = Math.round((video.videoHeight / video.videoWidth) * w) || Math.round(w * 0.5625);
    if (frame.width !== w || frame.height !== h) { frame.width = w; frame.height = h; }
    fctx.drawImage(video, 0, 0, w, h);
    let res;
    try { res = lm.detectForVideo(frame, performance.now()); } catch { return; }
    const m = measure(res);
    frames++; if (m) faces++;
    if (DEBUG) window.__qcGaze = { frames, faces, m, baseline, state };
    onFrame(m);
    if (calib) { if (m) calib.push(m); return; }
    const v = verdict(m);
    const now = performance.now();
    if (!v.bad) {
      badSince = 0;
      if (state !== 'ok') { state = 'ok'; why = ''; onChange('ok', ''); }
      return;
    }
    badSince ||= now;
    const limit = v.kind === 'noface' ? NOFACE_MS : AWAY_MS;
    if (now - badSince >= limit && state !== v.kind) { state = v.kind; why = v.why; onChange(state, why); }
  }

  return {
    async start() {
      lm = await loadGaze();
      running = true; state = 'ok'; badSince = 0;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
    },
    stop() { running = false; cancelAnimationFrame(raf); },
    // Record the neutral pose while the student looks at the screen: wait (up to `maxMs`) until
    // `need` frames with a face have been seen. The first frames can be slow while the model warms up.
    async calibrate({ need = 10, maxMs = 8000 } = {}) {
      calib = [];
      const t0 = performance.now();
      while (calib.length < need && performance.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 100));
      const xs = calib; calib = null;
      if (xs.length >= 5) baseline = { yaw: median(xs.map((x) => x.yaw)), pitch: median(xs.map((x) => x.pitch)) };
      return { ok: xs.length >= 5, samples: xs.length };
    },
    get baseline() { return baseline; },
    set baseline(b) { baseline = b; },
    get state() { return state; },
    get why() { return why; },
  };
}
