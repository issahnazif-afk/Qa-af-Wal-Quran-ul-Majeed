"""
Test the best model on reciters it never heard, measure speed, and export it for the app.
Outputs in ~/qaaf_asr/export: qaaf-asr.onnx, features.json, vocab.json, report.txt
"""
import json, os, sys, time
import numpy as np
import torch

CODE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, CODE)
from qaaf_model import QaafASR, FEAT
from qaaf_text import LETTERS, BLANK
from prepare import HOME, TEST_RECITERS
from train import Corpus, evaluate

out = os.path.join(HOME, 'export'); os.makedirs(out, exist_ok=True)
lines = []
def log(*a):
    s = ' '.join(str(x) for x in a); print(s, flush=True); lines.append(s)

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
ck = torch.load(os.path.join(HOME, 'ckpt', 'best.pt'), map_location='cpu')
model = QaafASR(len(LETTERS) + 1)
model.load_state_dict(ck['model']); model.eval()
log('best model from epoch', ck.get('epoch'), 'validation', ck.get('metrics'))

for r in TEST_RECITERS:
    c = Corpus([r])
    if not c.items:
        continue
    m = evaluate(model.to(device), c, c.items, device, 32000)
    log(f'{r}: WER {m["wer"]:.1f}%  tolerant WER {m["tolerant_wer"]:.1f}%  letter error {m["cer"]:.1f}%  ({len(c.items)} ayahs, never heard in training)')

# speed on one CPU thread, 6 seconds of audio (what a phone works on at a time)
model_cpu = model.cpu().eval(); torch.set_num_threads(1)   # eval: keep BatchNorm statistics fixed (evaluate() switches back to training mode)
x = torch.randn(1, 80, 600); l = torch.tensor([600])
with torch.no_grad():
    for _ in range(2): model_cpu(x, l)
    t = time.time(); [model_cpu(x, l) for _ in range(5)]; dt = (time.time() - t) / 5
log(f'speed: 6 s of audio in {dt * 1000:.0f} ms on one CPU core ({6 / dt:.0f}x real time)')

torch.onnx.export(model_cpu, (x, l), os.path.join(out, 'qaaf-asr.onnx'), input_names=['features', 'length'],
                  output_names=['logprobs', 'out_length'], opset_version=17,
                  dynamic_axes={'features': {0: 'batch', 2: 'frames'}, 'length': {0: 'batch'}, 'logprobs': {0: 'batch', 1: 'steps'}, 'out_length': {0: 'batch'}})
log('exported', os.path.getsize(os.path.join(out, 'qaaf-asr.onnx')) // 1024, 'KB')
sd = torch.load(os.path.join(HOME, 'model', 'model_weights.ckpt'), map_location='cpu'); sd = sd.get('state_dict', sd)
json.dump({**FEAT, 'window': sd['preprocessor.featurizer.window'].tolist(), 'fb': sd['preprocessor.featurizer.fb'].reshape(80, -1).tolist()},
          open(os.path.join(out, 'features.json'), 'w'))
json.dump({'letters': LETTERS, 'blank': BLANK}, open(os.path.join(out, 'vocab.json'), 'w'), ensure_ascii=False)
open(os.path.join(out, 'report.txt'), 'w').write('\n'.join(lines))
log('EXPORT FINISHED:', out)
