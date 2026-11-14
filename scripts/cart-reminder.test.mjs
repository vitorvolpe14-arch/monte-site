// Testes do lembrete da sacola sem cookies (backend/cart-reminder.js).
// Base legal: legítimo interesse (docs/teste-legitimo-interesse-lembrete-sacola.md).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const R = require("../backend/cart-reminder.js");

const ITEMS = [{ id: "bag-1", name: "Bag Vienna", quantity: 1, price: 259 }];

test("celular: só aceita celular com DDD (com ou sem +55)", () => {
    assert.equal(R.brazilMobileDigits("(85) 99999-1234"), "85999991234");
    assert.equal(R.brazilMobileDigits("+55 85 99999-1234"), "85999991234");
    assert.equal(R.brazilMobileDigits("(85) 3333-1234"), "", "telefone fixo não serve para o WhatsApp");
    assert.equal(R.brazilMobileDigits("8599999"), "");
    assert.equal(R.brazilMobileDigits(null), "");
    assert.equal(R.formatBrazilMobile("85999991234"), "(85) 99999-1234");
});

test("sem as estatísticas e com o WhatsApp digitado: guarda a sacola para o lembrete, sem código de visitante", () => {
    const plan = R.cartSnapshotPlan({ cart_key: "k-1", items: ITEMS, customer_name: "  Ana Souza ", customer_phone: "85 99999-1234" });
    assert.equal(plan.action, "save");
    assert.equal(plan.cartKey, "k-1");
    assert.equal(plan.visitorId, null);
    assert.equal(plan.analyticsSession, "");
    assert.deepEqual(plan.contact, { customer_name: "Ana Souza", customer_phone: "(85) 99999-1234", customer_email: null });
});

test("sem as estatísticas e sem celular válido: nada fica guardado (e o que havia com esse código sai)", () => {
    for (const phone of ["", "(85) 3333-1234", undefined]) {
        const plan = R.cartSnapshotPlan({ cart_key: "k-2", items: ITEMS, customer_name: "Ana", customer_phone: phone });
        assert.deepEqual(plan, { action: "forget", cartKey: "k-2" });
    }
});

test("o e-mail nunca é guardado: o lembrete é só pelo WhatsApp", () => {
    const withConsent = R.cartSnapshotPlan({ visitor_id: "v", session_id: "s", items: ITEMS, customer_email: "a@b.com", customer_phone: "85999991234" });
    assert.equal(withConsent.contact.customer_email, null);
    const without = R.cartSnapshotPlan({ cart_key: "k", items: ITEMS, customer_email: "a@b.com", customer_phone: "85999991234" });
    assert.equal(without.contact.customer_email, null);
});

test("nome sem celular não é guardado, nem com as estatísticas", () => {
    const plan = R.cartSnapshotPlan({ visitor_id: "v", session_id: "s", items: ITEMS, customer_name: "Ana", customer_phone: "" });
    assert.equal(plan.action, "save");
    assert.deepEqual(plan.contact, { customer_name: null, customer_phone: null, customer_email: null });
});

test("com as estatísticas: a sacola usa o código da sessão, como antes (versão antiga do site em cache também)", () => {
    const old = R.cartSnapshotPlan({ visitor_id: "v-1", session_id: "s-1", items: ITEMS });
    assert.equal(old.action, "save");
    assert.equal(old.cartKey, "s-1", "sem cart_key, a chave é a sessão");
    assert.equal(old.visitorId, "v-1");
    assert.equal(old.analyticsSession, "s-1");
    const current = R.cartSnapshotPlan({ cart_key: "k-9", visitor_id: "v-1", session_id: "s-1", items: ITEMS });
    assert.equal(current.cartKey, "k-9");
    assert.equal(current.analyticsSession, "s-1");
});

test("sem chave da sacola: pedido inválido", () => {
    assert.deepEqual(R.cartSnapshotPlan({ items: ITEMS, customer_phone: "85999991234" }), { action: "invalid" });
    assert.deepEqual(R.cartSnapshotPlan(null), { action: "invalid" });
    assert.deepEqual(R.cartSnapshotPlan({ cart_key: "   " }), { action: "invalid" });
});

test("\"Não quero\" no checkout: pedido para esquecer o contato daquela sacola", () => {
    assert.deepEqual(R.cartSnapshotPlan({ cart_key: "k-3", forget_contact: true, customer_phone: "85999991234" }), { action: "forget", cartKey: "k-3" });
    // Só o valor true vale: um texto qualquer não apaga nada.
    assert.equal(R.cartSnapshotPlan({ cart_key: "k-3", forget_contact: "sim", customer_phone: "85999991234" }).action, "save");
});

test("tamanhos limitados", () => {
    const plan = R.cartSnapshotPlan({ cart_key: "k".repeat(500), visitor_id: "v".repeat(500), session_id: "s", customer_name: "N".repeat(500), customer_phone: "85999991234" });
    assert.equal(plan.cartKey.length, 120);
    assert.equal(plan.visitorId.length, 120);
    assert.equal(plan.contact.customer_name.length, 160);
});

test("mensagem pronta para a loja: diz como não receber mais e cabe sem o link", () => {
    const { message, shortMessage } = R.abandonedCartMessages({ firstName: "Ana", pieces: "Bag Vienna (Preta)", cartUrl: "https://oficialmontee.com.br/s/abc" });
    assert.match(message, /^Oi, Ana! Aqui é da MONTÊ\. Vi que você deixou Bag Vienna \(Preta\) na sacola\./);
    assert.match(message, /Sua sacola está aqui: https:\/\/oficialmontee\.com\.br\/s\/abc/);
    for (const text of [message, shortMessage]) assert.ok(text.endsWith(R.CART_FOLLOWUP_OPT_OUT), "a frase de saída fecha a mensagem");
    assert.ok(!shortMessage.includes("https://"));
    assert.match(R.abandonedCartMessages({ firstName: "", pieces: "Bag", cartUrl: "u" }).message, /^Oi! Aqui é da MONTÊ/);
});

test("prazo do contato: 30 dias", () => {
    assert.equal(R.CART_CONTACT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
});

test("o servidor usa o lembrete pelo módulo (sem cópia das funções) e compila", () => {
    const source = readFileSync(new URL("../backend/server.js", import.meta.url), "utf8");
    assert.match(source, /require\("\.\/cart-reminder\.js"\)/);
    for (const name of ["brazilMobileDigits", "formatBrazilMobile"]) {
        assert.ok(!new RegExp("function " + name + "\\(").test(source), name + " fica só em backend/cart-reminder.js");
    }
    assert.doesNotThrow(() => new vm.Script("(function (require, module, exports, __dirname, __filename) {\n" + source + "\n})"));
});
