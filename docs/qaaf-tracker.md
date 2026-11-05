# The Qāf tracker: following a reader word by word

Used by the Recite page and the Hifz test (Qāf wal-Qurʾān al-Majīd) and by the Mujawwadah and Hifz sessions of the
Ta'aleem Virtual Classroom. Same files in both repos: `src/lib/tracker.mjs`, `src/lib/qaaf-worker.mjs`,
`src/lib/track-recognition.mjs`.

## What was wrong (November 2026)

Measured by playing the same 55 s recitation through each engine, with each step charged at the speed of a
student laptop:

| Engine | Words shown | Typical delay | Worst delay | Longest freeze |
|---|---|---|---|---|
| Classroom: Qāf model as a recogniser (`asr-local.mjs`) | 43 / 44 | 3.1 s | 14.8 s | 14.8 s |
| App: Qāf aligner, as it was wired (`align-recognition.mjs`) | 10 / 44 | 23 s | 41 s | 11.5 s |
| App default: browser speech (Google's service) | not measurable here | about 1 s or more | | stops and restarts |
| **Qāf tracker** | **44 / 44** | **0.4–0.7 s** | **1.8–3.4 s** | **1.8–3.4 s** |

1. **The classroom re-decoded the whole utterance every 0.15 s.** An ayah recited in one breath is 10–14 s of
   audio, so each step cost 1–3 s on a laptop, on the page's own thread. Words came late and in bursts, and the
   page froze while it worked.
2. **The app's aligner restarted itself into a loop.** Over its 2.4 s window it often passed a word having heard
   only part of it. The page dropped that word, the aligner saw that the page had not moved, and started again
   from the page's word, though the reader had already gone on. Each restart threw away seconds of listening.
3. **Browser speech is not built for recitation.** It sends audio to a server, settles on words only at pauses,
   hears tajweed as everyday Arabic, and ends its session every so often, so it has to be restarted. It stays as
   the fallback for browsers that cannot run the model.
4. **The Sheikh prompted readers who were still reciting.** His silence timer counted confirmed words only.
5. **Page turns rebuilt the page at the moment of turning**, so the next words waited for it to be laid out.

## How the tracker works

We already know the text, so the reader is followed through it rather than transcribed. That is also how
Tarteel works: a recitation model (theirs is a NeMo Conformer-CTC) whose letter probabilities are matched to the
expected text. The Qāf model is the same kind of model (a small Conformer-CTC trained on CAIR).

- **Off the page's thread.** An AudioWorklet sends the microphone straight to a Web Worker, which runs the model
  and the tracker. The page only draws.
- **A short look, often.** Every 0.12–0.4 s (slower devices look less often), the model looks at the last
  1.6 s of audio. That costs 60–250 ms, whatever the length of the ayah.
- **Frames are rewritten.** Each look replaces its recent letter probabilities with better ones, because by
  then it has heard a little more audio after each letter. This alone halved the delay on fast devices.
- **The recent past is re-aligned every time.** The tracker aligns the last few seconds against a window of the
  text around the reader (semi-global CTC alignment). An early slip by the tracker is corrected a moment later
  instead of sending it off course. It allows for:
  - pauses and held vowels;
  - a reader starting further on;
  - going back to repeat words;
  - something that is not in the text at all (a cough, a wrong word, the teacher talking).
- **Words are committed only forward.** A word is "read" when the path has gone through it, or when the voice
  stops for 0.2 s after its last letter (the end of an ayah). It is "missed" only if something else was said in
  its place. A word passed too quickly to judge is "unclear", which is never counted as a mistake.
- **A live cursor.** Several times a second the page learns which word the reader is in and how far into it.
  That word fills from right to left as it is said, before it is confirmed.

## Checking it on real reciters

Actions → **Speech - measure the Qāf tracker** → Run workflow. It plays 25 ayahs each by Husary and Minshawy (not
in the model's training) and Alafasy (in it), and uploads `tracker-report.txt`:

- words tracked;
- typical, 90th-percentile and worst delay;
- correctly recited words wrongly flagged;
- words wrongly run on to.

Locally: `node tools/tracker/measure.mjs <model dir> <audio dir>` (set `DEVICE=1` for a fast computer).

The thresholds in `createTracker` (`weak`, `filler`, `jump`) were set on test recordings. The workflow's report
is what to tune them against.
