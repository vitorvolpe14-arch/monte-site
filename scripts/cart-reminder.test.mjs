// Testes do lembrete da sacola por e-mail, sem cookies (backend/cart-reminder.js).
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
    assert.equal(R.brazilMobileDigits("(85) 3333-1234"), "");
    assert.equal(R.brazilMobileDigits(null), "");
    assert.equal(R.formatBrazilMobile("85999991234"), "(85) 99999-1234");
});

test("e-mail do lembrete: minúsculo, sem espaços e completo", () => {
    assert.equal(R.reminderEmail("  Ana.Souza@Exemplo.com "), "ana.souza@exemplo.com");
    for (const bad of ["", "ana", "ana@", "ana@exemplo", "ana@exemplo.c", "a b@exemplo.com", null, "x".repeat(170) + "@exemplo.com"]) {
        assert.equal(R.reminderEmail(bad), "", String(bad));
    }
});

test("sem as estatísticas e com o e-mail digitado: guarda a sacola para o lembrete, sem código de visitante", () => {
    const plan = R.cartSnapshotPlan({ cart_key: "k-1", items: ITEMS, customer_name: "  Ana Souza ", customer_email: "Ana@Exemplo.com", customer_phone: "85 99999-1234" });
    assert.equal(plan.action, "save");
    assert.equal(plan.cartKey, "k-1");
    assert.equal(plan.visitorId, null);
    assert.equal(plan.analyticsSession, "");
    assert.deepEqual(plan.contact, { customer_name: "Ana Souza", customer_email: "ana@exemplo.com", customer_phone: null });
});

test("o WhatsApp não é guardado: o lembrete é só por e-mail", () => {
    const withConsent = R.cartSnapshotPlan({ visitor_id: "v", session_id: "s", items: ITEMS, customer_email: "a@b.com", customer_phone: "85999991234" });
    assert.equal(withConsent.contact.customer_phone, null);
    assert.equal(R.cartSnapshotPlan({ cart_key: "k", items: ITEMS, customer_phone: "85999991234" }).action, "forget", "só o WhatsApp não basta");
});

test("sem as estatísticas e sem e-mail válido: nada fica guardado (e o que havia com esse código sai)", () => {
    for (const email of ["", "ana@exemplo", undefined]) {
        const plan = R.cartSnapshotPlan({ cart_key: "k-2", items: ITEMS, customer_name: "Ana", customer_email: email });
        assert.deepEqual(plan, { action: "forget", cartKey: "k-2" });
    }
});

test("nome sem e-mail não é guardado, nem com as estatísticas", () => {
    const plan = R.cartSnapshotPlan({ visitor_id: "v", session_id: "s", items: ITEMS, customer_name: "Ana", customer_email: "" });
    assert.equal(plan.action, "save");
    assert.deepEqual(plan.contact, { customer_name: null, customer_email: null, customer_phone: null });
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
    assert.deepEqual(R.cartSnapshotPlan({ items: ITEMS, customer_email: "a@b.com" }), { action: "invalid" });
    assert.deepEqual(R.cartSnapshotPlan(null), { action: "invalid" });
    assert.deepEqual(R.cartSnapshotPlan({ cart_key: "   " }), { action: "invalid" });
});

test("\"Não quero\" no checkout: pedido para esquecer o contato daquela sacola", () => {
    assert.deepEqual(R.cartSnapshotPlan({ cart_key: "k-3", forget_contact: true, customer_email: "a@b.com" }), { action: "forget", cartKey: "k-3" });
    // Só o valor true vale: um texto qualquer não apaga nada.
    assert.equal(R.cartSnapshotPlan({ cart_key: "k-3", forget_contact: "sim", customer_email: "a@b.com" }).action, "save");
});

test("tamanhos limitados", () => {
    const plan = R.cartSnapshotPlan({ cart_key: "k".repeat(500), visitor_id: "v".repeat(500), session_id: "s", customer_name: "N".repeat(500), customer_email: "a@b.com" });
    assert.equal(plan.cartKey.length, 120);
    assert.equal(plan.visitorId.length, 120);
    assert.equal(plan.contact.customer_name.length, 160);
});

test("pedido de não receber: guarda só um código do e-mail, igual para o mesmo e-mail", () => {
    const key = R.cartReminderOptOutKey("Ana@Exemplo.com");
    assert.match(key, /^cart_reminder_optout:[0-9a-f]{64}$/);
    assert.equal(key, R.cartReminderOptOutKey(" ana@exemplo.com"));
    assert.ok(!key.includes("ana"), "o e-mail não aparece na chave");
    assert.notEqual(key, R.cartReminderOptOutKey("bia@exemplo.com"));
    assert.equal(R.cartReminderOptOutKey("sem-email"), "");
    assert.equal(R.cartReminderEmailHash("ana@exemplo.com"), key.split(":")[1]);
});

test("texto do e-mail: cumprimenta, explica por que chegou e é o único lembrete", () => {
    const mail = R.abandonedCartEmail({ firstName: "Ana" });
    assert.equal(mail.title, "Oi, Ana! Sua sacola ficou guardada");
    assert.match(mail.subject, /sacola/i);
    assert.match(mail.buttonText, /SACOLA/);
    assert.match(mail.footnote, /começou uma compra/);
    assert.match(mail.footnote, /único lembrete/);
    assert.match(mail.optOutText, /Não quero receber/);
    assert.ok(mail.paragraphs.length >= 1);
    assert.equal(R.abandonedCartEmail({ firstName: "" }).title, "Oi! Sua sacola ficou guardada");
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
    // O aviso para a loja chamar no WhatsApp saiu para as sacolas: a cliente recebe o e-mail.
    assert.ok(!/function storeFollowupAbandonedCarts\(/.test(source));
    assert.match(source, /steps\.push\([^)]*remindAbandonedCarts/);
    assert.doesNotThrow(() => new vm.Script("(function (require, module, exports, __dirname, __filename) {\n" + source + "\n})"));
});
