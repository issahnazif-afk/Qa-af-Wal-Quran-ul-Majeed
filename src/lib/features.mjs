// Log-mel features for the Qāf model, exactly as in tools/asr/cair/code/qaaf_model.py (Featurizer).
// No imports: shared by the app, the aligner test harness (Node) and the on-device recogniser.
export function makeFeaturizer(f) {
  const n = f.n_fft, hop = f.hop, nb = n / 2 + 1, nm = f.fb.length;
  const win = new Float32Array(n);
  const off = (n - f.win) >> 1;
  f.window.forEach((v, i) => { win[off + i] = v; });
  const fb = f.fb.map((r) => Float32Array.from(r));
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cosT = new Float32Array(n / 2), sinT = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cosT[k] = Math.cos((2 * Math.PI * k) / n); sinT[k] = -Math.sin((2 * Math.PI * k) / n); }
  const re = new Float64Array(n), im = new Float64Array(n), pw = new Float64Array(nb);

  return (x) => {
    const len = x.length, pad = n >> 1;
    const y = new Float32Array(len + 2 * pad);
    y[pad] = x[0];
    for (let i = 1; i < len; i++) y[pad + i] = x[i] - f.preemph * x[i - 1];
    const T = Math.max(1, Math.floor(len / hop));             // NeMo keeps len // hop frames
    const out = new Float32Array(nm * T);
    for (let t = 0; t < T; t++) {
      for (let i = 0; i < n; i++) { const j = rev[i]; re[j] = (y[t * hop + i] ?? 0) * win[i]; im[j] = 0; }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
          const c = cosT[k * step], sn = sinT[k * step];
          const a = s + k, b = a + half;
          const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
      for (let k = 0; k < nb; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
      for (let m = 0; m < nm; m++) {
        let acc = 0; const row = fb[m];
        for (let k = 0; k < nb; k++) acc += row[k] * pw[k];
        out[m * T + t] = Math.log(acc + f.log_guard);
      }
    }
    for (let m = 0; m < nm; m++) {
      let mean = 0; for (let t = 0; t < T; t++) mean += out[m * T + t]; mean /= T;
      let v = 0; for (let t = 0; t < T; t++) { const d = out[m * T + t] - mean; v += d * d; }
      const sd = Math.sqrt(v / Math.max(1, T - 1)) + 1e-5;
      for (let t = 0; t < T; t++) out[m * T + t] = (out[m * T + t] - mean) / sd;
    }
    return { data: out, frames: T };
  };
}

