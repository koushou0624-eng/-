// カイタイ事務：電波がなくても開けるように、画面のファイルをスマホに残しておく
// ・画面のファイル（同じサイトのもの）：まずネットから新しいものを取り、取れなければ残しておいたものを使う
// ・Supabase（データの送受信）や LINE などは通さない（アプリ側で、つながったら送る）
const CACHE = 'kaitai-jimu-v1';
const CORE = ['./', './index.html', './style.css', './core.js', './xlsx.js', './app.js', './cloud.js', './pdf.js', './config.js', './intro.js', './manifest.json',
  './vendor/supabase-2.45.4.js', './icons/icon-192.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const font = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!same && !font) return; // Supabase などはそのまま
  if (same && /\.(mp4|mov)$/i.test(url.pathname)) return; // オープニング動画は残さない（大きいため）
  if (font) { // 文字の形：一度取れたら残したものを使う
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { c.put(req, res.clone()); return res; }))));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});
