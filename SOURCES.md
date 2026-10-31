# Sources and licences

| What | From | Licence | How it is used |
|---|---|---|---|
| Quran text (Uthmani, v1.1) | [Tanzil Project](https://tanzil.net) | CC BY 3.0, verbatim copies only | `sources/tanzil/quran-uthmani.xml`, committed unchanged. The notice is copied into every derived JSON file. |
| Mushaf layout (KFGQPC V2, 604 × 15 lines) | [QUL, Tarteel](https://qul.tarteel.ai) | As published on QUL | `sources/qul/layout-qpc-v2-15.json`. |
| KFGQPC Uthmanic Hafs font | King Fahd Glorious Quran Printing Complex | KFGQPC font licence | `public/fonts/UthmanicHafs_V22.ttf`, as in the main app. |
| Recitations (the Sheikh's voice) | [EveryAyah](https://everyayah.com) | As published by each reciter | Streamed directly; not stored. |
| Word audio (the Sheikh's prompts) | [Quran.com](https://quran.com) word-by-word audio | As published | Streamed directly; not stored. |
| Face Landmarker model and runtime | [Google MediaPipe](https://ai.google.dev/edge/mediapipe) | Apache 2.0 | Runtime from the `@mediapipe/tasks-vision` package; model downloaded at build time. |
| Speech model `qaaf-asr` (optional) | Qa-af Wal Quran-ul-Majeed | As in the main app | Copied from the main app's GitHub release at build time. |
| Logo | Al-Huda Islamic Centre | Belongs to Al-Huda Islamic Centre | `public/logo-*.png`, `icon-192.png`, `apple-touch-icon.png`, `favicon-64.png`. |
