/* =====================================================
   APP DO PAINEL — service worker (registrado em admin-app.js)
   Só cuida de uma coisa: abrir o painel sem internet mostra a página
   "Sem conexão" (admin-offline.html) em vez do erro do iPhone.
   A página do painel, os scripts e os dados da API vêm sempre da rede:
   nada do painel fica guardado no celular.
   Ao mudar este arquivo, troque o ?v= em admin-app.js; ao mudar a página
   de sem conexão, troque também o CACHE abaixo.
===================================================== */
"use strict";
const CACHE = "monte-painel-offline-20261116";
const OFFLINE_PAGE = "/admin-offline.html";
const OFFLINE_FILES = [OFFLINE_PAGE, "/admin-offline.css?v=20261116-app"];

self.addEventListener("install", event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(OFFLINE_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key.startsWith("monte-painel-") && key !== CACHE).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    // Estilo da página de sem conexão: do celular (a página só aparece quando não há rede).
    if (url.origin === self.location.origin && OFFLINE_FILES.includes(url.pathname + url.search) && url.pathname !== OFFLINE_PAGE) {
        event.respondWith(caches.match(url.pathname + url.search).then(hit => hit || fetch(request)));
        return;
    }
    // Abrir o painel: sempre da rede; sem rede, a página de sem conexão.
    if (request.mode === "navigate") {
        event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_PAGE).then(hit => hit || Response.error())));
    }
    // O resto (API, scripts, fotos) segue direto para a rede, sem passar por aqui.
});
