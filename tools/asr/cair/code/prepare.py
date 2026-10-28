"""
Build the training data on CAIR.

  python3 prepare.py download     # on the login node (needs internet): model + recitations from EveryAyah
  python3 prepare.py features     # in a job: decode audio, compute features, write one file per reciter

Layout under QAAF_HOME (default ~/qaaf_asr):
  model/model_weights.ckpt   the published Arabic Conformer-CTC weights (from the .nemo file)
  mp3/<reciter>/SSSAAA.mp3   recitations, one per ayah
  data/<reciter>.f16         features, float16, frames × 80, all ayahs back to back
  data/<reciter>.json        index: ayah, offset, frames, text
"""
import io, json, os, shutil, subprocess, sys, tarfile, threading, time, urllib.request, xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser(os.environ.get('QAAF_HOME', '~/qaaf_asr'))
CODE = os.path.dirname(os.path.abspath(__file__))
MODEL_URL = 'https://github.com/yayaiu6/Real-Time-Quran-recitation-tracker-System/raw/main/arabic-asr/conformer_ctc_small_60e_adamw_30wtr_32wv_40wte.nemo'
EVERYAYAH = 'https://everyayah.com/data/{r}/{s:03d}{a:03d}.mp3'

# Professional murattal recitations. The last two are kept out of training and used only for testing.
TRAIN_RECITERS = [
    'Alafasy_128kbps', 'Abdul_Basit_Murattal_192kbps', 'Abdurrahmaan_As-Sudais_192kbps', 'Saood_ash-Shuraym_128kbps',
    'Hudhaify_128kbps', 'Muhammad_Ayyoub_128kbps', 'Maher_AlMuaiqly_64kbps', 'Abu_Bakr_Ash-Shaatree_128kbps',
    'Yasser_Ad-Dussary_128kbps', 'Hani_Rifai_192kbps', 'Muhammad_Jibreel_128kbps', 'Nasser_Alqatami_128kbps',
    'Abdullah_Basfar_192kbps', 'Ghamadi_40kbps', 'Ali_Jaber_64kbps',
]
TEST_RECITERS = ['Husary_128kbps', 'Minshawy_Murattal_128kbps']
MAX_SECONDS = 25.0          # longer ayahs are left out of training (they do not fit a batch well)


def tanzil():
    root = ET.parse(os.path.join(CODE, 'quran-uthmani.xml')).getroot()
    return {(int(s.get('index')), int(a.get('index'))): a.get('text') for s in root for a in s}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def fetch(url, path, tries=4):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return True
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r, open(path + '.part', 'wb') as f:
                shutil.copyfileobj(r, f)
            os.replace(path + '.part', path)
            return True
        except Exception:
            time.sleep(2 * (k + 1))
    return False


def download(limit=None, reciters=None):
    os.makedirs(os.path.join(HOME, 'model'), exist_ok=True)
    ck = os.path.join(HOME, 'model', 'model_weights.ckpt')
    if not os.path.exists(ck):
        nemo = os.path.join(HOME, 'model', 'model.nemo')
        log('downloading the speech model')
        fetch(MODEL_URL, nemo)
        with tarfile.open(nemo) as t:
            for m in t.getmembers():
                if m.name.endswith('model_weights.ckpt') or m.name.endswith('model_config.yaml'):
                    m.name = os.path.basename(m.name)
                    t.extract(m, os.path.join(HOME, 'model'))
        log('model ready:', ck)
    text = tanzil()
    keys = sorted(text)
    if limit:
        keys = keys[:limit]
    names = reciters or TEST_RECITERS + TRAIN_RECITERS     # test reciters first, so the quick test can start early
    for r in names:
        d = os.path.join(HOME, 'mp3', r)
        os.makedirs(d, exist_ok=True)
        if not fetch(EVERYAYAH.format(r=r, s=1, a=1), os.path.join(d, '001001.mp3')):
            log('skipping', r, '(not available on EveryAyah)')
            continue
        done = [0]
        lock = threading.Lock()

        def one(k):
            ok = fetch(EVERYAYAH.format(r=r, s=k[0], a=k[1]), os.path.join(d, f'{k[0]:03d}{k[1]:03d}.mp3'))
            with lock:
                done[0] += 1
                if done[0] % 500 == 0:
                    log(r, done[0], '/', len(keys))
            return ok

        with ThreadPoolExecutor(8) as ex:
            got = sum(ex.map(one, keys))
        log(r, 'done:', got, 'of', len(keys))
    log('ALL DOWNLOADS FINISHED')


def ffmpeg_bin():
    for c in [os.environ.get('QAAF_FFMPEG'), os.path.expanduser('~/envs/ffmpeg/bin/ffmpeg'), shutil.which('ffmpeg')]:
        if c and os.path.exists(c):
            return c
    sys.exit('ffmpeg not found. Install it once on the login node: conda create -y -p ~/envs/ffmpeg -c conda-forge ffmpeg')


def features(limit=None, reciters=None):
    import numpy as np
    import torch
    sys.path.insert(0, CODE)
    from qaaf_model import Featurizer
    from qaaf_text import normalize
    sd = torch.load(os.path.join(HOME, 'model', 'model_weights.ckpt'), map_location='cpu')
    sd = sd.get('state_dict', sd)
    fz = Featurizer(sd['preprocessor.featurizer.fb'], sd['preprocessor.featurizer.window'])
    torch.set_num_threads(max(1, int(os.environ.get('LSB_DJOB_NUMPROC', '4'))))
    ff = ffmpeg_bin()
    text = tanzil()
    os.makedirs(os.path.join(HOME, 'data'), exist_ok=True)
    for r in reciters or TRAIN_RECITERS + TEST_RECITERS:
        src = os.path.join(HOME, 'mp3', r)
        out = os.path.join(HOME, 'data', r)
        if not os.path.isdir(src):
            continue
        if os.path.exists(out + '.json'):
            log(r, 'already done'); continue
        files = sorted(f for f in os.listdir(src) if f.endswith('.mp3'))
        if limit:
            files = files[:limit]
        index, offset, skipped = [], 0, 0
        with open(out + '.f16.part', 'wb') as fh:
            for i, f in enumerate(files):
                s, a = int(f[:3]), int(f[3:6])
                pcm = subprocess.run([ff, '-v', 'quiet', '-i', os.path.join(src, f), '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
                                     capture_output=True).stdout
                wav = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
                if wav.size < 1600:
                    skipped += 1; continue
                secs = wav.size / 16000
                feats = fz(torch.from_numpy(wav)).T.numpy().astype(np.float16)     # (T, 80)
                fh.write(feats.tobytes())
                index.append({'s': s, 'a': a, 'off': offset, 'n': int(feats.shape[0]), 'sec': round(secs, 2),
                              'text': normalize(text[(s, a)])})
                offset += feats.shape[0]
                if (i + 1) % 500 == 0:
                    log(r, i + 1, '/', len(files))
        os.replace(out + '.f16.part', out + '.f16')
        json.dump({'reciter': r, 'frames': offset, 'items': index}, open(out + '.json', 'w'), ensure_ascii=False)
        log(r, 'features:', len(index), 'ayahs,', round(offset / 100 / 3600, 1), 'hours', f'(skipped {skipped})')
    log('ALL FEATURES FINISHED')


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('step', choices=['download', 'features'])
    p.add_argument('--limit', type=int, default=None, help='only the first N ayahs (for a quick test)')
    p.add_argument('--reciters', default=None, help='comma-separated EveryAyah folder names')
    a = p.parse_args()
    rs = a.reciters.split(',') if a.reciters else None
    download(a.limit, rs) if a.step == 'download' else features(a.limit, rs)
