/* =====================================================
   APP DO PAINEL — service worker (registrado em admin-app.js)
   - Abrir o painel sem internet mostra a página "Sem conexão"
     (admin-offline.html) em vez do erro do iPhone. A página do painel, os
     scripts e os dados da API vêm sempre da rede: nada do painel fica
     guardado no celular.
   - Notificações (venda nova, pagamento pendente, segurança): mostra a
     mensagem que o servidor mandou (backend/web-push.js) e, no toque, abre
     o pedido no painel ou a conversa com a cliente no WhatsApp.
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

/* ---------- Notificações ---------- */
const ICON = "/assets/app/admin-icon-192.png";

self.addEventListener("push", event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (error) { data = { body: event.data ? event.data.text() : "" }; }
    const tasks = [self.registration.showNotification(data.title || "MONTÊ", {
        body: data.body || "",
        icon: ICON,
        tag: data.tag || undefined,
        data: { url: data.url || "/admin", fallbackUrl: data.fallbackUrl || "/admin" }
    })];
    // Número no ícone do app: pedidos para separar e enviar.
    if (typeof data.badge === "number" && self.navigator && self.navigator.setAppBadge) {
        tasks.push((data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {}));
    }
    event.waitUntil(Promise.all(tasks));
});

self.addEventListener("notificationclick", event => {
    event.notification.close();
    event.waitUntil(openFromNotification(event.notification.data || {}));
});

async function openFromNotification({ url = "/admin", fallbackUrl = "/admin" }) {
    const target = new URL(url, self.location.origin);
    if (target.origin !== self.location.origin) {
        // Conversa no WhatsApp: se o aparelho não deixar abrir daqui, abre o pedido no painel.
        try { await self.clients.openWindow(target.href); return; } catch (error) { /* segue para o painel */ }
        return openFromNotification({ url: fallbackUrl });
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const panel = windows.find(client => new URL(client.url).pathname.startsWith("/admin"));
    if (panel) {
        // Painel já aberto: traz para a frente e pede para abrir o pedido (admin-push.js).
        await panel.focus().catch(() => {});
        panel.postMessage({ type: "monte-open", url: target.pathname + target.hash });
        return;
    }
    return self.clients.openWindow(target.href);
}
