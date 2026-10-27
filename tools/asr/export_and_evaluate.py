"""
Export the open Arabic Conformer-CTC model (used by yayaiu6/Real-Time-Quran-recitation-tracker-System)
to ONNX so it can run on the phone or in the browser, and measure how well and how fast it hears
Quran recitation, before we switch the app over to it.

Runs in GitHub Actions (workflow "Speech model: export and test"). Outputs, in ./asr-out:
  qaaf-asr.onnx, qaaf-asr.int8.onnx   the model (full and 8-bit, smaller and faster)
  features.json                        mel filterbank and settings, so the app computes identical inputs
  vocab.json                           the model's word-pieces
  report.txt                           accuracy (word error rate) and speed on real recitations
"""
import json, os, re, sys, time, traceback, urllib.request, xml.etree.ElementTree as ET
import numpy as np

OUT = 'asr-out'
os.makedirs(OUT, exist_ok=True)
MODEL_URL = 'https://github.com/yayaiu6/Real-Time-Quran-recitation-tracker-System/raw/main/arabic-asr/conformer_ctc_small_60e_adamw_30wtr_32wv_40wte.nemo'
NEMO = 'model.nemo'
report = []
def log(*a):
    s = ' '.join(str(x) for x in a); print(s, flush=True); report.append(s)

if not os.path.exists(NEMO):
    urllib.request.urlretrieve(MODEL_URL, NEMO)
log('model file:', os.path.getsize(NEMO) // 1024, 'KB')

import torch
import nemo.collections.asr as nemo_asr
model = nemo_asr.models.EncDecCTCModelBPE.restore_from(NEMO, map_location='cpu')
model.eval()
pre = model.preprocessor
pre.featurizer.dither = 0.0
pre.featurizer.pad_to = 0
log('vocabulary size:', len(model.decoder.vocabulary))

# ── 1. export (never stops the run: accuracy is measured with NeMo itself either way) ──
import traceback
import onnx, onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType
ONNX_OK = False
class EncDec(torch.nn.Module):
    def __init__(self, m): super().__init__(); self.enc, self.dec = m.encoder, m.decoder
    def forward(self, audio_signal, length):
        e, el = self.enc(audio_signal=audio_signal, length=length)
        return self.dec(encoder_output=e)
try:
    try:
        model.export(os.path.join(OUT, 'qaaf-asr.onnx'))
        log('export: NeMo exporter')
    except Exception as e:
        log('NeMo exporter failed, trying torch.onnx.export:', repr(e)[:300])
        dummy = torch.randn(1, 80, 400); dl = torch.tensor([400])
        torch.onnx.export(EncDec(model).eval(), (dummy, dl), os.path.join(OUT, 'qaaf-asr.onnx'),
                          input_names=['audio_signal', 'length'], output_names=['logprobs'],
                          dynamic_axes={'audio_signal': {0: 'B', 2: 'T'}, 'length': {0: 'B'}, 'logprobs': {0: 'B', 1: 'T4'}},
                          opset_version=17, dynamo=False)
        log('export: torch.onnx.export')
    quantize_dynamic(os.path.join(OUT, 'qaaf-asr.onnx'), os.path.join(OUT, 'qaaf-asr.int8.onnx'), weight_type=QuantType.QInt8)
    for f in ['qaaf-asr.onnx', 'qaaf-asr.int8.onnx']:
        log(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')
    m = onnx.load(os.path.join(OUT, 'qaaf-asr.onnx'))
    log('onnx inputs:', [(i.name, [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim]) for i in m.graph.input])
    log('onnx outputs:', [o.name for o in m.graph.output])
    ONNX_OK = True
except Exception:
    log('EXPORT FAILED (accuracy is still measured below):'); log(traceback.format_exc()[-2500:])

# ── 2. the featurizer the app will use, written in plain numpy so it can be ported 1:1 to JavaScript
fz = pre.featurizer
fb = fz.fb.squeeze(0).numpy().astype(np.float32)            # (80, 257)
win = fz.window.numpy().astype(np.float32) if fz.window is not None else np.hanning(fz.win_length).astype(np.float32)
cfg = dict(sample_rate=int(getattr(fz, 'sample_rate', 16000) or 16000), n_fft=int(fz.n_fft), hop=int(fz.hop_length),
           win=int(fz.win_length), preemph=float(getattr(fz, 'preemph', 0.97) or 0.0), log_guard=float(2 ** -24),
           mag_power=float(getattr(fz, 'mag_power', 2.0)), normalize='per_feature', exact_pad=bool(getattr(fz, 'exact_pad', False)))
json.dump({**cfg, 'window': win.tolist(), 'fb': fb.tolist()}, open(os.path.join(OUT, 'features.json'), 'w'))
json.dump(list(model.decoder.vocabulary), open(os.path.join(OUT, 'vocab.json'), 'w'), ensure_ascii=False)
log('features:', {k: v for k, v in cfg.items()})

def features(x):
    x = x.astype(np.float32)
    if cfg['preemph']: x = np.concatenate([x[:1], x[1:] - cfg['preemph'] * x[:-1]])
    n_fft, hop, wl = cfg['n_fft'], cfg['hop'], cfg['win']
    pad = n_fft // 2
    xp = np.pad(x, (pad, pad), mode='constant')
    w = np.zeros(n_fft, np.float32); off = (n_fft - wl) // 2; w[off:off + wl] = win
    frames = 1 + (len(xp) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(xp[idx] * w, n=n_fft)) ** cfg['mag_power']     # (T, 257)
    mel = np.log(spec @ fb.T + cfg['log_guard']).T                           # (80, T)
    valid = len(x) // hop + 1
    mel = mel[:, :valid]
    mean = mel.mean(axis=1, keepdims=True)
    std = mel.std(axis=1, ddof=1, keepdims=True) + 1e-5
    return ((mel - mean) / std).astype(np.float32)

# ── 3. test material: real recitations from EveryAyah, compared with the Tanzil text
xml = ET.parse('sources/tanzil/quran-uthmani.xml').getroot()
text = {(int(s.get('index')), int(a.get('index'))): a.get('text') for s in xml for a in s}
def norm(t):
    t = re.sub('ىٰ', 'ى', t); t = t.replace('\u0670', 'ا')
    t = re.sub('[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED\u0640]', '', t)
    t = re.sub('[ٱأإآ]', 'ا', t).replace('ى', 'ي').replace('ة', 'ه').replace('ؤ', 'و').replace('ئ', 'ي')
    return re.sub(r'\s+', ' ', re.sub('[^\u0621-\u063A\u0641-\u064A ]', ' ', t)).strip()
def wer(ref, hyp):
    r, h = ref.split(), hyp.split()
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))

import librosa
tests = [(1, a) for a in range(1, 8)] + [(2, a) for a in (2, 3, 4, 5, 255)] + [(36, a) for a in (1, 2, 3, 4, 5)] + [(67, a) for a in (1, 2, 3)] + [(112, 1), (112, 2), (113, 1), (114, 1)]
reciters = ['Alafasy_128kbps', 'Husary_128kbps', 'Minshawy_Murattal_128kbps']
sess = {k: ort.InferenceSession(os.path.join(OUT, f), providers=['CPUExecutionProvider']) for k, f in [('fp32', 'qaaf-asr.onnx'), ('int8', 'qaaf-asr.int8.onnx')]} if ONNX_OK else {}
in_names = [i.name for i in sess['fp32'].get_inputs()] if ONNX_OK else []
vocab = list(model.decoder.vocabulary)
blank = len(vocab)
def decode(logp):
    ids = logp.argmax(-1)
    out, last = [], -1
    for i in ids:
        if i != last and i != blank: out.append(vocab[i])
        last = i
    return ''.join(out).replace('▁', ' ').strip()

totals = {k: [0.0, 0, 0.0, 0.0] for k in ['nemo', 'fp32', 'int8']}   # wer sum, n, audio seconds, compute seconds
maxdiff = 0.0
for rec in reciters:
    for (s, a) in tests:
        url = f'https://everyayah.com/data/{rec}/{s:03d}{a:03d}.mp3'
        path = f'/tmp/{rec}-{s}-{a}.mp3'
        try:
            if not os.path.exists(path): urllib.request.urlretrieve(url, path)
            audio, _ = librosa.load(path, sr=16000, mono=True)
        except Exception as e:
            log('skip', url, e); continue
        secs = len(audio) / 16000
        ref = norm(text[(s, a)])
        # NeMo itself (reference)
        t0 = time.time()
        with torch.no_grad():
            sig = torch.tensor(audio)[None]; ln = torch.tensor([len(audio)])
            feats, flen = pre(input_signal=sig, length=ln)
            lp, _, _ = model.forward(processed_signal=feats, processed_signal_length=flen)
        hyp = norm(decode(lp[0].numpy()))
        totals['nemo'][0] += wer(ref, hyp); totals['nemo'][1] += 1; totals['nemo'][2] += secs; totals['nemo'][3] += time.time() - t0
        mine = features(audio)
        maxdiff = max(maxdiff, float(np.abs(mine[:, :feats.shape[2]] - feats[0].numpy()[:, :mine.shape[1]]).max()))
        for k in (('fp32', 'int8') if ONNX_OK else ()):
            t0 = time.time()
            o = sess[k].run(None, {in_names[0]: mine[None], in_names[1]: np.array([mine.shape[1]], dtype=np.int64)})[0]
            h = norm(decode(o[0]))
            totals[k][0] += wer(ref, h); totals[k][1] += 1; totals[k][2] += secs; totals[k][3] += time.time() - t0
        if s in (1, 112): log(f'{rec} {s}:{a}\n  ref : {ref}\n  heard: {hyp}')

log('\nnumpy featurizer vs NeMo, largest difference:', round(maxdiff, 4), '(below ~0.05 means the app can compute the same inputs)')
for k, (w, n, au, comp) in totals.items():
    if n: log(f'{k:5s}  word error rate {100 * w / n:5.1f}%   speed {au / comp:5.1f}x faster than real time   ({n} ayahs, {au:.0f}s of audio)')
open(os.path.join(OUT, 'report.txt'), 'w').write('\n'.join(report))
