/* =====================================================
   PAINEL COMO APP DO CELULAR
   No iPhone: abrir /admin no Safari → Compartilhar → "Adicionar à Tela de
   Início". O painel ganha o ícone da MONTÊ e abre em tela cheia, como app
   (admin.webmanifest, ícones em assets/app e, no fim do admin.css, as
   margens do relógio, do notch e da barra de início).
   Este arquivo:
   - registra o admin-sw.js, que só mostra "Sem conexão" quando o app abre
     sem internet (nada do painel fica guardado no celular);
   - ao voltar para o app depois de alguns minutos fora dele, confere se o
     login ainda vale (senão mostra a tela de entrar) e atualiza pedidos e
     produtos: no app não existe o botão de recarregar do navegador.
   Usa api(), showLogin(), loadProducts() e loadOrders() do admin.js.
===================================================== */
(function () {
    "use strict";

    if ("serviceWorker" in navigator) {
        window.addEventListener("load", function () {
            navigator.serviceWorker.register("/admin-sw.js?v=20261116-app", { scope: "/admin", updateViaCache: "none" })
                .catch(function (error) { console.warn("App do painel: aviso de sem conexão indisponível.", error); });
        });
    }

    // Fora do app por mais que isto: ao voltar, confere o login e busca os dados de novo.
    var REFRESH_AFTER_MS = 5 * 60 * 1000;
    var hiddenAt = 0;
    var refreshing = false;

    function appVisible() {
        var app = document.getElementById("appView");
        return !!app && !app.classList.contains("hidden");
    }
    // Janela de produto ou pedido aberta: não redesenha nada por baixo dela.
    function modalOpen() {
        return !!document.querySelector(".modal:not(.hidden)");
    }

    async function refreshAfterReturn() {
        if (refreshing || !appVisible() || typeof api !== "function") return;
        refreshing = true;
        try {
            try {
                await api("/api/admin/session");
            } catch (error) {
                // Login vencido (o login do painel vale 8 horas): volta para a tela de entrar.
                if (error && error.status === 401 && typeof showLogin === "function") showLogin();
                return;
            }
            if (modalOpen()) return;
            await Promise.all([
                typeof loadProducts === "function" ? loadProducts() : null,
                typeof loadOrders === "function" ? loadOrders() : null
            ]);
        } catch (error) {
            console.warn("App do painel: não foi possível atualizar ao voltar.", error);
        } finally {
            refreshing = false;
        }
    }

    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") {
            hiddenAt = Date.now();
            return;
        }
        if (hiddenAt && Date.now() - hiddenAt >= REFRESH_AFTER_MS) refreshAfterReturn();
        hiddenAt = 0;
    });
})();
