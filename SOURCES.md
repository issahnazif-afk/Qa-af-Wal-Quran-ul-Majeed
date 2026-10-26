# Sources and licences

| Data | Source | Licence | How it is used |
|---|---|---|---|
| Quran text (Uthmani, v1.1) | [Tanzil Project](https://tanzil.net) | CC BY 3.0, verbatim copies only | `sources/tanzil/quran-uthmani.xml`, committed unchanged. The notice is copied into every derived JSON file. |
| Morphology (v0.4) | [Quranic Arabic Corpus](https://corpus.quran.com), Kais Dukes | GNU GPL | `sources/corpus/…-0_4.txt`, committed unchanged. Converted from Buckwalter to Arabic script for display. |
| Translations, page/juz metadata | [AlQuran.cloud](https://alquran.cloud) | As published by each edition | Fetched at build time. |
| Recitations | [EveryAyah](https://everyayah.com) | As published by each reciter | Streamed directly; not stored. |
| Word by word (optional) | [Quran Foundation](https://quran.foundation) | Quran Foundation API terms | Fetched at build time with repository secrets. |
| Mushaf layout (KFGQPC V2, 604 × 15 lines) | [QUL, Tarteel](https://qul.tarteel.ai) | As published on QUL | `sources/qul/qpc-v2-15-lines.db` (original) and `layout-qpc-v2-15.json` (same rows as JSON). |
| Quran font | KFGQPC HAFS Uthmanic Script v2.2 | KFGQPC free end-user licence: use, copy, distribute; no modification | `public/fonts/UthmanicHafs_V22.ttf`, unmodified. |
| Other fonts | Google Fonts: Amiri Quran, IBM Plex | SIL Open Font Licence | Loaded from Google Fonts. |

Do not edit the files in `sources/`. If you find an error, report it to the original project.
