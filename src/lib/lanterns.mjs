// Noor Lanterns: hear a letter's name and light its lantern; from Level 2, also say a letter's name to the Sheikh.
// Builds its lanterns inside `stage`; the rest of the screen (Sheikh, bubble, score) is in index.astro.
import { LETTERS, LEVEL_GAME, lookalikes, heardLetter, hasLetterRecording, letterAudioUrl, MASTERED, lessonState } from './alifba.mjs';
import { phrase, speak, stopVoice } from './phrases.mjs';
import { glow, soft } from './ambience.mjs';
import { tuneRecognition, phrasesRefused } from './speech.mjs';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const NS = 'http://www.w3.org/2000/svg';

function lanternSvg(size) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 150 250'); svg.setAttribute('width', size); svg.setAttribute('height', Math.round(size * 250 / 150)); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M75 0 V24" stroke="#C9A24A" stroke-width="2"/><circle class="halo" cx="75" cy="130" r="95" fill="#FBE3A6"/>'
    + '<path d="M52 24 H98 L90 44 H60 Z" fill="#C9A24A"/><path class="glass" d="M58 44 H92 L116 120 L92 206 H58 L34 120 Z" stroke="#C9A24A" stroke-width="4"/>'
    + '<path d="M75 44 V206 M34 120 H116" stroke="#C9A24A" stroke-width="1.6" opacity=".5"/><path d="M62 206 H88 L80 226 H70 Z" fill="#C9A24A"/><circle cx="75" cy="236" r="5" fill="#C9A24A"/>';
  return svg;
}

export function createLanterns({ stage, level = 1, gender = '', SR = null, progress = {}, ui = {} }) {
  const cfg = LEVEL_GAME[level] ?? LEVEL_GAME[1];
  const canSpeak = cfg.speak && !!SR;
  const P = (k) => phrase(k, gender);
  progress.letters ??= {};
  const t0 = Date.now();
  let round = 0, first = 0, score = 0, streak = 0, done = false, timer = null, rec = null;
  const practise = new Set();
  let current = null;   // { target, attempts, type }

  // letters still to learn come up more often
  function pickTarget(prev) {
    const weights = LETTERS.map((l) => (l.letter === prev ? 0 : Math.max(1, MASTERED + 1 - (progress.letters[l.letter] ?? 0)) ** 2));
    let x = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < LETTERS.length; i++) { x -= weights[i]; if (x <= 0) return LETTERS[i]; }
    return LETTERS[0];
  }
  function choicesFor(target) {
    const n = cfg.lanterns;
    let pool;
    if (cfg.similar) pool = [...lookalikes(target.letter), ...shuffle(LETTERS.map((l) => l.letter))];
    else { const avoid = new Set(lookalikes(target.letter)); pool = shuffle(LETTERS.map((l) => l.letter)).filter((l) => !avoid.has(l)); }
    const out = [target.letter];
    for (const l of pool) { if (out.length >= n) break; if (!out.includes(l)) out.push(l); }
    return shuffle(out);
  }

  async function sayLetter(L) {
    if (await hasLetterRecording(L.file)) {
      const a = new Audio(letterAudioUrl(L.file));
      await new Promise((r) => { a.onended = r; a.onerror = r; a.play().catch(r); setTimeout(r, 4000); });
      return;
    }
    await speak({ ar: L.name, file: '' });
  }

  function clearTimer() { clearInterval(timer); timer = null; ui.timer?.(null); }
  function startTimer(onOut) {
    if (!cfg.timer) return;
    let left = cfg.timer;
    ui.timer?.({ left, total: cfg.timer });
    timer = setInterval(() => { left--; ui.timer?.({ left, total: cfg.timer }); if (left <= 0) { clearTimer(); onOut(); } }, 1000);
  }
  const status = () => ui.status?.({ round, rounds: cfg.rounds, first, score, streak, showScore: cfg.score, known: lessonState(progress).known });

  // ── a tap round ──
  async function tapRound(target) {
    current = { target, attempts: 0, type: 'tap' };
    const letters = choicesFor(target);
    stage.replaceChildren();
    stage.dataset.type = 'tap'; stage.dataset.count = String(letters.length);
    const size = { 3: 190, 4: 170, 6: 140, 8: 120 }[letters.length] ?? 140;
    const buttons = letters.map((letter) => {
      const b = el('button', 'lantern');
      b.type = 'button';
      b.setAttribute('aria-label', `Lantern with the letter ${letter}`);
      b.append(lanternSvg(size), el('span', 'lt', letter));
      b.style.setProperty('--fs', `${Math.round(size * 0.48)}px`);
      b.addEventListener('click', () => choose(b, letter));
      stage.append(b);
      return b;
    });
    ui.sheikh?.('speaking', target.name, 'Which lantern is this letter?');
    await sayLetter(target);
    if (done || current?.target !== target) return;
    ui.sheikh?.('listening', target.name, 'Light its lantern.');
    startTimer(() => { if (!done && current?.target === target) reveal(buttons, letters, target); });

    async function choose(b, letter) {
      if (done || current?.target !== target || b.disabled) return;
      current.attempts++;
      if (letter === target.letter) {
        clearTimer();
        buttons.forEach((x) => (x.disabled = true));
        b.classList.add('lit');
        await correct(target);
      } else {
        soft();
        b.classList.add('sway'); b.disabled = true;
        setTimeout(() => b.classList.remove('sway'), 500);
        streak = 0; practise.add(target.letter);
        const other = LETTERS.find((l) => l.letter === letter);
        ui.feedback?.(level <= 2 ? 'Listen again…' : `That is ${other.latin} (${other.name}). Listen again and look at the dots.`, 'bad');
        status();
        if (level <= 2) await sayLetter(target);
      }
    }
  }
  async function reveal(buttons, letters, target) {
    buttons.forEach((x, i) => { x.disabled = true; if (letters[i] === target.letter) x.classList.add('lit', 'shown'); });
    streak = 0; practise.add(target.letter);
    ui.feedback?.(`Time is up. This is ${target.latin}, ${target.name}.`, 'bad');
    status();
    await sayLetter(target);
    await wait(1200);
    next();
  }

  // ── a speaking round ──
  async function speakRound(target) {
    current = { target, attempts: 0, type: 'speak' };
    stage.replaceChildren();
    stage.dataset.type = 'speak'; stage.dataset.count = '1';
    const b = el('div', 'lantern big lit');
    b.append(lanternSvg(220), el('span', 'lt', target.letter));
    b.style.setProperty('--fs', '120px');
    const mic = el('div', 'speak-mic');
    mic.innerHTML = '<span class="mic-dot" aria-hidden="true"></span><span class="mic-t">Say this letter’s name</span>';
    stage.append(b, mic);
    ui.sheikh?.('listening', P('read').ar, 'Say the name of this letter.');
    ui.feedback?.('Say the name of this letter, clearly.', '');
    let settled = false;
    const finish = async (ok) => {
      if (settled) return; settled = true;
      stopRec(); clearTimer();
      if (ok) await correct(target);
      else {
        streak = 0; practise.add(target.letter);
        ui.feedback?.(`This is ${target.latin}: ${target.name}. Listen.`, 'bad');
        status();
        await sayLetter(target);
        await wait(1000);
        next();
      }
    };
    startRec((text) => {
      mic.querySelector('.mic-t').textContent = `Heard: ${text}`;
      if (heardLetter(text, target)) finish(true);
      else { current.attempts++; if (current.attempts >= 3) finish(false); else { soft(); ui.feedback?.('Not quite. Try once more.', 'bad'); } }
    });
    startTimer(() => finish(false));
    if (!cfg.timer) setTimeout(() => { if (!settled && current?.target === target) finish(false); }, 12000);
  }
  function startRec(onText) {
    try {
      rec = tuneRecognition(new SR(), { expect: [current.target.name, ...LETTERS.map((l) => l.name)] });
      rec.lang = 'ar-SA'; rec.continuous = true; rec.interimResults = false; rec.maxAlternatives = 3;
      const me = rec;
      rec.onresult = (e) => { if (me !== rec) return; for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; const alts = [...Array(r.length)].map((_, k) => r[k].transcript).join(' '); onText(alts.trim()); } };
      rec.onerror = (e) => { phrasesRefused(e); };
      rec.onend = () => { if (me === rec) { try { rec.start(); } catch {} } };
      rec.start();
      ui.mic?.(true);
    } catch { ui.feedback?.('The microphone could not start. Tap the lanterns instead.', 'bad'); }
  }
  function stopRec() { const r = rec; rec = null; try { r?.stop(); } catch {} ui.mic?.(false); }

  async function correct(target) {
    glow();
    const firstTry = current.attempts <= 1;
    if (firstTry) { first++; progress.letters[target.letter] = Math.min(9, (progress.letters[target.letter] ?? 0) + 1); streak++; }
    if (cfg.score) score += firstTry ? 100 + 25 * Math.min(streak, 8) : 40;
    const praise = P(streak >= 3 && firstTry ? 'mumtaz' : 'ahsant');
    ui.sheikh?.('stop', praise.ar, praise.en);
    ui.feedback?.(firstTry ? `${praise.en} ${target.latin}, ${target.name}.` : `${target.latin}, ${target.name}.`, 'good');
    status();
    ui.lit?.(target);
    if (level <= 2) await speak(praise); else await wait(900);
    next();
  }

  async function next() {
    if (done) return;
    clearTimer(); stopRec();
    round++;
    status();
    if (round > cfg.rounds) return finish();
    const target = pickTarget(current?.target.letter);
    ui.feedback?.('', '');
    if (canSpeak && round % 3 === 0) await speakRound(target);
    else await tapRound(target);
  }

  function finish() {
    if (done) return;
    done = true;
    clearTimer(); stopRec(); stopVoice();
    progress.played = (progress.played ?? 0) + 1;
    if (cfg.score) progress.best = Math.max(progress.best ?? 0, score);
    const st = lessonState(progress);
    ui.finished?.({
      rounds: cfg.rounds, first, accuracy: Math.round((first / cfg.rounds) * 100), score: cfg.score ? score : null,
      practise: [...practise], known: st.known, lit: st.lit, grown: st.grown, best: progress.best ?? null,
      minutes: Math.max(1, Math.round((Date.now() - t0) / 60000)),
    });
  }

  return {
    start() { round = 0; next(); },
    replay() { if (current && !done) sayLetter(current.target); },
    stop() { done = true; clearTimer(); stopRec(); stopVoice(); },
    get config() { return cfg; },
  };
}
