// ============================================================
// Sartec CRM — Service Worker (app shell / assets estáticos)
//
// Este CRM NUNCA deve mostrar dado de atendimento desatualizado.
// Por isso o /api/* inteiro é intocado aqui: nenhuma requisição para
// /api/(qualquer coisa) passa por cache — nem fila, nem conversas,
// nem contatos, nem envio, nem templates, nem autenticação. Essas
// requisições sequer entram em respondWith(); seguem 100% rede, como
// se este Service Worker não existisse.
//
// O que este SW cuida: o "app shell" (index.html/login.html) e os
// assets estáticos necessários pra instalação/PWA (manifest, ícones,
// logos). HTML shell usa network-first — só cai pro cache se a rede
// falhar de verdade (offline), nunca serve HTML velho com a rede
// disponível. Assets estáticos usam stale-while-revalidate.
// ============================================================

const CACHE_VERSION = "sartec-crm-shell-v1";

const SHELL_PATHS = [
  "/painel/index.html",
  "/painel/login.html",
];

const STATIC_ASSETS = [
  "/painel/manifest.json",
  "/painel/assets/icons/icon-192.png",
  "/painel/assets/icons/icon-512.png",
  "/painel/assets/icons/icon-maskable-192.png",
  "/painel/assets/icons/icon-maskable-512.png",
  "/painel/assets/icons/apple-touch-icon.png",
  "/painel/assets/icons/favicon-32.png",
  "/painel/assets/icons/favicon-16.png",
  "/painel/assets/logo-sartec-header.png",
  "/painel/assets/logo-sartec-oficial.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

function isShellRequest(url) {
  return (
    SHELL_PATHS.includes(url.pathname) ||
    url.pathname === "/painel" ||
    url.pathname === "/painel/"
  );
}

function isStaticPainelAsset(url) {
  return url.pathname.startsWith("/painel/") && !isShellRequest(url);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // nunca intercepta R2/terceiros
  if (isApiRequest(url)) return; // /api/* — sempre rede, nunca cache

  if (isShellRequest(url)) {
    // Network-first: HTML velho só aparece se a rede realmente falhar.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  if (isStaticPainelAsset(url)) {
    // Stale-while-revalidate: responde rápido do cache, atualiza em segundo plano.
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetchPromise = fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
