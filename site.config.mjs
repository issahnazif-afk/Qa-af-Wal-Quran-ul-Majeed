// ─────────────────────────────────────────────────────────────
//  The one file to edit. Everything else reads from here.
// ─────────────────────────────────────────────────────────────
export default {
  appName: "Al-Huda Islamic Weekend School · Ta'aleem Virtual Classroom",

  // GitHub Pages address. The repository is called "AIC-Ta-aleem-Virtual-Classroom".
  // If you name it differently, change base to '/<repository-name>/'.
  site: 'https://issahnazif-afk.github.io',
  base: '/AIC-Ta-aleem-Virtual-Classroom/',

  // The Google Apps Script web app that writes each session into its class's Google Sheet.
  // Paste the "Web app URL" from Deploy → Manage deployments (see apps-script/README.md).
  // It can also be set at build time with the CLASS_LOG_URL environment variable / repository secret.
  classLogUrl: process.env.CLASS_LOG_URL || '',

  // The Sheikh's voice: streamed from EveryAyah (folder names on everyayah.com/data/)
  reciters: [
    { id: 'Husary_128kbps', name: 'Mahmoud Khalil Al-Husary' },
    { id: 'Alafasy_128kbps', name: 'Mishary Rashid Alafasy' },
    { id: 'Minshawy_Murattal_128kbps', name: 'Mohamed Siddiq Al-Minshawi (Murattal)' },
  ],
  defaultReciter: 'Husary_128kbps',

  // The speech model from the main app (GitHub release "qaaf-asr-model" in this repository).
  // The deploy workflow copies it into public/models/ when it is published.
  asrModelRepo: 'issahnazif-afk/Qa-af-Wal-Quran-ul-Majeed',
};
