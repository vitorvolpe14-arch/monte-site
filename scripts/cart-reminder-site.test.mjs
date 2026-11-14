// Testes do lembrete da sacola por e-mail no site (script.js e index.html): sem cookies, com o
// mínimo de dados e com o "Não quero" nos dados do checkout.
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

// Texto de uma função do script.js, da palavra "function" até a chave que a fecha. Pula os
// parâmetros antes (eles podem ter chaves, como em ({ items, phone })).
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start > -1, `não achei ${name} em script.js`);
    let paren = 0, close = -1;
    for (let i = source.indexOf("(", start); i < source.length; i++) {
        if (source[i] === "(") paren++;
        else if (source[i] === ")" && --paren === 0) { close = i; break; }
    }
    let depth = 0;
    for (let i = source.indexOf("{", close); i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`função ${name} sem fim`);
}

const context = {};
vm.runInNewContext(functionSource("cartSnapshotPayload") + "\nthis.cartSnapshotPayload = cartSnapshotPayload;", context);
const payload = input => context.cartSnapshotPayload(input);
const ITEMS = [{ id: "bag-1", name: "Bag Vienna", sku: "BV", price: 259, quantity: 2, variant_color: "Preta" }];
const EMAIL = "Ana@Exemplo.com";

test("sem as estatísticas e sem e-mail: nada sai do aparelho", () => {
    assert.equal(payload({ items: ITEMS, analytics: null, optedOut: false, name: "Ana", email: "", key: "k" }), null);
    assert.equal(payload({ items: ITEMS, analytics: null, optedOut: false, name: "Ana", email: "ana@exemplo", key: "k" }), null, "e-mail pela metade não vale");
    assert.equal(payload({ items: ITEMS, analytics: null, optedOut: false, name: "Ana", email: "ana@", key: "k" }), null);
});

test("sem as estatísticas, com o e-mail: vai só a chave da sacola, as peças, o nome e o e-mail", () => {
    const p = payload({ items: ITEMS, shipping: 20, analytics: null, optedOut: false, name: "  Ana ", email: EMAIL, key: "k-1" });
    assert.deepEqual(Object.keys(p).sort(), ["cart_key", "customer_email", "customer_name", "items", "shipping", "subtotal", "total"]);
    assert.equal(p.cart_key, "k-1");
    assert.equal(p.customer_name, "Ana");
    assert.equal(p.customer_email, "ana@exemplo.com");
    assert.equal(p.subtotal, 518);
    assert.equal(p.total, 538);
    assert.equal(p.items[0].product_name, "Bag Vienna");
    assert.equal(p.items[0].total_price, 518);
    assert.ok(!("visitor_id" in p) && !("session_id" in p), "sem código de visitante");
    assert.ok(!("customer_phone" in p), "sem WhatsApp");
});

test("\"Não quero\": sem as estatísticas, nada sai; com elas, a sacola vai sem nome e e-mail", () => {
    assert.equal(payload({ items: ITEMS, analytics: null, optedOut: true, name: "Ana", email: EMAIL, key: "k" }), null);
    const p = payload({ items: ITEMS, analytics: { visitor_id: "v", session_id: "s" }, optedOut: true, name: "Ana", email: EMAIL, key: "s" });
    assert.equal(p.customer_name, "");
    assert.equal(p.customer_email, "");
    assert.equal(p.visitor_id, "v");
});

test("com as estatísticas: a sacola vai mesmo sem e-mail, com o código de visitante", () => {
    const p = payload({ items: ITEMS, analytics: { visitor_id: "v", session_id: "s" }, optedOut: false, name: "Ana", email: "", key: "s" });
    assert.equal(p.visitor_id, "v");
    assert.equal(p.session_id, "s");
    assert.equal(p.customer_name, "", "nome sem e-mail não vai");
});

test("sacola vazia: nada a mandar", () => {
    assert.equal(payload({ items: [], analytics: { visitor_id: "v", session_id: "s" }, optedOut: false, email: EMAIL, key: "k" }), null);
    assert.equal(payload({ items: null, analytics: null, optedOut: false, email: EMAIL, key: "k" }), null);
});

test("o lembrete não depende mais da permissão de cookies", () => {
    assert.ok(!html.includes('id="consentReminders"'), "a opção do lembrete saiu do aviso de cookies");
    assert.ok(!/reminders/.test(source), "o script não lê mais a permissão do lembrete");
    const notice = html.match(/<p class="cookie-consent-text">([\s\S]*?)<\/p>/)[1];
    assert.ok(!/lembrete/i.test(notice), "o aviso de cookies não fala mais do lembrete");
});

test("o checkout avisa do e-mail do lembrete e oferece \"Não quero\" na etapa de dados", () => {
    const emailField = html.indexOf('id="customerEmail"');
    const note = html.indexOf('id="cartContactNote"');
    const nextStep = html.indexOf('id="stepDelivery"');
    assert.ok(emailField > -1 && note > emailField && note < nextStep, "o aviso fica na etapa de dados, depois do e-mail");
    const block = html.slice(note, html.indexOf("</p>", note));
    assert.match(block, /e-mail uma vez/);
    assert.ok(!/WhatsApp/.test(block), "o lembrete não é pelo WhatsApp");
    assert.match(block, /data-click="toggleCartContact"/);
    assert.match(block, /Não quero/);
    assert.match(block, /politica-privacidade\.html#lembrete/);
    assert.match(source, /registerClickActions\(\{[\s\S]*toggleCartContact[\s\S]*\}\);/);
});

test("o código da sacola sem as estatísticas fica só na memória da página", () => {
    const save = functionSource("saveCartSnapshot");
    assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(save));
    const forget = functionSource("forgetCartContact");
    assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(forget));
});
