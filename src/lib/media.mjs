// Camera, microphone level and the login snapshot.

export async function openCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
}

// Calls onLevel(0…1) about 20 times a second until stop() is called.
export function micMeter(stream, onLevel) {
  const track = stream.getAudioTracks()[0];
  if (!track) return { stop() {} };
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(new MediaStream([track]));
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const t = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 6));
  }, 50);
  return { stop() { clearInterval(t); try { ctx.close(); } catch {} } };
}

// A small JPEG of the current camera frame (about 15–30 KB).
export function snapshot(video, width = 360) {
  const w = width, h = Math.round((video.videoHeight / video.videoWidth) * w) || Math.round(w * 0.75);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.translate(w, 0); g.scale(-1, 1);   // as the student sees themselves
  g.drawImage(video, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.72);
}

export function testTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 523;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.95);
  } catch {}
}
