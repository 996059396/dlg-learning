// DLG 电工学习 —— 离线壳 (X02)
//
// 分层缓存策略（与任务 #93 的 X02 离线分层对齐）：
//  - /assets/*（Vite 哈希文件名，不可变）→ cache-first：命中即回，离线也能加载；
//  - 课程内容 GET /api/courses/*/units/*/lessons/* → network-first + 缓存兜底：
//    在线时总是拉新内容并更新缓存，离线时读缓存。答案键本来就随鉴权请求发到
//    浏览器（SW 缓存与浏览器同源同会话，没有新增暴露面）；
//  - SPA 导航（index.html，未哈希）→ network-first + 缓存兜底：部署后首次在线
//    访问拿到新壳，之后断网也能打开应用；
//  - 其余一切（POST/提交、其他 API、跨域）→ 完全不拦截，走网络。
//
// 提交类的离线处理不在 SW 里做：POST 离线会 fetch 失败，由前端 offlineQueue
// 存 raw answers + client_request_id，联网后重放；服务端按 (user, key) 幂等，
// 重放绝不二次铸币。activate 时清理旧版本缓存，避免部署后壳与资产错配。

const VERSION = '1.0.0';
const SHELL_CACHE = `dlg-shell-${VERSION}`;
const ASSET_CACHE = `dlg-assets-${VERSION}`;
const LESSON_CACHE = `dlg-lessons-${VERSION}`;
const PRECACHE_URLS = ['/', '/offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('dlg-'))
            .filter((k) => ![SHELL_CACHE, ASSET_CACHE, LESSON_CACHE].includes(k))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.status === 200) {
    const copy = res.clone();
    caches.open(cacheName).then((c) => c.put(request, copy));
  }
  return res;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  try {
    const res = await fetch(request);
    if (res && res.status === 200) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy));
    }
    return res;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response('离线不可用', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

// 课程内容 GET —— 恰好 /api/courses/:cid/units/:uid/lessons/:lid（结尾锚定，
// 不会误伤 /complete 子路径；POST 本来也不进这个监听器）。
const LESSON_RE = /^\/api\/courses\/[^/]+\/units\/[^/]+\/lessons\/[^/]+$/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // 提交/变更一律走网络，绝不缓存
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (LESSON_RE.test(url.pathname)) {
    event.respondWith(networkFirst(req, LESSON_CACHE));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, '/offline.html'));
  }
});
