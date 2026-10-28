"""Text side: the same normalisation the app's tracker uses (src/lib/recite.mjs), letters, and scoring."""
import re

LETTERS = list('ءابتثجحخدذرزسشصضطظعغفقكلمنهوي') + [' ']
INDEX = {c: i for i, c in enumerate(LETTERS)}
BLANK = len(LETTERS)                          # CTC blank is the last class


def normalize(t: str) -> str:
    t = t.replace('ىٰ', 'ى').replace('\u0670', 'ا')
    t = re.sub('[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED\u0640]', '', t)
    t = re.sub('[ٱأإآ]', 'ا', t).replace('ى', 'ي').replace('ة', 'ه').replace('ؤ', 'و').replace('ئ', 'ي')
    t = re.sub('[^\u0621-\u063A\u0641-\u064A ]', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def encode(t: str):
    return [INDEX[c] for c in normalize(t) if c in INDEX]


def decode(ids):
    out, last = [], -1
    for i in ids:
        if i != last and i != BLANK:
            out.append(LETTERS[i])
        last = i
    return re.sub(r'\s+', ' ', ''.join(out)).strip()


def edit_distance(a, b):
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(b)]


def skeleton(w):
    return w[:1] + re.sub('[اويء]', '', w[1:])


def scores(ref: str, hyp: str):
    """(word errors, char errors, tolerant word errors, n words, n chars). Tolerant = what the tracker accepts."""
    r, h = ref.split(), hyp.split()
    we = edit_distance(r, h)
    ce = edit_distance(list(ref), list(hyp))
    tol_r = [skeleton(w) for w in r]
    tol_h = [skeleton(w) for w in h]
    te = edit_distance(tol_r, tol_h)
    return we, ce, te, len(r), len(ref)
