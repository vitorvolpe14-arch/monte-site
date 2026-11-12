/* =====================================================
   TEMA DO PAINEL — escuro por padrão.
   Carregado no <head> (antes de desenhar a página), para não piscar
   branco. O botão "Tema claro / Tema escuro" do menu troca o tema e a
   escolha fica guardada neste navegador.
===================================================== */
(function () {
    "use strict";
    var KEY = "monteAdminTheme";
    function saved() {
        try { return localStorage.getItem(KEY) === "light" ? "light" : "dark"; } catch (e) { return "dark"; }
    }
    function apply(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        var button = document.getElementById("themeToggle");
        if (!button) return;
        var dark = theme === "dark", label = dark ? "Tema claro" : "Tema escuro";
        button.setAttribute("aria-label", dark ? "Mudar para o tema claro" : "Mudar para o tema escuro");
        button.title = label;
        var text = button.querySelector(".theme-label");
        if (text) text.textContent = label;
    }
    apply(saved());
    document.addEventListener("DOMContentLoaded", function () {
        apply(saved());
        var button = document.getElementById("themeToggle");
        if (!button) return;
        button.addEventListener("click", function () {
            var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
            try { localStorage.setItem(KEY, next); } catch (e) { /* sem guardar: vale até fechar a página */ }
            apply(next);
        });
    });
})();
