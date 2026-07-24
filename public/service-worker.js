const CACHE_VERSION = 'v1';
const STATIC_CACHE = `soroban-static-${CACHE_VERSION}`;
const API_CACHE = `soroban-api-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `soroban-dynamic-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/static/js/main.js',
  '/static/css/main.css',
];

const API_PATHS = ['/api/v1/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== STATIC_CACHE && name !== API_CACHE && name !== DYNAMIC_CACHE)
          .map((name) => caches.delete(name)),
      );
    }),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('/offline.html').then((offlineResponse) => {
        return fetch(event.request).catch(() => offlineResponse ?? new Response('Offline', { status: 503 }));
      }),
    );
    return;
  }

  if (url.pathname.startsWith('/api/v1/')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (STATIC_ASSETS.includes(url.pathname) || url.pathname.startsWith('/static/')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', message: 'You are offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(DYNAMIC_CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  });
  return cached ?? fetchPromise;
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-queue') {
    event.waitUntil(syncOfflineQueue());
  }
});

async function syncOfflineQueue(): Promise<void> {
  const cache = await caches.open(API_CACHE);
  const requests = await cache.keys();
  for (const request of requests) {
    if (request.method !== 'GET') {
      try {
        const cached = await cache.match(request);
        if (cached) {
          await fetch(request, { method: request.method, body: await cached.text() });
          await cache.delete(request);
        }
      } catch {
        // will retry on next sync
      }
    }
  }
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const notification = event.data.json();
    const options: NotificationOptions = {
      body: notification.body,
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      data: notification.data,
      tag: notification.groupKey,
      requireInteraction: notification.category === 'compliance' || notification.category === 'emergency',
    };
    event.waitUntil(
      self.registration.showNotification(notification.title, options),
    );
  } catch {
    const text = event.data.text();
    event.waitUntil(
      self.registration.showNotification('Soroban Explorer', { body: text }),
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  if (data?.deepLink) {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then((clientList) => {
        for (const client of clientList) {
          if (client.url === '/' && 'focus' in client) {
            client.focus();
            client.postMessage({ type: 'deep-link', url: data.deepLink });
            return;
          }
        }
        if (clients.openWindow) {
          clients.openWindow(data.deepLink);
        }
      }),
    );
  }
});
