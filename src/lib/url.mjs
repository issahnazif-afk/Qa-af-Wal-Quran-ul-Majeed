// Join a path onto the site base (works for "/" and "/quran/").
export const u = (p = '') => import.meta.env.BASE_URL.replace(/\/?$/, '/') + String(p).replace(/^\//, '');
