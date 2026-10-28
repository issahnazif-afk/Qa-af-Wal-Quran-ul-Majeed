"""
Fine-tune the Arabic Conformer-CTC on Quran recitation (letters as outputs).
Resumable: each job trains until its time budget, saves ckpt/last.pt, and the next job continues.
Submit the same job again until the log says TRAINING COMPLETE.
"""
import json, math, os, random, sys, time
import numpy as np
import torch

CODE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, CODE)
from qaaf_model import QaafASR, load_nemo_weights
from qaaf_text import BLANK, LETTERS, encode, decode, scores
from prepare import HOME, TEST_RECITERS, MAX_SECONDS

T0 = time.time()

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

class Corpus:
    """All reciters' features, memory-mapped, plus the ayah index."""
    def __init__(self, names):
        self.mm, self.items = {}, []
        for r in names:
            p = os.path.join(HOME, 'data', r)
            if not os.path.exists(p + '.json'):
                continue
            meta = json.load(open(p + '.json'))
            self.mm[r] = np.memmap(p + '.f16', dtype=np.float16, mode='r', shape=(meta['frames'], 80))
            for it in meta['items']:
                if it['text'] and it['sec'] <= MAX_SECONDS:
                    self.items.append((r, it['s'], it['a'], it['off'], it['n'], it['text']))

    def feats(self, it):
        r, _, _, off, n, _ = it
        return torch.from_numpy(np.asarray(self.mm[r][off:off + n], dtype=np.float32).T.copy())   # (80, T)

def batches(items, max_frames, shuffle=True):
    order = sorted(range(len(items)), key=lambda i: items[i][4])
    out, cur, longest = [], [], 0
    for i in order:
        n = items[i][4]
        if cur and max(longest, n) * (len(cur) + 1) > max_frames:
            out.append(cur); cur, longest = [], 0
        cur.append(i); longest = max(longest, n)
    if cur:
        out.append(cur)
    if shuffle:
        random.shuffle(out)
    return out

def spec_augment(x, lengths):
    """x (B, 80, T): 2 frequency masks (≤27 bins) and 5 time masks (≤5% of each utterance)."""
    b, f, t = x.shape
    for i in range(b):
        for _ in range(2):
            w = random.randint(0, 27); s = random.randint(0, f - w); x[i, s:s + w, :] = 0
        L = int(lengths[i])
        for _ in range(5):
            w = random.randint(0, max(1, int(0.05 * L))); s = random.randint(0, max(0, L - w)); x[i, :, s:s + w] = 0
    return x

def collate(corpus, idx, items, device, augment):
    fs = [corpus.feats(items[i]) for i in idx]
    lens = torch.tensor([f.shape[1] for f in fs])
    x = torch.zeros(len(fs), 80, int(lens.max()))
    for k, f in enumerate(fs):
        x[k, :, :f.shape[1]] = f
    ys = [torch.tensor(encode(items[i][5])) for i in idx]
    ylen = torch.tensor([len(y) for y in ys])
    y = torch.cat(ys)
    x, lens = x.to(device, non_blocking=True), lens.to(device)
    if augment:
        x = spec_augment(x, lens)
    return x, lens, y.to(device), ylen.to(device)

@torch.no_grad()
def evaluate(model, corpus, items, device, max_frames, limit=None):
    model.eval()
    tot = np.zeros(5)
    items = items[:limit] if limit else items
    for idx in batches(items, max_frames, shuffle=False):
        x, lens, _, _ = collate(corpus, idx, items, device, False)
        with torch.autocast('cuda', dtype=torch.float16, enabled=device.type == 'cuda'):
            lp, ol = model(x, lens)
        ids = lp.argmax(-1).cpu().numpy()
        for k, i in enumerate(idx):
            hyp = decode(ids[k, :int(ol[k])])
            tot += np.array(scores(items[i][5], hyp))
    model.train()
    we, ce, te, nw, nc = tot
    return {'wer': 100 * we / max(1, nw), 'cer': 100 * ce / max(1, nc), 'tolerant_wer': 100 * te / max(1, nw)}

def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--hours', type=float, default=7.4, help='stop and save before the job’s wall time')
    p.add_argument('--epochs', type=int, default=15)
    p.add_argument('--max-frames', type=int, default=32000, help='padded frames per batch (100 frames = 1 s)')
    p.add_argument('--lr', type=float, default=5e-4)
    p.add_argument('--max-steps', type=int, default=0, help='stop after this many steps (quick test)')
    p.add_argument('--limit', type=int, default=0, help='use only this many training ayahs (quick test)')
    a = p.parse_args()
    
    random.seed(0); torch.manual_seed(0)
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    ck_dir = os.path.join(HOME, 'ckpt'); os.makedirs(ck_dir, exist_ok=True)
    
    all_names = [f[:-5] for f in os.listdir(os.path.join(HOME, 'data')) if f.endswith('.json')]
    train = Corpus([n for n in all_names if n not in TEST_RECITERS])
    test = Corpus([n for n in all_names if n in TEST_RECITERS])
    
    items = train.items[:a.limit] if a.limit else train.items
    val_items = random.Random(1).sample(test.items, min(300, len(test.items))) if test.items else items[:100]
    val_corpus = test if test.items else train
    
    log(f'training ayahs: {len(items)} ({sum(i[4] for i in items) / 360000:.1f} h), validation ayahs: {len(val_items)}, device: {device}')
    
    model = QaafASR(len(LETTERS) + 1).to(device)
    head = [p_ for n, p_ in model.named_parameters() if n.startswith('decoder.')]
    body = [p_ for n, p_ in model.named_parameters() if not n.startswith('decoder.')]
    
    opt = torch.optim.AdamW([{'params': body, 'lr': a.lr}, {'params': head, 'lr': a.lr * 5}], weight_decay=1e-3)
    scaler = torch.cuda.amp.GradScaler(enabled=device.type == 'cuda')
    ctc = torch.nn.CTCLoss(blank=BLANK, zero_infinity=True)
    
    steps_per_epoch = len(batches(items, a.max_frames, shuffle=False))
    total = max(1, steps_per_epoch * a.epochs)
    warm = min(1500, total // 10 + 1)
    
    state = {'epoch': 0, 'step': 0, 'best': 1e9}
    last = os.path.join(ck_dir, 'last.pt')
    
    if os.path.exists(last):
        ck = torch.load(last, map_location='cpu')
        model.load_state_dict(ck['model']); opt.load_state_dict(ck['opt']); scaler.load_state_dict(ck['scaler']); state = ck['state']
        log('resumed from epoch', state['epoch'], 'step', state['step'])
    else:
        _, missing, _ = load_nemo_weights(model, os.path.join(HOME, 'model', 'model_weights.ckpt'), keep_head=False)
        log('loaded the published Arabic weights; new output layer for', len(LETTERS), 'letters', '(missing:', missing, ')')
        log('before fine-tuning (letters head is untrained):', evaluate(model, val_corpus, val_items, device, a.max_frames, 50))

    def lr_at(step):
        if step < warm:
            return step / warm
        return 0.02 + 0.98 * 0.5 * (1 + math.cos(math.pi * min(1.0, (step - warm) / max(1, total - warm))))

    budget = a.hours * 3600
    model.train()
    
    while state['epoch'] < a.epochs:
        ep = state['epoch']
        bl = batches(items, a.max_frames)
        start = state.get('batch_in_epoch', 0)
        t_ep, loss_sum, n_sum = time.time(), 0.0, 0
        
        for bi in range(start, len(bl)):
            for g, base in zip(opt.param_groups, (a.lr, a.lr * 5)):
                g['lr'] = base * lr_at(state['step'])
            
            x, lens, y, ylen = collate(train, bl[bi], items, device, True)
            with torch.autocast('cuda', dtype=torch.float16, enabled=device.type == 'cuda'):
                lp, ol = model(x, lens)
            
            loss = ctc(lp.transpose(0, 1), y, ol, ylen)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt); scaler.update()
            
            state['step'] += 1; state['batch_in_epoch'] = bi + 1
            loss_sum += float(loss); n_sum += 1
            
            if state['step'] % 100 == 0:
                log(f'epoch {ep + 1} batch {bi + 1}/{len(bl)} step {state["step"]} loss {loss_sum / n_sum:.3f} lr {opt.param_groups[0]["lr"]:.2e}')
                loss_sum, n_sum = 0.0, 0
            
            stop = (a.max_steps and state['step'] >= a.max_steps) or (time.time() - T0 > budget)
            if stop:
                torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'scaler': scaler.state_dict(), 'state': state}, last)
                log('TIME BUDGET REACHED, saved; submit the training job again to continue' if not a.max_steps else 'QUICK TEST STEPS DONE')
                if a.max_steps:
                    torch.save({'model': model.state_dict(), 'letters': LETTERS, 'epoch': state['epoch']}, os.path.join(ck_dir, 'best.pt'))
                    log('quick-test model saved:', os.path.join(ck_dir, 'best.pt'))
                return
        
        state['epoch'] += 1; state['batch_in_epoch'] = 0
        m = evaluate(model, val_corpus, val_items, device, a.max_frames)
        log(f'EPOCH {state["epoch"]} done in {(time.time() - t_ep) / 60:.0f} min — validation (unseen reciter): '
            f'WER {m["wer"]:.1f}%  tolerant WER {m["tolerant_wer"]:.1f}%  letter error {m["cer"]:.1f}%')
        
        if m['tolerant_wer'] < state['best']:
            state['best'] = m['tolerant_wer']
            torch.save({'model': model.state_dict(), 'letters': LETTERS, 'metrics': m, 'epoch': state['epoch']}, os.path.join(ck_dir, 'best.pt'))
            log('new best model saved')
        
        torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'scaler': scaler.state_dict(), 'state': state}, last)
    
    log('TRAINING COMPLETE. Best tolerant WER:', round(state['best'], 1), '%')

if __name__ == '__main__':
    main()
