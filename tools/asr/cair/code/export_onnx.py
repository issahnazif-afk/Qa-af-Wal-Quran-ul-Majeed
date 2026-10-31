"""
Turn the trained model (qaaf-asr.pt, from CAIR) into the files the app uses, and prove the ONNX
file gives the same answers as PyTorch at several lengths. Runs on GitHub (CAIR has no onnx package).

  python export_onnx.py qaaf-asr.pt model_weights.ckpt out/
"""
import json, os, sys
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qaaf_model import QaafASR, FEAT
from qaaf_text import LETTERS, BLANK

pt, nemo_ckpt, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
ck = torch.load(pt, map_location='cpu')
model = QaafASR(len(LETTERS) + 1)
model.load_state_dict(ck['model'] if 'model' in ck else ck)
model.eval()
print('model from epoch', ck.get('epoch'), 'validation', ck.get('metrics'))

x = torch.randn(1, 80, 600); l = torch.tensor([600])
path = os.path.join(out, 'qaaf-asr.onnx')
torch.onnx.export(model, (x, l), path, input_names=['features', 'length'], output_names=['logprobs', 'out_length'],
                  opset_version=17, dynamic_axes={'features': {0: 'batch', 2: 'frames'}, 'length': {0: 'batch'},
                                                  'logprobs': {0: 'batch', 1: 'steps'}, 'out_length': {0: 'batch'}})
print('exported', os.path.getsize(path) // 1024, 'KB')

import onnxruntime as ort
s = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
worst = 0.0
for T in (150, 313, 777, 1500):
    f = np.random.randn(1, 80, T).astype('float32')
    a = s.run(None, {'features': f, 'length': np.array([T], dtype=np.int64)})[0]
    with torch.no_grad():
        b = model(torch.tensor(f), torch.tensor([T]))[0].numpy()
    d = float(np.abs(a - b).max()) if a.shape == b.shape else float('inf')
    worst = max(worst, d)
    print(f'frames {T}: onnx {a.shape}, difference from PyTorch {d:.2e}')
assert worst < 1e-3, 'ONNX differs from PyTorch'

sd = torch.load(nemo_ckpt, map_location='cpu'); sd = sd.get('state_dict', sd)
json.dump({**FEAT, 'window': sd['preprocessor.featurizer.window'].tolist(), 'fb': sd['preprocessor.featurizer.fb'].reshape(80, -1).tolist()},
          open(os.path.join(out, 'features.json'), 'w'))
json.dump({'letters': LETTERS, 'blank': BLANK}, open(os.path.join(out, 'vocab.json'), 'w'), ensure_ascii=False)
print('ONNX EXPORT VERIFIED')
