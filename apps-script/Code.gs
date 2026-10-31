/**
 * Al-Huda Islamic Weekend School · Ta'aleem Virtual Classroom — accounts and class log.
 * (The Sheikh and recitation checking come from the Qa-af Wal Quran-ul-Majeed app.)
 *
 * The classroom website (GitHub Pages) talks to this script. It:
 *   • lists the classes (Level 1 to Level 4) for the sign-up form,
 *   • creates student accounts: each student gives their gender (so the Sheikh can address them
 *     properly) and picks a unique username and a password; to join a
 *     level they also need that level's class password from the teacher ("Classes" tab),
 *   • signs students in with their username and password (passwords are stored only as salted hashes),
 *   • keeps ONE folder per class in your shared Drive folder ("Level 1"), holding that class's
 *     Google Sheet ("Level 1 · session log") and a "Snapshots" folder with the login photos,
 *   • adds one row per finished session to the class's sheet.
 *
 * Set up once (full steps in apps-script/README.md):
 *   1. Create a Google Sheet called "Ta'aleem classroom admin". Extensions → Apps Script. Paste this file.
 *   2. Put your shared folder's ID in FOLDER_ID below, then run setup() once and allow access.
 *   3. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *   4. Copy the Web app URL into GitHub as the repository variable CLASS_LOG_URL.
 *
 * Teachers: to reset a student's password, type a new temporary password in the "Reset password"
 * column of the Students tab. The student signs in with it once and it becomes their password.
 */

// The ID of the shared Google Drive folder (the part after /folders/ in its address).
const FOLDER_ID = 'PASTE_YOUR_FOLDER_ID_HERE';

const CLASSES_TAB = 'Classes';
const CLASS_HEADERS = ['Class code', 'Class name', 'Class password', 'Teacher', 'Log sheet'];
const STUDENTS_TAB = 'Students';
const STUDENT_HEADERS = ['Username', 'Full name', 'Class', 'Joined', 'Last sign-in', 'Reset password', 'Password hash', 'Salt', 'Gender', 'Alif Ba progress'];
const S = { user: 0, name: 1, cls: 2, joined: 3, last: 4, reset: 5, hash: 6, salt: 7, gender: 8, progress: 9 };   // column positions
const GENDER = { m: 'Male', f: 'Female' };
const LOG_HEADERS = [
  'Session ID', 'Student name', 'Username', 'Gender', 'Class', 'Login time', 'End time', 'Minutes spent',
  'Session type', 'Difficulty', 'Surahs recited', 'Ayahs', 'Questions', 'Words recited',
  'Right first time (%)', 'Grade', 'Total mistakes', 'Most observed mistakes',
  'Wrong words', 'Forgotten (Sheikh prompted)', 'Hints used', 'Unclear', 'Went back over words',
  'Looked away', 'Snapshot', 'Review',
];
const TOKEN_DAYS = 30;        // a sign-in stays valid this long for sending session logs
const HASH_ROUNDS = 300;

// ── set up ──────────────────────────────────────────────────────
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CLASSES_TAB);
  if (!sh) sh = ss.insertSheet(CLASSES_TAB, 0);
  if (sh.getLastRow() === 0) {
    sh.appendRow(CLASS_HEADERS);
    // the four levels, each with its own class password (change them as you like)
    for (let n = 1; n <= 4; n++) sh.appendRow(['LEVEL-' + n, 'Level ' + n, newPassword(), '', '']);
  }
  sh.getRange(1, 1, 1, CLASS_HEADERS.length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, CLASS_HEADERS.length);

  let st = ss.getSheetByName(STUDENTS_TAB);
  if (!st) st = ss.insertSheet(STUDENTS_TAB, 1);
  if (st.getLastRow() === 0) st.appendRow(STUDENT_HEADERS);
  else if (String(st.getRange(1, S.gender + 1).getValue()) !== 'Gender') st.getRange(1, S.gender + 1).setValue('Gender');   // older sheets
  st.getRange(1, 1, 1, STUDENT_HEADERS.length).setFontWeight('bold');
  st.getRange(1, S.reset + 1).setBackground('#FBE3A6').setNote('Teachers: type a temporary password here to reset a student\'s password. It is cleared once the student signs in with it.');
  st.getRange(1, S.hash + 1, 1, 2).setFontColor('#9AA5A0');
  st.setFrozenRows(1);
  st.getRange('D:E').setNumberFormat('yyyy-mm-dd hh:mm');
  st.hideColumns(S.hash + 1, 2);

  secret();                                       // creates the signing key used for sign-ins
  DriveApp.getFolderById(FOLDER_ID).getName();   // asks for Drive access and checks the folder ID
  SpreadsheetApp.getUi().alert('Ready. The Classes tab lists Level 1 to Level 4 with their class passwords; students need these once, to create their accounts. Change them if you like, then deploy as a web app.');
}

function newPassword() {
  const words = ['noor', 'huda', 'iqra', 'sabr', 'ilm', 'amal', 'salam', 'barakah'];
  return words[Math.floor(Math.random() * words.length)] + (1000 + Math.floor(Math.random() * 9000));
}

// ── web app ─────────────────────────────────────────────────────
function doGet() {
  return json({ ok: true, service: 'taaleem-classroom' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad-request' }); }
  try {
    if (body.action === 'classes') return json(listClasses());
    if (body.action === 'register') return json(register(body));
    if (body.action === 'login') return json(login(body));
    if (body.action === 'profile') return json(profile(body));
    if (body.action === 'progress') return json(getProgress(body));
    if (body.action === 'save-progress') return json(saveProgress(body));
    if (body.action === 'game') return json(logGame(body));
    if (body.action === 'log') return json(logSession(body));
    return json({ ok: false, error: 'unknown-action' });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── classes ─────────────────────────────────────────────────────
const key = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function classRows() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CLASSES_TAB);
  if (!sh) throw new Error('Run setup() first');
  return { sh, rows: sh.getDataRange().getValues() };
}

// "Level 1", "level-1", "LEVEL1" all find the class LEVEL-1
function findClass(code) {
  const { sh, rows } = classRows();
  const want = key(code);
  for (let r = 1; r < rows.length; r++) {
    if (want && (key(rows[r][0]) === want || key(rows[r][1]) === want)) {
      return { row: r + 1, code: String(rows[r][0]).trim(), name: String(rows[r][1] || rows[r][0]), password: String(rows[r][2]), logUrl: String(rows[r][4] || ''), sheet: sh };
    }
  }
  return null;
}

function listClasses() {
  const { rows } = classRows();
  return { ok: true, classes: rows.slice(1).filter((r) => r[0]).map((r) => ({ code: String(r[0]).trim(), name: String(r[1] || r[0]) })) };
}

// ── accounts ────────────────────────────────────────────────────
function studentsSheet() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(STUDENTS_TAB);
  if (!sh) throw new Error('Run setup() first');
  if (String(sh.getRange(1, S.gender + 1).getValue()) !== 'Gender') sh.getRange(1, S.gender + 1).setValue('Gender').setFontWeight('bold');
  if (String(sh.getRange(1, S.progress + 1).getValue()) !== 'Alif Ba progress') sh.getRange(1, S.progress + 1).setValue('Alif Ba progress').setFontWeight('bold');
  return sh;
}

function findStudent(sh, username) {
  const want = String(username || '').trim().toLowerCase();
  if (!want) return null;
  const rows = sh.getDataRange().getValues();
  for (let r = 1; r < rows.length; r++) if (String(rows[r][S.user]).trim().toLowerCase() === want) return { row: r + 1, v: rows[r] };
  return null;
}

function hashPassword(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + '|' + password, Utilities.Charset.UTF_8));
  }
  return h;
}

function secret() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('TOKEN_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('TOKEN_SECRET', s); }
  return s;
}

function sign(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret()));
}

function makeToken(username) {
  const payload = String(username).toLowerCase() + '|' + (Date.now() + TOKEN_DAYS * 864e5);
  return Utilities.base64EncodeWebSafe(payload) + '.' + sign(payload);
}

function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  let payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString(); } catch (err) { return null; }
  if (sign(payload) !== parts[1]) return null;
  const [user, exp] = payload.split('|');
  if (!(Number(exp) > Date.now())) return null;
  return user;
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;

function register(body) {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (name.length < 3) return { ok: false, error: 'no-name' };
  if (!USERNAME_RE.test(username)) return { ok: false, error: 'bad-username' };
  if (password.length < 6) return { ok: false, error: 'short-password' };
  const gender = String(body.gender || '');
  if (!GENDER[gender]) return { ok: false, error: 'bad-gender' };
  const cls = findClass(body.classCode);
  if (!cls) return { ok: false, error: 'unknown-class' };
  if (!cls.password || String(body.classPassword || '') !== cls.password) return { ok: false, error: 'wrong-class-password' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = studentsSheet();
    if (findStudent(sh, username)) return { ok: false, error: 'username-taken' };
    const salt = Utilities.getUuid();
    sh.appendRow([username, name, cls.name, new Date(), new Date(), '', hashPassword(password, salt), salt, GENDER[gender]]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, username, name, gender, classCode: cls.code, className: cls.name, token: makeToken(username) };
}

function login(body) {
  const sh = studentsSheet();
  const st = findStudent(sh, body.username);
  if (!st) return { ok: false, error: 'bad-login' };
  const password = String(body.password || '');
  const reset = String(st.v[S.reset] || '');
  let ok = st.v[S.hash] && hashPassword(password, String(st.v[S.salt])) === String(st.v[S.hash]);
  if (!ok && reset && password === reset) {
    // the teacher's temporary password becomes the student's password
    const salt = Utilities.getUuid();
    sh.getRange(st.row, S.reset + 1).setValue('');
    sh.getRange(st.row, S.hash + 1, 1, 2).setValues([[hashPassword(password, salt), salt]]);
    ok = true;
  }
  if (!ok) return { ok: false, error: 'bad-login' };
  sh.getRange(st.row, S.last + 1).setValue(new Date());
  const cls = findClass(st.v[S.cls]);
  if (!cls) return { ok: false, error: 'class-removed' };
  return { ok: true, username: String(st.v[S.user]), name: String(st.v[S.name]), gender: genderCode(st.v[S.gender]), classCode: cls.code, className: cls.name, token: makeToken(st.v[S.user]) };
}

// "Male" / "Female" in the sheet → "m" / "f" for the website ("" if not set yet)
function genderCode(v) {
  const x = String(v || '').trim().toLowerCase();
  return x.startsWith('f') || x === 'girl' ? 'f' : x.startsWith('m') || x === 'boy' ? 'm' : '';
}

// Accounts made before gender was asked set it once, after signing in.
function profile(body) {
  const user = readToken(body.token);
  if (!user) return { ok: false, error: 'signed-out' };
  const gender = String(body.gender || '');
  if (!GENDER[gender]) return { ok: false, error: 'bad-gender' };
  const sh = studentsSheet();
  const st = findStudent(sh, user);
  if (!st) return { ok: false, error: 'signed-out' };
  sh.getRange(st.row, S.gender + 1).setValue(GENDER[gender]);
  return { ok: true, gender };
}

// ── class folders and sheets ────────────────────────────────────
// Each class has its own folder in the shared folder, named after the class ("Level 1").
function classFolder(cls) {
  const root = DriveApp.getFolderById(FOLDER_ID);
  const it = root.getFoldersByName(cls.name);
  return it.hasNext() ? it.next() : root.createFolder(cls.name);
}

// One Google Sheet per class, inside the class's folder, created the first time it is needed.
function classLog(cls) {
  if (cls.logUrl) {
    try { return SpreadsheetApp.openByUrl(cls.logUrl); } catch (err) { /* deleted: make a new one */ }
  }
  const ss = SpreadsheetApp.create(cls.name + ' · session log');
  DriveApp.getFileById(ss.getId()).moveTo(classFolder(cls));
  const sh = ss.getSheets()[0];
  sh.setName('Sessions');
  sh.appendRow(LOG_HEADERS);
  sh.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold').setBackground('#E6F2EC');
  sh.setFrozenRows(1);
  sh.getRange('F:G').setNumberFormat('yyyy-mm-dd hh:mm');
  cls.sheet.getRange(cls.row, 5).setValue(ss.getUrl());
  return ss;
}

function snapshotFolder(cls) {
  const parent = classFolder(cls);
  const it = parent.getFoldersByName('Snapshots');
  return it.hasNext() ? it.next() : parent.createFolder('Snapshots');
}

// ── one finished session ────────────────────────────────────────
function logSession(body) {
  const user = readToken(body.token);
  if (!user) return { ok: false, error: 'signed-out' };
  const st = findStudent(studentsSheet(), user);
  if (!st) return { ok: false, error: 'signed-out' };
  const cls = findClass(st.v[S.cls]);
  if (!cls) return { ok: false, error: 'class-removed' };
  const s = body.session || {};
  if (!s.id) return { ok: false, error: 'no-session' };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);   // two students finishing at once are written one after the other
  try {
    const ss = classLog(cls);
    const sh = ss.getSheetByName('Sessions') || ss.getSheets()[0];
    // log sheets made before the Gender column existed get it now
    if (String(sh.getRange(1, 4).getValue()) !== 'Gender') { sh.insertColumnAfter(3); sh.getRange(1, 4).setValue('Gender').setFontWeight('bold').setBackground('#E6F2EC'); }
    // the website retries when the connection drops; never write the same session twice
    if (sh.getLastRow() > 1 && sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(s.id).matchEntireCell(true).findNext()) {
      return { ok: true, duplicate: true };
    }
    const name = String(st.v[S.name]);
    let snap = '';
    if (body.snapshot && /^data:image\/jpeg;base64,/.test(body.snapshot)) {
      const bytes = Utilities.base64Decode(body.snapshot.split(',')[1]);
      const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmmss');
      const file = snapshotFolder(cls).createFile(Utilities.newBlob(bytes, 'image/jpeg', stamp + ' ' + name + '.jpg'));
      snap = '=HYPERLINK("' + file.getUrl() + '","View photo")';
    }
    const n = (v) => (typeof v === 'number' && isFinite(v) ? v : '');
    sh.appendRow([
      s.id, name, String(st.v[S.user]), GENDER[genderCode(st.v[S.gender])] || '', cls.name,
      s.loginTime ? new Date(s.loginTime) : '', s.endTime ? new Date(s.endTime) : '', n(s.minutes),
      s.mode === 'hifz' ? 'Hifz test' : 'Mujawwadah (reading)', String(s.level || ''),
      String(s.surahs || ''), String(s.ayahs || ''), n(s.questions), n(s.words),
      n(s.rightFirstPct), String(s.grade || ''), n(s.mistakesTotal), String(s.topMistakes || ''),
      n(s.wrong), n(s.prompts), n(s.hints), n(s.unclear), n(s.wentBack), n(s.lookAways),
      snap, String(s.review || ''),
    ]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ── Alif Ba: garden progress and game results ──────────────────
const GAME_HEADERS = ['Time', 'Student name', 'Username', 'Gender', 'Class', 'Game', 'Lesson', 'Rounds', 'Right first time', 'Accuracy (%)', 'Score', 'Letters to practise', 'Letters known (of 28)', 'Minutes'];

function student(body) {
  const user = readToken(body.token);
  if (!user) return { error: 'signed-out' };
  const sh = studentsSheet();
  const st = findStudent(sh, user);
  if (!st) return { error: 'signed-out' };
  return { sh, st };
}

function getProgress(body) {
  const r = student(body);
  if (r.error) return { ok: false, error: r.error };
  let progress = {};
  try { progress = JSON.parse(String(r.st.v[S.progress] || '{}')); } catch (err) { progress = {}; }
  return { ok: true, progress };
}

function saveProgress(body) {
  const r = student(body);
  if (r.error) return { ok: false, error: r.error };
  const text = JSON.stringify(body.progress || {});
  if (text.length > 40000) return { ok: false, error: 'too-big' };
  r.sh.getRange(r.st.row, S.progress + 1).setValue(text);
  return { ok: true };
}

// One row per game played, in a "Games" tab of the class's session log.
function logGame(body) {
  const r = student(body);
  if (r.error) return { ok: false, error: r.error };
  const cls = findClass(r.st.v[S.cls]);
  if (!cls) return { ok: false, error: 'class-removed' };
  const g = body.game || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = classLog(cls);
    let sh = ss.getSheetByName('Games');
    if (!sh) {
      sh = ss.insertSheet('Games');
      sh.appendRow(GAME_HEADERS);
      sh.getRange(1, 1, 1, GAME_HEADERS.length).setFontWeight('bold').setBackground('#FBE3A6');
      sh.setFrozenRows(1);
      sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
    }
    const n = (v) => (typeof v === 'number' && isFinite(v) ? v : '');
    sh.appendRow([
      new Date(), String(r.st.v[S.name]), String(r.st.v[S.user]), GENDER[genderCode(r.st.v[S.gender])] || '', cls.name,
      String(g.game || ''), String(g.lesson || ''), n(g.rounds), n(g.first), n(g.accuracy), n(g.score),
      String(g.practise || ''), n(g.known), n(g.minutes),
    ]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
