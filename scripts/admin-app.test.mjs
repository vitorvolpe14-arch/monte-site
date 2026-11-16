// Testes do painel como app do celular (tela de início do iPhone/Android).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const exists = name => existsSync(new URL("../" + name, import.meta.url));
const pathOf = url => url.split("?")[0].replace(/^\//, "");

// Largura e altura de um PNG (cabeçalho IHDR).
function pngSize(name) {
    const data = readFileSync(new URL("../" + name, import.meta.url));
    assert.equal(data.toString("latin1", 1, 4), "PNG", name + " não é PNG");
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

const manifest = JSON.parse(read("admin.webmanifest"));
const html = read("admin.html");
const head = html.slice(0, html.indexOf("</head>"));
const metaContent = name => (head.match(new RegExp('<meta name="' + name + '" content="([^"]*)"')) || [])[1];

test("manifesto abre o painel em tela cheia, só dentro de /admin", () => {
    assert.equal(manifest.start_url, "/admin");
    assert.equal(manifest.id, "/admin");
    // "/admin" (sem barra no fim) cobre /admin, /admin/ e /admin.html.
    assert.equal(manifest.scope, "/admin");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.lang, "pt-BR");
    assert.ok(manifest.name && manifest.short_name);
    // Nome embaixo do ícone: curto para não ser cortado com "…".
    assert.ok(manifest.short_name.length <= 12, "short_name: " + manifest.short_name);
    assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
    assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
});

test("ícones do manifesto existem com o tamanho declarado", () => {
    const sizes = new Set();
    for (const icon of manifest.icons) {
        assert.equal(icon.type, "image/png");
        assert.ok(exists(pathOf(icon.src)), "falta " + icon.src);
        const [w, h] = pngSize(pathOf(icon.src));
        assert.equal(w + "x" + h, icon.sizes, icon.src);
        sizes.add(icon.sizes + ":" + (icon.purpose || "any"));
    }
    assert.ok(sizes.has("192x192:any") && sizes.has("512x512:any") && sizes.has("512x512:maskable"), [...sizes].join(" "));
});

test("admin.html: manifesto, ícone do iPhone e tela cheia", () => {
    const manifestLink = head.match(/<link rel="manifest" href="([^"]+)">/);
    assert.ok(manifestLink, "falta <link rel=manifest>");
    assert.equal(pathOf(manifestLink[1]), "admin.webmanifest");

    const touchIcon = head.match(/<link rel="apple-touch-icon" href="([^"]+)">/);
    assert.ok(touchIcon, "falta apple-touch-icon");
    assert.deepEqual(pngSize(pathOf(touchIcon[1])), [180, 180]);

    assert.match(metaContent("viewport"), /viewport-fit=cover/);
    assert.equal(metaContent("apple-mobile-web-app-capable"), "yes");
    assert.equal(metaContent("mobile-web-app-capable"), "yes");
    assert.equal(metaContent("apple-mobile-web-app-status-bar-style"), "black-translucent");
    assert.equal(metaContent("apple-mobile-web-app-title"), manifest.short_name);
    assert.match(metaContent("theme-color"), /^#[0-9a-f]{6}$/i);

    const appScript = html.match(/<script src="(admin-app\.js\?v=[^"]+)"><\/script>/);
    assert.ok(appScript, "falta admin-app.js com ?v=");
    // Depois do admin.js: usa api(), showLogin(), loadOrders()...
    assert.ok(html.indexOf(appScript[0]) > html.indexOf('<script src="admin.js?'), "admin-app.js precisa vir depois do admin.js");
});

test("admin-app.js registra o service worker em /admin, sem cache do navegador", () => {
    const source = read("admin-app.js");
    const call = source.match(/serviceWorker\.register\("([^"]+)",\s*\{([^}]*)\}/);
    assert.ok(call, "não achei serviceWorker.register");
    assert.equal(pathOf(call[1]), "admin-sw.js");
    assert.match(call[2], /scope:\s*"\/admin"/);
    assert.match(call[2], /updateViaCache:\s*"none"/);
});

// Service worker rodando num ambiente simulado (self, caches, fetch).
function loadServiceWorker({ online }) {
    const listeners = {};
    const store = new Map();
    const fetched = [];
    const cache = {
        addAll: async urls => { for (const url of urls) store.set(url, "conteúdo de " + url); },
    };
    const context = {
        URL,
        Promise,
        console,
        self: {
            location: new URL("https://loja.test/admin-sw.js?v=1"),
            addEventListener: (type, fn) => { listeners[type] = fn; },
            skipWaiting: async () => {},
            clients: { claim: async () => {} },
        },
        caches: {
            open: async () => cache,
            keys: async () => [...store.keys()].length ? ["monte-painel-antigo", "outro-site"] : [],
            delete: async () => true,
            match: async request => store.get(typeof request === "string" ? request : new URL(request.url).pathname + new URL(request.url).search) || undefined,
        },
        fetch: async request => {
            fetched.push(request.url || request);
            if (!online) throw new TypeError("sem internet");
            return "rede: " + (request.url || request);
        },
        Response: { error: () => "erro" },
    };
    vm.runInNewContext(read("admin-sw.js"), context);
    const dispatch = async (type, data = {}) => {
        const waits = [];
        let response;
        const event = { ...data, waitUntil: p => waits.push(p), respondWith: p => { response = p; } };
        listeners[type](event);
        await Promise.all(waits);
        return { responded: response !== undefined, response: await response };
    };
    return { dispatch, store, fetched };
}
const request = (url, mode = "no-cors", method = "GET") => ({ url: "https://loja.test" + url, mode, method });

test("service worker: guarda só a página de sem conexão, e ela existe", async () => {
    const sw = loadServiceWorker({ online: true });
    await sw.dispatch("install");
    assert.ok(sw.store.size > 0);
    for (const url of sw.store.keys()) {
        assert.ok(url.startsWith("/admin-offline."), "guardou " + url);
        assert.ok(exists(pathOf(url)), "falta " + url);
    }
});

test("service worker: com internet, o painel e a API vêm sempre da rede", async () => {
    const sw = loadServiceWorker({ online: true });
    await sw.dispatch("install");
    const page = await sw.dispatch("fetch", { request: request("/admin", "navigate") });
    assert.equal(page.response, "rede: https://loja.test/admin");
    for (const url of ["/api/admin/orders", "/api/admin/session", "/admin.js?v=1"]) {
        const result = await sw.dispatch("fetch", { request: request(url) });
        assert.equal(result.responded, false, url + " não pode passar pelo service worker");
    }
    const post = await sw.dispatch("fetch", { request: request("/api/admin/login", "cors", "POST") });
    assert.equal(post.responded, false);
});

test("service worker: sem internet, abre a página de sem conexão com o estilo dela", async () => {
    const sw = loadServiceWorker({ online: false });
    await sw.dispatch("install");
    const page = await sw.dispatch("fetch", { request: request("/admin", "navigate") });
    assert.equal(page.response, "conteúdo de /admin-offline.html");
    const offlineHtml = read("admin-offline.html");
    const css = offlineHtml.match(/<link rel="stylesheet" href="([^"]+)">/)[1];
    const style = await sw.dispatch("fetch", { request: request(css, "no-cors") });
    assert.equal(style.response, "conteúdo de " + css);
});

test("página de sem conexão: sem script nem estilo dentro do HTML (CSP)", () => {
    const offlineHtml = read("admin-offline.html");
    assert.doesNotMatch(offlineHtml, /<script|<style|\sstyle=|\son[a-z]+=/i);
    assert.match(offlineHtml, /href="\/admin"/);
    assert.match(offlineHtml, /<meta name="robots" content="noindex, nofollow">/);
});

test("arquivos do app não ficam de fora da publicação", () => {
    const ignored = read(".assetsignore").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    const files = ["admin.webmanifest", "admin-sw.js", "admin-app.js", "admin-offline.html", "admin-offline.css", ...manifest.icons.map(icon => pathOf(icon.src))];
    for (const file of files) {
        for (const rule of ignored) {
            const pattern = new RegExp("^" + rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*/g, "[^/]*") + "$");
            assert.ok(!pattern.test(file), file + " é ignorado por " + rule);
        }
    }
});
