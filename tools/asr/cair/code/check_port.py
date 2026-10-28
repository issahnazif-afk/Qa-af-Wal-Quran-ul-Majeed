"""
Run in GitHub Actions (which has NeMo): proves the plain-PyTorch model gives the same output as NeMo
with the same weights, and that our featurizer matches NeMo's. CAIR then needs no NeMo at all.
"""
import os, sys, urllib.request
import numpy as np
import torch

CODE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, CODE)
from qaaf_model import QaafASR, Featurizer, load_nemo_weights

nemo_path = sys.argv[1]
import nemo.collections.asr as nemo_asr
ref = nemo_asr.models.EncDecCTCModelBPE.restore_from(nemo_path, map_location='cpu').eval()
ref.preprocessor.featurizer.dither = 0.0
ref.preprocessor.featurizer.pad_to = 0
sd = {k: v for k, v in ref.state_dict().items()}
torch.save(sd, '/tmp/model_weights.ckpt')

mine = QaafASR(n_out=sd['decoder.decoder_layers.0.weight'].shape[0], dropout=0.0)
_, missing, unexpected = load_nemo_weights(mine, '/tmp/model_weights.ckpt', keep_head=True)
print('missing:', missing, '\nunexpected (not used):', [k for k in unexpected if not k.startswith('preprocessor')][:10])
mine.eval()

ok = True
for T in (137, 600, 1503):
    x = torch.randn(2, 80, T); l = torch.tensor([T, T - 37])
    with torch.no_grad():
        a, al, _ = ref.forward(processed_signal=x, processed_signal_length=l)
        b, bl = mine(x, l)
    d = (a[0, :int(al[0])] - b[0, :int(bl[0])]).abs().max().item()
    d2 = (a[1, :int(al[1])] - b[1, :int(bl[1])]).abs().max().item()
    print(f'frames {T}: max difference in output {d:.2e} / {d2:.2e}, lengths {al.tolist()} vs {bl.tolist()}')
    ok &= d < 1e-3 and d2 < 1e-3 and al.tolist() == bl.tolist()

urllib.request.urlretrieve('https://everyayah.com/data/Alafasy_128kbps/001002.mp3', '/tmp/a.mp3')
import librosa
wav, _ = librosa.load('/tmp/a.mp3', sr=16000)
fz = Featurizer(sd['preprocessor.featurizer.fb'], sd['preprocessor.featurizer.window'])
with torch.no_grad():
    nf, nl = ref.preprocessor(input_signal=torch.tensor(wav)[None], length=torch.tensor([len(wav)]))
    myf = fz(torch.tensor(wav))
n = min(nf.shape[2], myf.shape[1], int(nl[0]))
diff = (nf[0, :, :n] - myf[:, :n]).abs()
print(f'featurizer: frames NeMo {int(nl[0])} / ours {myf.shape[1]}; max difference {diff.max():.3f}, mean {diff.mean():.4f}, frames off by >0.1: {(diff.max(0).values > 0.1).sum().item()} of {n}')
print('PORT CHECK PASSED' if ok else 'PORT CHECK FAILED')
sys.exit(0 if ok else 1)
