// Voice-synced tracing. The speech service confirms words about a second after they are said, so on
// its own the tracker always trails the reader. The live cursor listens to the loudness of the voice
// itself (instant), learns the reader's pace from the words already confirmed, and moves a progress
// bar across the hidden word slots in time with the voice. It never reveals text; confirmed words
// still come only from the recogniser, and the cursor snaps back to them whenever they arrive.
const LAG = 0.75;                 // typical delay of the speech service, in seconds

export function createLiveCursor({ getFlat, getPos, onPage }) {
  let ctx = null, stream = null, analyser = null, buf = null, raf = 0, on = false;
  let voiced = 0, lastT = 0, lastLoud = 0, floor = 0.006;
  let spl = 0.11;                 // seconds of voice per letter (learnt)
  const hist = [];                // [t, voiced] samples, for looking back LAG seconds
  let lastPos = -1, lastConfirmT = 0, shown = null;
  const confirms = [];            // [t, letters]

  const voicedAt = (t) => {
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i][0] <= t) return hist[i][1];
    return hist.length ? hist[0][1] : 0;
  };
  const clear = () => { if (shown) { shown.classList.remove('live'); shown.style.removeProperty('--p'); shown = null; } };

  function frame(ts) {
    if (!on) return;
    const t = ts / 1000;
    const dt = lastT ? Math.min(0.1, t - lastT) : 0;
    lastT = t;
    analyser.getFloatTimeDomainData(buf);
    let e = 0; for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
    const rms = Math.sqrt(e / buf.length);
    const loud = rms > Math.max(0.012, floor * 2.8);
    if (!loud) floor = 0.97 * floor + 0.03 * rms;
    if (loud) { voiced += dt; lastLoud = t; }
    hist.push([t, voiced]); while (hist.length && hist[0][0] < t - 20) hist.shift();

    const flat = getFlat(), pos = getPos();
    if (pos !== lastPos) {
      if (pos > lastPos && lastPos >= 0) {
        let letters = 0;
        for (let i = lastPos; i < pos && i < flat.length; i++) letters += flat[i].plain.length;
        confirms.push([t, letters]);
        while (confirms.length && confirms[0][0] < t - 15) confirms.shift();
        const L = confirms.reduce((s, c) => s + c[1], 0);
        const V = voicedAt(t - LAG) - voicedAt(t - LAG - 15);
        if (L > 12 && V > 1) spl = Math.min(0.3, Math.max(0.04, 0.7 * spl + 0.3 * (V / L)));
      }
      lastPos = pos; lastConfirmT = t;
    }
    // letters said since what the recogniser has confirmed so far
    let ahead = (voiced - voicedAt(lastConfirmT - LAG)) / spl;
    let i = pos, p = 0;
    if (t - lastLoud > 0.6) ahead = 0;                     // a pause (end of an ayah): stop at the confirmed word
    while (i < flat.length && i < pos + 3) {
      const n = Math.max(1, flat[i].plain.length);
      if (ahead < n) { p = ahead / n; break; }
      ahead -= n; i++;
    }
    const w = flat[i];
    const el = w && w.state !== 'shown' && onPage(w) ? w.el : null;
    if (el !== shown) { clear(); if (el) { el.classList.add('live'); shown = el; } }
    if (shown) shown.style.setProperty('--p', Math.min(1, Math.max(0.08, p)).toFixed(3));
    raf = requestAnimationFrame(frame);
  }

  return {
    async start() {
      if (on) return;
      // inside the Android/iOS app the phone's recogniser owns the microphone: no live cursor there
      if (window.Capacitor?.isNativePlatform?.() || !navigator.mediaDevices?.getUserMedia) return;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
        buf = new Float32Array(analyser.fftSize);
        ctx.createMediaStreamSource(stream).connect(analyser);
        on = true; lastT = 0; lastPos = getPos(); lastConfirmT = performance.now() / 1000;
        raf = requestAnimationFrame(frame);
      } catch { /* no microphone access for the meter: tracking still works without the live cursor */ }
    },
    stop() {
      on = false; cancelAnimationFrame(raf); clear();
      stream?.getTracks().forEach((x) => x.stop()); stream = null;
      ctx?.close().catch(() => {}); ctx = null;
    },
  };
}
