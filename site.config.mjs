// ─────────────────────────────────────────────────────────────
//  The one file to edit. Everything else reads from here.
// ─────────────────────────────────────────────────────────────
export default {
  appName: 'Quran Library',

  // GitHub Pages address. If your repo is named "issahnazif-afk.github.io",
  // set base to '/'. If it is named "quran", keep '/quran/'.
  site: 'https://issahnazif-afk.github.io',
  base: '/Qa-af-Wal-Quran-ul-Majeed/',

  // Translations baked into the site (fetched once at build time from AlQuran.cloud).
  // Edition ids: https://api.alquran.cloud/v1/edition?format=text&type=translation
  translations: [
    { id: 'en.sahih', name: 'Sahih International', lang: 'en', dir: 'ltr' },
  ],
  defaultTranslation: 'en.sahih',

  // Reciters streamed from EveryAyah (folder names on everyayah.com/data/)
  reciters: [
    { id: 'Alafasy_128kbps', name: 'Mishary Rashid Alafasy' },
    { id: 'Husary_128kbps', name: 'Mahmoud Khalil Al-Husary' },
    { id: 'Abdul_Basit_Murattal_192kbps', name: 'Abdul Basit (Murattal)' },
    { id: 'Minshawy_Murattal_128kbps', name: 'Mohamed Siddiq Al-Minshawi (Murattal)' },
  ],
  defaultReciter: 'Alafasy_128kbps',

  // Optional: word-by-word from Quran Foundation (needs QF_CLIENT_ID / QF_CLIENT_SECRET
  // as GitHub Actions secrets). If they are missing, the build simply skips this step.
  quranFoundation: {
    enabled: true,
    tokenUrl: 'https://oauth2.quran.foundation/oauth2/token',
    apiBase: 'https://apis.quran.foundation/content/api/v4',
    wordTranslationLanguage: 'en',
  },
};
