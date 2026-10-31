// Alif Ba, Lesson 1: the 28 letters and their names, as in the school's Alif Ba booklet.
import { normalize, similarity } from './recite.mjs';
import { u } from './url.mjs';

// [letter, name with harakat, name in English letters, file name for a recording]
export const LETTERS = [
  ['ا', 'أَلِف', 'Alif', 'alif'], ['ب', 'بَاء', 'Ba', 'ba'], ['ت', 'تَاء', 'Ta', 'ta'], ['ث', 'ثَاء', 'Tha', 'tha'],
  ['ج', 'جِيم', 'Jim', 'jim'], ['ح', 'حَاء', 'Ḥa', 'ha-hollow'], ['خ', 'خَاء', 'Kha', 'kha'], ['د', 'دَال', 'Dal', 'dal'],
  ['ذ', 'ذَال', 'Dhal', 'dhal'], ['ر', 'رَاء', 'Ra', 'ra'], ['ز', 'زَاي', 'Zay', 'zay'], ['س', 'سِين', 'Sin', 'sin'],
  ['ش', 'شِين', 'Shin', 'shin'], ['ص', 'صَاد', 'Ṣad', 'sad'], ['ض', 'ضَاد', 'Ḍad', 'dad'], ['ط', 'طَاء', 'Ṭa', 'ta-heavy'],
  ['ظ', 'ظَاء', 'Ẓa', 'dha-heavy'], ['ع', 'عَيْن', 'ʿAyn', 'ayn'], ['غ', 'غَيْن', 'Ghayn', 'ghayn'], ['ف', 'فَاء', 'Fa', 'fa'],
  ['ق', 'قَاف', 'Qaf', 'qaf'], ['ك', 'كَاف', 'Kaf', 'kaf'], ['ل', 'لَام', 'Lam', 'lam'], ['م', 'مِيم', 'Mim', 'mim'],
  ['ن', 'نُون', 'Nun', 'nun'], ['ه', 'هَاء', 'Ha', 'ha'], ['و', 'وَاو', 'Waw', 'waw'], ['ي', 'يَاء', 'Ya', 'ya'],
].map(([letter, name, latin, file], i) => ({ i, letter, name, latin, file }));

// Letters that look alike (only the dots differ, or the shape is close): the hard choices.
const LOOKALIKE = [['ب', 'ت', 'ث', 'ن', 'ي'], ['ج', 'ح', 'خ'], ['د', 'ذ'], ['ر', 'ز'], ['س', 'ش'], ['ص', 'ض'], ['ط', 'ظ'], ['ع', 'غ'], ['ف', 'ق'], ['ك', 'ل'], ['ه', 'و', 'م']];
export const lookalikes = (letter) => (LOOKALIKE.find((g) => g.includes(letter)) ?? []).filter((x) => x !== letter);
export const byLetter = (l) => LETTERS.find((x) => x.letter === l);

// How the game is set for each class (ages from the school).
export const LEVEL_GAME = {
  1: { lanterns: 3, rounds: 8, timer: 0, similar: false, speak: false, score: false, label: 'Ages 4–6' },
  2: { lanterns: 4, rounds: 10, timer: 0, similar: false, speak: true, score: false, label: 'Ages 7–8' },
  3: { lanterns: 6, rounds: 12, timer: 25, similar: true, speak: true, score: true, label: 'Ages 8–10' },
  4: { lanterns: 8, rounds: 14, timer: 15, similar: true, speak: true, score: true, label: 'Ages 11–16' },
};
export const levelNumber = (className) => Number(/(\d)/.exec(String(className || ''))?.[1]) || 1;

// Did the student say this letter's name? Speech engines write it many ways: «باء», «با», «ب», «الباء».
export function heardLetter(transcript, target) {
  const said = normalize(transcript).split(' ').filter(Boolean);
  const name = normalize(target.name).replace(/\s/g, '');
  const forms = new Set([name, name.replace(/ء$/, ''), name.replace(/ا$/, '') , target.letter]);
  return said.some((w0) => [w0, w0.replace(/^ال/, '')].some((w) => {
    if (forms.has(w)) return true;
    return [...forms].some((f) => f.length >= 3 && similarity(w, f) >= 0.75);
  }));
}

// Mastery: a letter is known once it has been chosen (or said) right, first time, on 2 different rounds.
export const MASTERED = 2;
export function lessonState(progress) {
  const known = LETTERS.filter((l) => (progress?.letters?.[l.letter] ?? 0) >= MASTERED).length;
  const lit = LETTERS.filter((l) => (progress?.letters?.[l.letter] ?? 0) >= 1).length;
  return { known, lit, total: LETTERS.length, grown: known === LETTERS.length, started: lit > 0 || !!progress?.played };
}

// ── voice for letter names ───────────────────────────────────
let recordings = null;
export function hasLetterRecording(file) {
  recordings ??= fetch(u('audio/letters/recordings.json')).then((r) => (r.ok ? r.json() : []), () => []).then((xs) => new Set(xs));
  return recordings.then((s) => s.has(file));
}
export const letterAudioUrl = (file) => u(`audio/letters/${file}.mp3`);
