import { defineConfig } from 'astro/config';
import cfg from './site.config.mjs';

export default defineConfig({
  site: cfg.site,
  base: cfg.base,
  trailingSlash: 'always',
  build: { format: 'directory' },
});
