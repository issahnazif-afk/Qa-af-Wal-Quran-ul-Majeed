# Training the Qaf recitation model on CAIR

Goal: teach the small, fast Arabic Conformer-CTC model to hear **Quran recitation**, letter by letter,
so the app can track readers on the phone with almost no delay. Pure PyTorch: no NeMo needed on CAIR.

Layout on CAIR (`~/qaaf_asr`): `code/` scripts · `jobs/` LSF jobs · `model/` starting weights ·
`mp3/` recitations · `data/` features · `ckpt/` checkpoints · `export/` the finished model · `logs/`

Disk: about 17 GB of MP3 plus 15 GB of features for all 17 reciters. Fewer reciters: see step 6.

## Steps (all typed in Windows cmd, one line at a time)

**1. Upload and unpack**
```
cair_run "mkdir -p ~/qaaf_asr/logs"
scp -i "%USERPROFILE%\.ssh\id_cair" "C:\Users\csgrad\Downloads\qaaf_asr_cair.zip" insuleiman@10.250.0.22:qaaf_asr/
cair_run "cd ~/qaaf_asr && unzip -o qaaf_asr_cair.zip && ls code jobs"
```

**2. Use the same Python environment as your other GPU jobs**
```
cair_run "grep -E '^(module|source|conda|export|ml )' ~/pseudo_label/jobs/unet30_smoke.lsf > ~/qaaf_asr/env.sh; cat ~/qaaf_asr/env.sh"
```
It should show the lines that activate `envs/torch`. Check PyTorch sees the GPU type later in the smoke test.

**3. ffmpeg (decodes the MP3s), once**
```
cair_run "which ffmpeg || ls ~/envs/ffmpeg/bin/ffmpeg"
```
If neither is found:
```
cair_run "source ~/qaaf_asr/env.sh; conda create -y -p ~/envs/ffmpeg -c conda-forge ffmpeg"
```

**4. Download the model and the recitations** (login node, runs in the background, a few hours)
```
cair_run "cd ~/qaaf_asr/code && nohup python3 prepare.py download > ~/qaaf_asr/logs/download.log 2>&1 < /dev/null &"
cair_run "tail -n 5 ~/qaaf_asr/logs/download.log"
```
It downloads the two test reciters first. Once `Husary_128kbps done` and `Minshawy_Murattal_128kbps done`
appear, the smoke test can run while the rest continue.

**5. Smoke test** (about 20 minutes)
```
cair_run "bsub < ~/qaaf_asr/jobs/qaaf_smoke.lsf"
cair_run "bjobs"
cair_run "tail -n 30 ~/qaaf_asr/logs/smoke.*.out"
```
Look for `Tesla V100`, falling `loss`, `exported`, and `SMOKE TEST FINISHED`.

**6. Features for everything** (after the log shows `ALL DOWNLOADS FINISHED`)
```
cair_run "bsub < ~/qaaf_asr/jobs/qaaf_features.lsf"
cair_run "tail -n 5 ~/qaaf_asr/logs/features.*.out"
```
Resubmit if it hits the time limit: finished reciters are skipped. To use fewer reciters, delete
folders from `~/qaaf_asr/mp3/` before this step (keep Husary and Minshawy: they are the test set).

**7. Train** (each job runs up to 8 h and saves; resubmit until it says TRAINING COMPLETE)
```
cair_run "bsub < ~/qaaf_asr/jobs/qaaf_train.lsf"
cair_run "grep -E 'EPOCH|best|COMPLETE|BUDGET|Error' ~/qaaf_asr/logs/train.*.out | tail -n 12"
```
Each `EPOCH` line reports the error rates on a reciter the model has never heard.

**8. Test and export**
```
cair_run "bsub < ~/qaaf_asr/jobs/qaaf_eval.lsf"
cair_run "cat ~/qaaf_asr/export/report.txt"
```

**9. Bring the model home**
```
scp -i "%USERPROFILE%\.ssh\id_cair" -r insuleiman@10.250.0.22:qaaf_asr/export "C:\Users\csgrad\Downloads\qaaf_asr_export"
```
Send `report.txt`; with `qaaf-asr.onnx`, `features.json` and `vocab.json` the app switches to this model.

## Methods sentence
"The recitation model was fine-tuned from an open Arabic Conformer-CTC (small, 16 layers, d=176) on
EveryAyah murattal recitations of the full Quran by N reciters, with two reciters held out for testing,
using character-level CTC on NVIDIA Tesla V100-SXM2 (32 GB) GPUs at Memorial University's CAIR cluster,
one GPU per run, PyTorch 2.1.2, CUDA 12.2, mixed precision."
