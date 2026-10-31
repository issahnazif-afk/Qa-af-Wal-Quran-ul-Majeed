// Talks to the class log (the Google Apps Script web app in apps-script/Code.gs):
// the list of classes, student accounts, sign-in, and saving finished sessions.
// Requests are sent as text/plain so the browser makes a simple request with no preflight,
// which Apps Script web apps accept from any website.
//
// With no web app address set, the classroom runs in demo mode: any username works,
// accounts are not kept and sessions are not saved anywhere.
import { store } from './client.mjs';

let URL_ = '';
export const configure = (url) => { URL_ = url || ''; };
export const isDemo = () => !URL_;

async function post(body, { timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

const MESSAGES = {
  'unknown-class': 'That class was not found. Choose your level from the list.',
  'wrong-class-password': 'That class password is not right. Ask your teacher for your level’s class password.',
  'no-name': 'Enter your full name.',
  'bad-username': 'Usernames are 3 to 24 letters or numbers, and may use . _ or - (no spaces).',
  'short-password': 'Choose a password of at least 6 characters.',
  'username-taken': 'That username is already taken. Try another one.',
  'bad-login': 'The username or password is not right.',
  'class-removed': 'Your class is no longer listed. Ask your teacher.',
  'bad-gender': 'Choose Boy or Girl.',
  'signed-out': 'Your sign-in has expired. Sign in again to send this session.',
};
const OFFLINE = 'The classroom server could not be reached. Check your internet connection and try again.';
const DEMO_CLASSES = [1, 2, 3, 4].map((n) => ({ code: `LEVEL-${n}`, name: `Level ${n}` }));

export async function listClasses() {
  if (isDemo()) return { ok: true, classes: DEMO_CLASSES };
  try { const r = await post({ action: 'classes' }); return r.ok ? r : { ok: false, message: OFFLINE }; }
  catch { return { ok: false, message: OFFLINE }; }
}

async function account(body) {
  if (isDemo()) {
    const cls = DEMO_CLASSES.find((c) => c.code === body.classCode) ?? DEMO_CLASSES[0];
    return { ok: true, demo: true, username: String(body.username || '').toLowerCase(), name: body.name || body.username, gender: body.gender || 'm', classCode: cls.code, className: cls.name, token: 'demo' };
  }
  try {
    const r = await post(body);
    if (r.ok) return r;
    return { ok: false, error: r.error, message: MESSAGES[r.error] ?? 'That did not work. Try again.' };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}
export const register = (b) => account({ action: 'register', ...b });
export const login = (b) => account({ action: 'login', ...b });
export async function setGender({ token, gender }) {
  if (isDemo()) return { ok: true };
  try { const r = await post({ action: 'profile', token, gender }); return r.ok ? r : { ok: false, message: MESSAGES[r.error] ?? 'That did not work. Try again.' }; }
  catch { return { ok: false, message: OFFLINE }; }
}

// Sessions that could not be sent yet wait here and are retried.
const OUTBOX = 'outbox';
const outbox = () => store.get(OUTBOX, []);

export async function sendSession(entry) {
  if (isDemo()) { console.info('[classroom] demo mode, session not saved:', entry.session); return { ok: true, demo: true }; }
  try {
    const r = await post({ action: 'log', ...entry }, { timeout: 45000 });
    if (r.ok) return r;
    if (r.error === 'signed-out' || r.error === 'class-removed') return { ok: false, final: true, message: MESSAGES[r.error] };
    throw new Error(r.error || 'failed');
  } catch {
    const list = outbox().filter((x) => x.session.id !== entry.session.id);
    list.push(entry);
    store.set(OUTBOX, list.slice(-20));
    return { ok: false, queued: true };
  }
}

export async function flushOutbox() {
  if (isDemo()) return 0;
  const list = outbox();
  if (!list.length) return 0;
  const left = [];
  for (const entry of list) {
    try { const r = await post({ action: 'log', ...entry }, { timeout: 45000 }); if (!r.ok && !['signed-out', 'class-removed'].includes(r.error)) left.push(entry); }
    catch { left.push(entry); }
  }
  store.set(OUTBOX, left);
  return list.length - left.length;
}
export const pendingCount = () => outbox().length;

// ── Alif Ba progress and game results ─────────────────────────
// Progress lives in the student's row of the admin sheet, so it follows them to any computer.
// A copy is kept in the browser too, so nothing is lost if the connection drops.
const localKey = (username) => 'progress-' + username;
export async function getProgress({ token, username }) {
  const local = store.get(localKey(username), {});
  if (isDemo()) return local;
  try {
    const r = await post({ action: 'progress', token });
    if (!r.ok) return local;
    const remote = r.progress || {};
    return (remote.updated || 0) >= (local.updated || 0) ? remote : local;
  } catch { return local; }
}
export async function saveProgress({ token, username, progress }) {
  progress.updated = Date.now();
  store.set(localKey(username), progress);
  if (isDemo()) return { ok: true, demo: true };
  try { return await post({ action: 'save-progress', token, progress }); } catch { return { ok: false }; }
}
export async function logGame({ token, game }) {
  if (isDemo()) { console.info('[classroom] demo mode, game not saved:', game); return { ok: true, demo: true }; }
  try { return await post({ action: 'game', token, game }); } catch { return { ok: false }; }
}
