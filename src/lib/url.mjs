// Join a path onto the site base (works for "/" and "/repo-name/").
// In the Android / iOS app build, links to folders point at their index.html, because the
// app's built-in web server only serves files it is asked for by name.
const APP = !!import.meta.env.PUBLIC_APP_BUILD;
export const u = (p = '') => {
  let path = import.meta.env.BASE_URL.replace(/\/?$/, '/') + String(p).replace(/^\//, '');
  if (APP) {
    const m = /^([^?#]*)(.*)$/.exec(path);
    let [head, tail] = [m[1], m[2]];
    if (head.endsWith('/')) head += 'index.html';
    else if (!/\.[a-z0-9]+$/i.test(head.split('/').pop())) head += '/index.html';
    path = head + tail;
  }
  return path;
};
