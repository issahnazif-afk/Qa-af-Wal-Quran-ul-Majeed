// The Classroom's activities. The Classroom home shows one card per entry, in this order.
//
// To add an activity later:
//   1. add an entry here,
//   2. if it is a new kind of screen, open it in openActivity() in src/pages/index.astro.
// An entry with  kind: 'soon'  shows as "Coming soon" until it is ready.
//
//   id      unique name
//   kind    'recite' (camera, set-up, the Sheikh listens) | 'alifba' (letters and games) | 'soon'
//   mode    for 'recite': 'hifz' or 'reading'
//   levels  which classes see it (leave out for all)

export const ACTIVITIES = [
  {
    id: 'hifz', kind: 'recite', mode: 'hifz', icon: 'hifz',
    title: 'Hifz test', ar: 'اِخْتِبَارُ ٱلْحِفْظ',
    text: 'The Sheikh recites the opening of an ayah. You carry on from memory until he stops you.',
  },
  {
    id: 'reading', kind: 'recite', mode: 'reading', icon: 'mushaf',
    title: 'Mujawwadah', ar: 'ٱلْمُجَوَّدَة',
    text: 'Read aloud from the mushaf page while the Sheikh follows every word.',
  },
  {
    id: 'alifba', kind: 'alifba', icon: 'lantern',
    title: 'Alif Ba', ar: 'أَلِف بَاء',
    text: 'Learn the Arabic letters and play Noor Lanterns. Grow your Jannah Garden.',
  },
];

export const ICONS = {
  hifz: '<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><path d="M8 14 Q20 10 32 16 Q44 10 56 14 V50 Q44 46 32 52 Q20 46 8 50 Z" fill="#E6F2EC" stroke="#0E6B4E" stroke-width="2.5"/><path d="M32 16 V52" stroke="#0E6B4E" stroke-width="2"/><circle cx="46" cy="22" r="9" fill="#FBE3A6" stroke="#C9A24A" stroke-width="2"/><path d="M42 22 l3 3 5-6" fill="none" stroke="#0E6B4E" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mushaf: '<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><path d="M6 18 Q19 13 32 19 Q45 13 58 18 V52 Q45 47 32 53 Q19 47 6 52 Z" fill="#FFFDF7" stroke="#C9A24A" stroke-width="2.5"/><path d="M32 19 V53" stroke="#C9A24A" stroke-width="2"/><g stroke="#0E6B4E" stroke-width="2" stroke-linecap="round"><path d="M12 26 H26 M12 32 H26 M12 38 H24 M38 26 H52 M38 32 H52 M40 38 H52"/></g><path d="M20 58 L32 50 L44 58" fill="none" stroke="#8A5A12" stroke-width="2.5" stroke-linecap="round"/></svg>',
  lantern: '<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><path d="M32 2 V9" stroke="#C9A24A" stroke-width="2"/><path d="M24 9 H40 L37 15 H27 Z" fill="#C9A24A"/><path d="M26 15 H38 L46 33 L38 52 H26 L18 33 Z" fill="#FBE3A6" stroke="#C9A24A" stroke-width="2.5"/><text x="32" y="40" text-anchor="middle" font-family="KFGQPC Hafs, Amiri, serif" font-size="20" fill="#0F2A24">ب</text><path d="M28 52 H36 L34 58 H30 Z" fill="#C9A24A"/></svg>',
  soon: '<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><circle cx="32" cy="32" r="24" fill="#F7F8F6" stroke="#B9C3BE" stroke-width="2.5"/><path d="M32 20 V33 L40 38" fill="none" stroke="#4F5B56" stroke-width="2.5" stroke-linecap="round"/></svg>',
};

export const forLevel = (level) => ACTIVITIES.filter((a) => !a.levels || a.levels.includes(level));
