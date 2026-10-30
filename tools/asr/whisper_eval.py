"""
While CAIR is offline: measure Tarteel's open Quran Whisper models on real recitations, to decide
whether one can serve as the on-device engine now (and to compare with our CAIR model later).

Reports, per model: word error rate (strict and tolerant, as our tracker scores), and how long a
6-second chunk takes on one CPU core. Note: Tarteel trained on EveryAyah recitations, so these
scores are optimistic; everyday readers will score worse.
"""
import os, re, sys, time, urllib.request, xml.etree.ElementTree as ET
import numpy as np, torch, librosa
from transformers import WhisperForConditionalGeneration, WhisperProcessor

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'cair', 'code'))
from qaaf_text import normalize, scores

MODELS = ['tarteel-ai/whisper-tiny-ar-quran', 'tarteel-ai/whisper-base-ar-quran']
root = ET.parse('sources/tanzil/quran-uthmani.xml').getroot()
text = {(int(s.get('index')), int(a.get('index'))): a.get('text') for s in root for a in s}
tests = [(1, a) for a in range(1, 8)] + [(2, a) for a in (2, 3, 4, 5, 255)] + [(36, a) for a in (1, 2, 3, 4, 5)] + [(67, a) for a in (1, 2, 3)] + [(112, 1), (112, 2), (113, 1), (114, 1)]
reciters = ['Husary_128kbps', 'Minshawy_Murattal_128kbps', 'Alafasy_128kbps']
audio = {}
for r in reciters:
    for k in tests:
        path = f'/tmp/{r}-{k[0]}-{k[1]}.mp3'
        try:
            if not os.path.exists(path): urllib.request.urlretrieve(f'https://everyayah.com/data/{r}/{k[0]:03d}{k[1]:03d}.mp3', path)
            audio[(r, k)] = librosa.load(path, sr=16000)[0]
        except Exception as e:
            print('skip', r, k, e)
torch.set_num_threads(1)
lines = []
for name in MODELS:
    try:
        proc = WhisperProcessor.from_pretrained(name)
        model = WhisperForConditionalGeneration.from_pretrained(name).eval()
    except Exception as e:
        lines.append(f'{name}: could not load ({e})'); continue
    tot = np.zeros(5); n = 0
    for (r, k), wav in audio.items():
        feats = proc(wav, sampling_rate=16000, return_tensors='pt').input_features
        with torch.no_grad():
            ids = model.generate(feats, max_new_tokens=200)
        hyp = normalize(proc.batch_decode(ids, skip_special_tokens=True)[0])
        tot += np.array(scores(normalize(text[k]), hyp)); n += 1
        if r == 'Husary_128kbps' and k[0] in (1, 112) and k[1] <= 2:
            print(name, k, '\n  ref  :', normalize(text[k]), '\n  heard:', hyp, flush=True)
    six = np.zeros(16000 * 6, dtype=np.float32) + 0.001 * np.random.randn(16000 * 6).astype(np.float32)
    feats = proc(six, sampling_rate=16000, return_tensors='pt').input_features
    with torch.no_grad():
        model.generate(feats, max_new_tokens=40)
        t = time.time(); model.generate(feats, max_new_tokens=40); dt = time.time() - t
    we, ce, te, nw, nc = tot
    params = sum(p.numel() for p in model.parameters()) / 1e6
    lines.append(f'{name}: {params:.0f}M params | WER {100*we/nw:.1f}% | tolerant WER {100*te/nw:.1f}% | letter error {100*ce/nc:.1f}% | one 6 s chunk on 1 CPU core: {dt*1000:.0f} ms | {n} ayahs')
print('\n=== RESULTS ===\n' + '\n'.join(lines))
open('whisper-report.txt', 'w').write('\n'.join(lines))
