"""
Qaf speech model: the NeMo Conformer-CTC (small) re-written in plain PyTorch, so it trains on CAIR
(IBM Power / ppc64le, PyTorch 2.1) without installing NeMo, and exports cleanly to ONNX for the app.

Parameter names match NeMo exactly, so the published Arabic weights load directly.
The output layer is replaced by one letter per class (Arabic letters + space), which is what the
app's tracker compares against and what makes letter-by-letter tracing possible.
"""
import math
import torch
import torch.nn as nn
import torch.nn.functional as F

# ── features: identical in training, evaluation, ONNX export and the app ────────────────────
FEAT = dict(sample_rate=16000, n_fft=512, win=400, hop=160, preemph=0.97, log_guard=2.0 ** -24, n_mels=80)


class Featurizer(nn.Module):
    """16 kHz audio → normalised log-mel features (80 × frames). fb and window come from NeMo's checkpoint."""

    def __init__(self, fb: torch.Tensor, window: torch.Tensor):
        super().__init__()
        self.register_buffer('fb', fb.reshape(FEAT['n_mels'], FEAT['n_fft'] // 2 + 1).float())
        w = torch.zeros(FEAT['n_fft'])
        off = (FEAT['n_fft'] - FEAT['win']) // 2
        w[off:off + FEAT['win']] = window.float()
        self.register_buffer('window', w)

    @torch.no_grad()
    def forward(self, wav: torch.Tensor) -> torch.Tensor:          # wav (samples,) float32
        x = wav.float()
        x = torch.cat([x[:1], x[1:] - FEAT['preemph'] * x[:-1]])
        pad = FEAT['n_fft'] // 2
        x = F.pad(x, (pad, pad))
        frames = x.unfold(0, FEAT['n_fft'], FEAT['hop']) * self.window   # (T, 512)
        spec = torch.fft.rfft(frames, n=FEAT['n_fft']).abs() ** 2        # (T, 257)
        mel = torch.log(spec @ self.fb.T + FEAT['log_guard']).T          # (80, T)
        mel = mel[:, : wav.numel() // FEAT['hop']]                      # NeMo keeps len // hop frames
        mean = mel.mean(dim=1, keepdim=True)
        std = mel.std(dim=1, unbiased=True, keepdim=True) + 1e-5
        return (mel - mean) / std


# ── encoder (NeMo ConformerEncoder, rel_pos attention, striding ×4 subsampling) ───────────
class ConvSubsampling(nn.Module):
    def __init__(self, feat_in=80, d_model=176, channels=176):
        super().__init__()
        self.conv = nn.Sequential(nn.Conv2d(1, channels, 3, 2, 1), nn.ReLU(), nn.Conv2d(channels, channels, 3, 2, 1), nn.ReLU())
        self.out = nn.Linear(channels * ((feat_in + 3) // 4), d_model)

    @staticmethod
    def _mask(x, lengths):                                           # zero the time steps beyond each length
        idx = torch.cumsum(torch.ones_like(x[:, 0, :, 0], dtype=torch.long), dim=1) - 1
        return x * (idx < lengths[:, None]).to(x.dtype)[:, None, :, None]

    def forward(self, x, lengths):                                   # x (B, T, F)
        # NeMo 2.x masks the padding before each convolution, so padded batches give the same result
        x = self._mask(x.unsqueeze(1), lengths)
        x = self.conv[1](self.conv[0](x))
        lengths = torch.div(lengths - 1, 2, rounding_mode='floor') + 1
        x = self._mask(x, lengths)
        x = self.conv[3](self.conv[2](x))
        lengths = torch.div(lengths - 1, 2, rounding_mode='floor') + 1
        x = self._mask(x, lengths)
        b, c, t, f = x.shape
        x = self.out(x.transpose(1, 2).reshape(b, t, c * f))
        return x, lengths


class RelPositionalEncoding(nn.Module):
    """Positions from L-1 down to -(L-1), sliced from a precomputed table (as NeMo does; ONNX-friendly)."""

    def __init__(self, d_model, max_len=5000):
        super().__init__()
        self.xscale = math.sqrt(d_model)
        pos = torch.arange(max_len - 1, -max_len, -1, dtype=torch.float32).unsqueeze(1)
        div = torch.exp(torch.arange(0, d_model, 2, dtype=torch.float32) * -(math.log(10000.0) / d_model))
        pe = torch.zeros(pos.size(0), d_model)
        pe[:, 0::2] = torch.sin(pos * div)
        pe[:, 1::2] = torch.cos(pos * div)
        self.register_buffer('pe', pe.unsqueeze(0), persistent=False)
        self.center = max_len - 1                                     # index of position 0

    def forward(self, x):
        # Index the table with tensors built from x (not Python numbers), so the ONNX export
        # works for any length instead of freezing the length it was exported with.
        a = torch.cumsum(torch.ones_like(x[0, :, 0], dtype=torch.long), dim=0) - 1      # 0 .. L-1
        n = a[-1:]                                                                       # L-1
        idx = torch.cat([self.center - n + a, self.center + 1 + a[:-1]])                 # positions L-1 .. -(L-1)
        return x * self.xscale, self.pe.index_select(1, idx).to(x.dtype)


class RelPositionMultiHeadAttention(nn.Module):
    def __init__(self, n_heads, d_model, dropout=0.1):
        super().__init__()
        self.h, self.dk = n_heads, d_model // n_heads
        self.linear_q = nn.Linear(d_model, d_model)
        self.linear_k = nn.Linear(d_model, d_model)
        self.linear_v = nn.Linear(d_model, d_model)
        self.linear_out = nn.Linear(d_model, d_model)
        self.linear_pos = nn.Linear(d_model, d_model, bias=False)
        self.pos_bias_u = nn.Parameter(torch.zeros(n_heads, self.dk))
        self.pos_bias_v = nn.Parameter(torch.zeros(n_heads, self.dk))
        self.dropout = nn.Dropout(dropout)

    @staticmethod
    def rel_shift(x):
        b, h, q, p = x.size()
        x = F.pad(x, (1, 0)).view(b, h, -1, q)
        return x[:, :, 1:].reshape(b, h, q, p)

    def forward(self, x, pos_emb, mask):                             # mask (B, T, T): True = blocked
        b, t, _ = x.shape
        q = self.linear_q(x).view(b, t, self.h, self.dk)
        k = self.linear_k(x).view(b, t, self.h, self.dk).transpose(1, 2)
        v = self.linear_v(x).view(b, t, self.h, self.dk).transpose(1, 2)
        p = self.linear_pos(pos_emb).view(1, -1, self.h, self.dk).transpose(1, 2)
        ac = (q + self.pos_bias_u).transpose(1, 2) @ k.transpose(-2, -1)
        keep = torch.cumsum(torch.ones_like(x[0, :, 0], dtype=torch.long), dim=0) - 1   # first t columns, ONNX-safe
        bd = self.rel_shift((q + self.pos_bias_v).transpose(1, 2) @ p.transpose(-2, -1)).index_select(3, keep)
        scores = (ac + bd) / math.sqrt(self.dk)
        m = mask.unsqueeze(1)
        scores = scores.masked_fill(m, -10000.0)
        attn = torch.softmax(scores, dim=-1).masked_fill(m, 0.0)
        out = (self.dropout(attn) @ v).transpose(1, 2).reshape(b, t, -1)
        return self.linear_out(out)


class FeedForward(nn.Module):
    def __init__(self, d_model, d_ff, dropout=0.1):
        super().__init__()
        self.linear1 = nn.Linear(d_model, d_ff)
        self.linear2 = nn.Linear(d_ff, d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x):
        return self.linear2(self.dropout(F.silu(self.linear1(x))))


class ConformerConvolution(nn.Module):
    def __init__(self, d_model, kernel=31):
        super().__init__()
        self.pointwise_conv1 = nn.Conv1d(d_model, 2 * d_model, 1)
        self.depthwise_conv = nn.Conv1d(d_model, d_model, kernel, padding=(kernel - 1) // 2, groups=d_model)
        self.batch_norm = nn.BatchNorm1d(d_model)
        self.pointwise_conv2 = nn.Conv1d(d_model, d_model, 1)

    def forward(self, x, pad_mask):                                  # x (B, T, D), pad_mask (B, T): True = padding
        x = F.glu(self.pointwise_conv1(x.transpose(1, 2)), dim=1)
        x = x.masked_fill(pad_mask.unsqueeze(1), 0.0)
        x = self.pointwise_conv2(F.silu(self.batch_norm(self.depthwise_conv(x))))
        return x.transpose(1, 2)


class ConformerLayer(nn.Module):
    def __init__(self, d_model=176, n_heads=4, ff_mult=4, kernel=31, dropout=0.1):
        super().__init__()
        self.norm_feed_forward1 = nn.LayerNorm(d_model)
        self.feed_forward1 = FeedForward(d_model, d_model * ff_mult, dropout)
        self.norm_self_att = nn.LayerNorm(d_model)
        self.self_attn = RelPositionMultiHeadAttention(n_heads, d_model, dropout)
        self.norm_conv = nn.LayerNorm(d_model)
        self.conv = ConformerConvolution(d_model, kernel)
        self.norm_feed_forward2 = nn.LayerNorm(d_model)
        self.feed_forward2 = FeedForward(d_model, d_model * ff_mult, dropout)
        self.norm_out = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x, pos_emb, att_mask, pad_mask):
        x = x + 0.5 * self.dropout(self.feed_forward1(self.norm_feed_forward1(x)))
        x = x + self.dropout(self.self_attn(self.norm_self_att(x), pos_emb, att_mask))
        x = x + self.dropout(self.conv(self.norm_conv(x), pad_mask))
        x = x + 0.5 * self.dropout(self.feed_forward2(self.norm_feed_forward2(x)))
        return self.norm_out(x)


class ConformerEncoder(nn.Module):
    def __init__(self, feat_in=80, n_layers=16, d_model=176, n_heads=4, ff_mult=4, kernel=31, dropout=0.1):
        super().__init__()
        self.pre_encode = ConvSubsampling(feat_in, d_model, d_model)
        self.pos_enc = RelPositionalEncoding(d_model)
        self.layers = nn.ModuleList([ConformerLayer(d_model, n_heads, ff_mult, kernel, dropout) for _ in range(n_layers)])

    def forward(self, feats, lengths):                               # feats (B, 80, T)
        x, lengths = self.pre_encode(feats.transpose(1, 2), lengths)
        x, pos_emb = self.pos_enc(x)
        idx = torch.cumsum(torch.ones_like(x[:, :, 0], dtype=torch.long), dim=1) - 1   # 0..T-1, traceable
        valid = idx < lengths[:, None]
        pad_mask = ~valid
        att_mask = ~(valid[:, None, :] & valid[:, :, None])
        for layer in self.layers:
            x = layer(x, pos_emb, att_mask, pad_mask)
        return x, lengths


class Head(nn.Module):
    def __init__(self, d_model, n_out):
        super().__init__()
        self.decoder_layers = nn.Sequential(nn.Conv1d(d_model, n_out, 1))


class QaafASR(nn.Module):
    """Encoder + CTC output layer. n_out = number of classes + 1 (the CTC blank, always last)."""

    def __init__(self, n_out, d_model=176, n_layers=16, dropout=0.1):
        super().__init__()
        self.encoder = ConformerEncoder(80, n_layers, d_model, 4, 4, 31, dropout)
        self.decoder = Head(d_model, n_out)

    def forward(self, feats, lengths):
        x, lengths = self.encoder(feats, lengths)
        logits = self.decoder.decoder_layers(x.transpose(1, 2)).transpose(1, 2)
        return logits.float().log_softmax(dim=-1), lengths


def load_nemo_weights(model: QaafASR, ckpt_path: str, keep_head: bool):
    """Load NeMo's model_weights.ckpt. With keep_head=False the original word-piece output layer is skipped."""
    sd = torch.load(ckpt_path, map_location='cpu')
    sd = sd.get('state_dict', sd)
    own = {k: v for k, v in sd.items() if k.startswith('encoder.') or (keep_head and k.startswith('decoder.'))}
    missing, unexpected = model.load_state_dict(own, strict=False)
    missing = [k for k in missing if not k.startswith('decoder.') or keep_head]
    return sd, missing, unexpected
