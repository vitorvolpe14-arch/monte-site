/* =====================================================
   NOTIFICAÇÕES NO CELULAR — sino do menu do painel
   Venda nova, pagamento pendente há 30 minutos e alerta de segurança
   chegam como notificação no aparelho (servidor: backend/web-push.js).
   - iPhone: só no painel instalado na Tela de Início (iOS 16.4 ou mais
     novo), aberto pelo ícone. No Safari comum, o sino explica como instalar.
   - Ativar pede a permissão do aparelho (precisa do toque no botão) e
     guarda a assinatura no servidor com os avisos escolhidos.
   - Ao entrar no painel, um aparelho já ativado confere a assinatura com o
     servidor (sem perguntar nada).
   - Tocar na notificação abre o pedido (admin-sw.js manda "monte-open" ou
     abre /admin#pedido=<id>).
   - O número de pedidos para separar e enviar (menu Pedidos) aparece no
     ícone do app.
   Usa api(), orders, loadOrders(), showSection() e openOrder() do admin.js.
===================================================== */
(function () {
    "use strict";

    var el = function (id) { return document.getElementById(id); };
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var installed = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
    var supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    var publicKey = null;
    var current = null; // assinatura deste aparelho, quando ativa

    function b64urlToBytes(text) {
        var b64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
        b64 += "===".slice((b64.length + 3) % 4);
        var raw = atob(b64), out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }
    function bytesToB64url(buffer) {
        var bytes = new Uint8Array(buffer || []), text = "";
        for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
        return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function post(path, body) { return api(path, { method: "POST", body: JSON.stringify(body || {}) }); }
    function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
    function appVisible() { var app = el("appView"); return !!app && !app.classList.contains("hidden"); }

    // Service worker do painel (admin-app.js registra). Sem ele em 8 s, desiste.
    function registration() {
        if (!("serviceWorker" in navigator)) return Promise.resolve(null);
        return Promise.race([navigator.serviceWorker.ready, wait(8000).then(function () { return null; })]);
    }
    async function storeKey() {
        if (!publicKey) publicKey = (await api("/api/admin/push/key")).publicKey;
        return publicKey;
    }
    // Assinatura do aparelho com a chave atual da loja (se a chave mudou, assina de novo).
    async function subscription(reg, create) {
        var key = await storeKey();
        var sub = await reg.pushManager.getSubscription();
        if (sub && sub.options && sub.options.applicationServerKey && bytesToB64url(sub.options.applicationServerKey) !== key) {
            await sub.unsubscribe().catch(function () {});
            sub = null;
            create = true;
        }
        if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
        return sub;
    }

    /* ---------- Janela do sino ---------- */
    function topicBoxes() { return Array.prototype.slice.call(document.querySelectorAll("#pushTopics input[type=checkbox]")); }
    function chosenTopics() { return topicBoxes().filter(function (box) { return box.checked; }).map(function (box) { return box.value; }); }
    function say(text) { var box = el("pushMessage"); if (box) box.textContent = text || ""; }

    // state: checking | install | unsupported | blocked | off | on
    function render(state, topics) {
        var stateBox = el("pushState");
        var texts = {
            checking: "Conferindo este aparelho…",
            install: "Para receber notificações, instale o painel como app.",
            unsupported: ios
                ? "Este iPhone ainda não recebe notificações de app da tela de início. Atualize para o iOS 16.4 ou mais novo."
                : "Este navegador não recebe notificações. Use o painel instalado no celular ou o Chrome, o Safari ou o Edge atualizados.",
            blocked: "As notificações estão bloqueadas neste aparelho.",
            off: "Escolha os avisos e toque em Ativar. O aparelho vai pedir permissão.",
            on: "Notificações ativas neste aparelho."
        };
        stateBox.textContent = texts[state] || "";
        stateBox.classList.toggle("is-on", state === "on");
        el("pushInstall").hidden = state !== "install";
        el("pushBlocked").hidden = state !== "blocked";
        // O texto do admin.html é o do iPhone; no computador ou no Android, a permissão fica no navegador.
        if (state === "blocked" && !ios) el("pushBlocked").textContent = "Para liberar: toque ou clique no cadeado ao lado do endereço do site, permita as notificações e volte aqui.";
        el("pushTopics").hidden = !(state === "off" || state === "on");
        el("pushEnable").hidden = state !== "off";
        el("pushTest").hidden = state !== "on";
        el("pushDisable").hidden = state !== "on";
        if (Array.isArray(topics)) topicBoxes().forEach(function (box) { box.checked = topics.indexOf(box.value) > -1; });
        var bell = el("pushButton");
        if (bell) bell.classList.toggle("is-on", state === "on");
    }

    async function refresh() {
        say("");
        if (!supported) return render(ios && !installed ? "install" : "unsupported");
        if (Notification.permission === "denied") return render("blocked");
        render("checking");
        try {
            var reg = await registration();
            if (!reg) return render("unsupported");
            storeKey().catch(function () {}); // já busca a chave: o toque em Ativar não espera a rede
            var sub = Notification.permission === "granted" ? await reg.pushManager.getSubscription() : null;
            if (!sub) { current = null; return render("off"); }
            var status = await post("/api/admin/push/status", { endpoint: sub.endpoint });
            current = status.subscribed ? sub : null;
            render(status.subscribed ? "on" : "off", status.topics);
        } catch (error) {
            render("off");
            say(error.message);
        }
    }

    function setBusy(button, busy, label) {
        if (!button) return;
        if (busy) { button.dataset.label = button.textContent; button.textContent = label; }
        else if (button.dataset.label) button.textContent = button.dataset.label;
        button.disabled = busy;
    }

    async function enable() {
        var button = el("pushEnable");
        if (!chosenTopics().length) { say("Marque pelo menos um aviso."); return; }
        setBusy(button, true, "ATIVANDO...");
        say("");
        try {
            // A permissão primeiro, ainda dentro do toque (o iPhone exige).
            var permission = await Notification.requestPermission();
            if (permission !== "granted") {
                render(permission === "denied" ? "blocked" : "off");
                if (permission !== "denied") say("Sem permissão, as notificações não chegam. Toque em Ativar de novo e escolha Permitir.");
                return;
            }
            var reg = await registration();
            if (!reg) throw new Error("O app do painel não terminou de carregar. Feche e abra de novo.");
            var sub = await subscription(reg, true);
            var saved = await post("/api/admin/push/subscribe", { subscription: sub.toJSON(), topics: chosenTopics() });
            current = sub;
            render("on", saved.topics);
            say("Pronto! Toque em Enviar teste para ver como chega.");
            updateAppBadge();
        } catch (error) {
            say(error.message || "Não foi possível ativar as notificações.");
        } finally {
            setBusy(button, false);
        }
    }

    async function saveTopics() {
        if (!current) return;
        if (!chosenTopics().length) { say("Marque pelo menos um aviso (ou desative as notificações)."); return; }
        try {
            await post("/api/admin/push/subscribe", { subscription: current.toJSON(), topics: chosenTopics() });
            say("Avisos salvos.");
        } catch (error) { say(error.message); }
    }

    async function test() {
        var button = el("pushTest");
        if (!current) return;
        setBusy(button, true, "ENVIANDO...");
        try {
            await post("/api/admin/push/test", { endpoint: current.endpoint });
            say("Enviada! Chega em alguns segundos.");
        } catch (error) {
            say(error.message);
        } finally {
            setBusy(button, false);
        }
    }

    async function disable() {
        var button = el("pushDisable");
        if (!current) return;
        setBusy(button, true, "DESATIVANDO...");
        try {
            var endpoint = current.endpoint;
            await current.unsubscribe().catch(function () {});
            await post("/api/admin/push/unsubscribe", { endpoint: endpoint });
            current = null;
            render("off");
            say("Notificações desativadas neste aparelho.");
        } catch (error) {
            say(error.message);
        } finally {
            setBusy(button, false);
        }
    }

    function openModal() { el("pushModal").classList.remove("hidden"); refresh(); }
    function closeModal() { el("pushModal").classList.add("hidden"); }

    /* ---------- Ao entrar: confere a assinatura deste aparelho ---------- */
    var synced = false;
    async function syncSilently() {
        if (synced || !supported || Notification.permission !== "granted") return;
        synced = true;
        try {
            var reg = await registration();
            var sub = reg && await subscription(reg, false);
            if (!sub) return; // nunca ativado (ou desativado) aqui
            // Sem "topics": o servidor mantém os avisos escolhidos antes.
            await post("/api/admin/push/subscribe", { subscription: sub.toJSON() });
            current = sub;
            var bell = el("pushButton");
            if (bell) bell.classList.add("is-on");
        } catch (error) {
            console.warn("Notificações: não foi possível conferir este aparelho.", error);
        }
    }

    /* ---------- Número no ícone do app ---------- */
    function updateAppBadge() {
        if (!("setAppBadge" in navigator)) return;
        var badge = el("navOrdersBadge");
        if (!badge) return;
        var count = badge.hidden ? 0 : parseInt(badge.textContent, 10) || 0;
        (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(function () {});
    }

    /* ---------- Toque na notificação: abre o pedido ---------- */
    function orderIdFrom(url) {
        var match = /#pedido=([^&]+)/.exec(String(url || ""));
        return match ? decodeURIComponent(match[1]) : null;
    }
    function hasOrder(id) {
        return typeof orders !== "undefined" && Array.isArray(orders) && orders.some(function (o) { return String(o.id) === String(id); });
    }
    function showOrder(id) {
        closeModal();
        if (typeof showSection === "function") showSection("orders");
        if (typeof openOrder === "function") openOrder(id);
    }
    // Espera o painel abrir (pode estar na tela de entrar) e os pedidos carregarem.
    async function openOrderFromNotification(id, reload) {
        for (var i = 0; i < 600 && !appVisible(); i++) await wait(500);
        if (!appVisible()) return;
        if (reload && typeof loadOrders === "function") await loadOrders().catch(function () {});
        for (var j = 0; j < 20 && !hasOrder(id); j++) await wait(500);
        if (!hasOrder(id) && typeof loadOrders === "function") await loadOrders().catch(function () {});
        if (hasOrder(id)) showOrder(id);
    }

    document.addEventListener("DOMContentLoaded", function () {
        var bell = el("pushButton");
        if (bell) bell.addEventListener("click", openModal);
        el("closePushModal").addEventListener("click", closeModal);
        el("pushModal").addEventListener("click", function (event) { if (event.target === el("pushModal")) closeModal(); });
        document.addEventListener("keydown", function (event) { if (event.key === "Escape" && !el("pushModal").classList.contains("hidden")) closeModal(); });
        el("pushEnable").addEventListener("click", enable);
        el("pushTest").addEventListener("click", test);
        el("pushDisable").addEventListener("click", disable);
        topicBoxes().forEach(function (box) { box.addEventListener("change", saveTopics); });

        // Painel aberto (depois do login): confere a assinatura uma vez.
        var app = el("appView");
        if (app) {
            new MutationObserver(function () { if (appVisible()) syncSilently(); }).observe(app, { attributes: true, attributeFilter: ["class"] });
            if (appVisible()) syncSilently();
        }

        var badge = el("navOrdersBadge");
        if (badge) new MutationObserver(updateAppBadge).observe(badge, { attributes: true, attributeFilter: ["hidden"], childList: true, characterData: true, subtree: true });

        // Aberto pelo toque numa notificação (app estava fechado).
        var id = orderIdFrom(location.hash);
        if (id) {
            history.replaceState(null, "", location.pathname + location.search);
            openOrderFromNotification(id, false);
        }
        // App já aberto: o service worker pede para abrir o pedido.
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.addEventListener("message", function (event) {
                var data = event.data || {};
                if (data.type !== "monte-open") return;
                var orderId = orderIdFrom(data.url);
                if (orderId) openOrderFromNotification(orderId, true);
            });
        }
    });
})();
