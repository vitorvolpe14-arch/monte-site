// Testes da permissão de estatísticas (script.js): o script da Cloudflare (Web Analytics) só é
// carregado pela loja depois que a visitante permite, como o Google Analytics.
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");

// Texto de uma função do script.js, da palavra "function" até a chave que a fecha.
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start > -1, `não achei ${name} em script.js`);
    let depth = 0;
    for (let i = source.indexOf("{", start); i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`função ${name} sem fim`);
}

const BEACON_CONFIG = '{"version":"2024.11.0","token":"abc","r":1,"spa":2}';

// Página de mentira: só o que as duas funções usam.
function page({ consent, injected = true, readyState = "complete" }) {
    const added = [];
    const listeners = {};
    const injectedTag = { getAttribute: name => (name === "data-cf-beacon" ? BEACON_CONFIG : null) };
    const calls = { store: 0, google: 0 };
    const context = {
        privacyConsent: consent,
        startStoreAnalytics() { calls.store++; },
        loadGoogleAnalytics() { calls.google++; },
        document: {
            readyState,
            querySelector(selector) {
                assert.match(selector, /data-cf-beacon/);
                assert.match(selector, /static\.cloudflareinsights\.com/);
                return injected ? injectedTag : null;
            },
            createElement(tag) {
                const attributes = {};
                return { tag, attributes, setAttribute(name, value) { attributes[name] = value; } };
            },
            head: { appendChild(element) { added.push(element); } },
            addEventListener(type, listener) { listeners[type] = listener; }
        }
    };
    vm.runInNewContext(
        `let cloudflareAnalyticsLoaded = false;\n${functionSource("loadCloudflareAnalytics")}\n${functionSource("applyPrivacyConsent")}\n` +
        "this.applyPrivacyConsent = applyPrivacyConsent;",
        context
    );
    return { added, listeners, calls, apply: () => context.applyPrivacyConsent() };
}

test("sem escolha ou com estatísticas recusadas: nada da Cloudflare é carregado", () => {
    // O lembrete saiu da permissão de cookies: uma escolha antiga com ele, sem estatísticas,
    // também não liga as estatísticas da loja.
    for (const consent of [null, { analytics: false }, { analytics: false, reminders: false }, { analytics: false, reminders: true }]) {
        const p = page({ consent });
        p.apply();
        assert.equal(p.added.length, 0);
        assert.deepEqual(p.listeners, {});
        assert.equal(p.calls.google, 0);
        assert.equal(p.calls.store, 0);
    }
});

test("estatísticas permitidas: carrega o script pelo endereço fixo, com a configuração da Cloudflare", () => {
    const p = page({ consent: { analytics: true, reminders: false } });
    p.apply();
    assert.equal(p.added.length, 1);
    const [script] = p.added;
    assert.equal(script.tag, "script");
    assert.equal(script.src, "https://static.cloudflareinsights.com/beacon.min.js");
    assert.equal(script.attributes["data-cf-beacon"], BEACON_CONFIG);
    assert.equal(p.calls.google, 1);
    // Chamar de novo (por exemplo, ao salvar as preferências) não carrega duas vezes.
    p.apply();
    assert.equal(p.added.length, 1);
});

test("a chamada da Cloudflare vem depois do script.js no HTML: espera a página ser lida", () => {
    const p = page({ consent: { analytics: true, reminders: true }, readyState: "loading" });
    p.apply();
    assert.equal(p.added.length, 0);
    assert.equal(typeof p.listeners.DOMContentLoaded, "function");
    p.listeners.DOMContentLoaded();
    assert.equal(p.added.length, 1);
});

test("Web Analytics desligado na Cloudflare (sem a chamada na página): nada a carregar", () => {
    const p = page({ consent: { analytics: true, reminders: true }, injected: false });
    p.apply();
    assert.equal(p.added.length, 0);
});
