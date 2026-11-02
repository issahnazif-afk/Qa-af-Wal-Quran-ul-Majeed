import { defineConfig } from 'astro/config';
import cfg from './site.config.mjs';

export default defineConfig({
  site: cfg.site,
  // the Android / iOS app serves the site from the root of the app bundle
  base: process.env.APP_BUILD ? '/' : cfg.base,
  trailingSlash: 'always',
  build: { format: 'directory' },
});
