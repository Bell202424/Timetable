/*
 * Service Worker: アプリ本体をキャッシュしてオフラインでも起動できるようにする。
 * ファイルを更新したら CACHE_VERSION を上げること(古いキャッシュは activate 時に削除される)。
 */
const CACHE_VERSION = 'v5';
const CACHE_NAME = 'timetable-' + CACHE_VERSION;
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_FILES);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) {
        return name.startsWith('timetable-') && name !== CACHE_NAME;
      }).map(function (name) {
        return caches.delete(name);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// キャッシュ優先。無ければネットワークから取得する
self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(function (cached) {
      if (cached) {
        return cached;
      }
      return fetch(request).catch(function (err) {
        // オフラインで画面遷移した場合はアプリ本体を返す
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        throw err;
      });
    })
  );
});
