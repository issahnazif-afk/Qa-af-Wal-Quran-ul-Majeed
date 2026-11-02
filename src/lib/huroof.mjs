// Arabic letters and their makharij, from the Huroof project (MIT, © 2025 Abdalrahman Alhamod).
import ar from '../data/huroof/letters_ar.json';
import en from '../data/huroof/letters_en.json';

// The two files list the 28 letters in the same (alphabetical) order.
export const letters = ar.map((a, i) => {
  const e = en[i] ?? {};
  const slug = (e.key || a.key || `l${i}`).toLowerCase();
  return {
    slug, letter: a.letter, nameAr: a.name, nameEn: e.name ?? '', say: a.pronunciation,
    descAr: a.description, descEn: e.description ?? '',
    makhrajAr: a.makhraj_description, makhrajEn: e.makhraj_description ?? '',
    forms: a.forms ?? {},
    syllables: (a.syllables ?? []).map((s, k) => ({ text: s.text, nameAr: s.name, nameEn: e.syllables?.[k]?.name ?? '', hintAr: s.recording_hint, hintEn: e.syllables?.[k]?.recording_hint ?? '' })),
  };
});
