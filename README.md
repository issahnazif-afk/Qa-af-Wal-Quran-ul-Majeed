# Quran Library

A free, open Quran website: read by surah or by mushaf page, listen ayah by ayah, study word grammar, search, and download the datasets. Built with [Astro](https://astro.build), hosted on GitHub Pages, with no server and no database.

## How it works

1. `scripts/build-data.mjs` reads the committed Tanzil text and Corpus morphology, downloads translations and page metadata from AlQuran.cloud (and, optionally, word-by-word data from the Quran Foundation), checks the text (114 surahs, 6,236 ayahs), and writes small JSON files to `public/data/`.
2. `astro build` renders the home page, 114 surah pages, 604 mushaf pages, and the study, search, saved, resources and about pages into `dist/`.
3. `.github/workflows/deploy.yml` runs both steps on every push to `main` (and once a month) and publishes `dist/` to GitHub Pages.

## Settings

Everything you are likely to change is in `site.config.mjs`: app name, site address, translations and reciters.

If the repository is named `issahnazif-afk.github.io` instead of `quran`, change `base` to `'/'`.

## Run it on your computer

```powershell
npm install
npm run data      # builds public/data (needs internet)
npm run dev       # opens http://localhost:4321/quran/
```

Word by word is skipped locally unless `QF_CLIENT_ID` and `QF_CLIENT_SECRET` are set as environment variables. Never commit them; GitHub Actions reads them from the repository secrets.

## Project layout

```
site.config.mjs            settings
scripts/build-data.mjs     data pipeline
sources/                   original datasets (never edited)
src/pages/                 index, surah/[n], page/[n], ayah, search, saved, resources, about
src/lib/                   shared helpers (audio player, bookmarks, data loading)
public/                    favicon, manifest, offline service worker
.github/workflows/         build and deploy
```

See `SOURCES.md` for attribution and licences.
