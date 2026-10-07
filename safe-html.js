/* =====================================================
   HTML SEGURO E AÇÕES DOS BOTÕES — usado pela loja e pelo painel.

   1) setHTML / appendHTML: montam HTML na página sem innerHTML.
      O texto vira um documento inerte (DOMParser não executa nada),
      perde scripts, iframes, atributos de evento (onclick...) e links
      javascript:, e só então entra na página. Os valores continuam
      sendo escapados em cada lugar; isto é a segunda barreira.

   2) data-click: a CSP do site não aceita JavaScript dentro do HTML
      (onclick="..."). Os botões dizem a ação em data-click e os
      argumentos em data-args (JSON); cada página registra as ações
      que podem ser chamadas com registerClickActions({...}).
      data-event acrescenta o evento do clique como último argumento.

   3) data-img-error="hide" | "dim": o que fazer com uma imagem que
      não carregou (substitui o onerror="...").
===================================================== */
(function () {
    "use strict";

    const BLOCKED = "script,iframe,frame,frameset,object,embed,base,meta,link,noscript";
    const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "xlink:href", "background"]);
    const SAFE_SCHEMES = new Set(["http", "https", "mailto", "tel", "blob"]);
    // Linhas e células de tabela só existem dentro de uma tabela: o HTML é lido no mesmo contexto.
    const WRAPPERS = {
        TABLE: ["<table>", "</table>", 1],
        THEAD: ["<table><thead>", "</thead></table>", 2],
        TBODY: ["<table><tbody>", "</tbody></table>", 2],
        TFOOT: ["<table><tfoot>", "</tfoot></table>", 2],
        TR: ["<table><tbody><tr>", "</tr></tbody></table>", 3],
        COLGROUP: ["<table><colgroup>", "</colgroup></table>", 2]
    };

    function safeUrl(value) {
        const text = String(value || "").trim().replace(/[\u0000-\u001F\u007F\s]+/g, "");
        const scheme = text.match(/^([a-z][a-z0-9+.-]*):/i);
        if (!scheme) return true;
        const name = scheme[1].toLowerCase();
        if (SAFE_SCHEMES.has(name)) return true;
        return name === "data" && /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(text);
    }

    function clean(root) {
        root.querySelectorAll(BLOCKED).forEach(node => node.remove());
        root.querySelectorAll("*").forEach(element => {
            for (const attribute of Array.from(element.attributes)) {
                const name = attribute.name.toLowerCase();
                if (name.startsWith("on") || name === "srcdoc") element.removeAttribute(attribute.name);
                else if (URL_ATTRIBUTES.has(name) && !safeUrl(attribute.value)) element.removeAttribute(attribute.name);
            }
        });
    }

    function htmlFragment(html, target) {
        const [open, close, depth] = WRAPPERS[target && target.tagName] || ["", "", 0];
        const doc = new DOMParser().parseFromString("<!doctype html><body>" + open + String(html == null ? "" : html) + close, "text/html");
        let root = doc.body;
        for (let i = 0; i < depth && root.firstElementChild; i++) root = root.firstElementChild;
        clean(root);
        const fragment = document.createDocumentFragment();
        while (root.firstChild) fragment.appendChild(document.adoptNode(root.firstChild));
        return fragment;
    }

    function setHTML(element, html) {
        if (element) element.replaceChildren(htmlFragment(html, element));
    }

    function appendHTML(element, html) {
        if (element) element.append(htmlFragment(html, element));
    }

    const clickActions = Object.create(null);
    function registerClickActions(actions) {
        Object.keys(actions || {}).forEach(name => {
            if (typeof actions[name] === "function") clickActions[name] = actions[name];
        });
    }

    document.addEventListener("click", event => {
        const element = event.target instanceof Element ? event.target.closest("[data-click]") : null;
        if (!element) return;
        const action = clickActions[element.dataset.click];
        if (!action) return;
        let args = [];
        if (element.dataset.args) {
            try { args = JSON.parse(element.dataset.args); } catch { args = []; }
            if (!Array.isArray(args)) args = [args];
        }
        if ("event" in element.dataset) args.push(event);
        action.apply(element, args);
    });

    // Erros de imagem não sobem pela página: escuta na fase de captura.
    document.addEventListener("error", event => {
        const image = event.target;
        if (!(image instanceof HTMLImageElement) || !image.dataset.imgError) return;
        if (image.dataset.imgError === "hide") image.style.visibility = "hidden";
        else if (image.dataset.imgError === "dim") image.style.opacity = "0.2";
    }, true);

    window.setHTML = setHTML;
    window.appendHTML = appendHTML;
    window.htmlFragment = htmlFragment;
    window.registerClickActions = registerClickActions;
})();
