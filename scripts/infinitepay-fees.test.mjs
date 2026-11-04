// Testes do valor líquido da InfinitePay (backend/infinitepay-fees.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { INFINITEPAY_FEE_TABLES, infinitePayFeeTable, infinitePayNet } = require("../backend/infinitepay-fees.js");

// Pedido pago no site, no formato de /api/admin/orders (orders + payments).
const order = (total, payment, extra = {}) => ({
    status: "paid",
    total,
    payment_method: payment.capture_method,
    paid_at: "2026-10-20T15:00:00Z",
    payments: [{ status: "paid", amount: total, ...payment }],
    ...extra
});

test("tabela do link de pagamento em 1 dia útil", () => {
    const t = infinitePayFeeTable("2026-11-04T12:00:00Z");
    assert.equal(t.pix, 0);
    assert.equal(t.credit.length, 12);
    assert.deepEqual([t.credit[0], t.credit[2], t.credit[11]], [4.2, 7.01, 16.66]);
});

test("Pix: sem taxa", () => {
    const n = infinitePayNet(order(490.59, { capture_method: "pix", installments: 1, paid_amount: 490.59 }));
    assert.deepEqual(
        { method: n.method, fee_percent: n.fee_percent, fee: n.fee, net: n.net, interest: n.interest },
        { method: "pix", fee_percent: 0, fee: 0, net: 490.59, interest: 0 }
    );
});

test("crédito à vista e 3x sem juros: a taxa sai da loja", () => {
    const vista = infinitePayNet(order(569.5, { capture_method: "credit_card", installments: 1, paid_amount: 569.5 }));
    assert.equal(vista.fee_percent, 4.2);
    assert.equal(vista.fee, 23.92);
    assert.equal(vista.net, 545.58);
    const tres = infinitePayNet(order(963, { capture_method: "credit_card", installments: 3, paid_amount: 963 }));
    assert.equal(tres.fee_percent, 7.01);
    assert.equal(tres.fee, 67.51);
    assert.equal(tres.net, 895.49);
    assert.equal(tres.interest, 0);
    assert.equal(tres.cost, 67.51);
});

// Vendas reais do site: a cliente pagou os juros e a loja recebeu o mesmo que em 3x
// (valor da venda × (1 − 7,01%)), o que confirma a tabela.
test("parcelado com juros pagos pela cliente", () => {
    for (const [total, installments, paid, net] of [[514, 5, 524.09, 477.97], [913, 10, 999.53, 849], [504, 12, 562.36, 468.67]]) {
        const n = infinitePayNet(order(total, { capture_method: "credit_card", installments, paid_amount: paid }));
        assert.equal(n.installments, installments);
        assert.equal(n.paid, paid);
        assert.equal(n.net, net, `${installments}x`);
        assert.equal(n.interest, Math.round((paid - total) * 100) / 100);
        assert.ok(Math.abs(n.net - total * (1 - 0.0701)) < 0.01, `${installments}x igual ao de 3x`);
    }
});

test("sem a linha de pagamento, usa os dados do pedido", () => {
    const n = infinitePayNet({ status: "shipped", total: 504, payment_method: "credit_card", installments: 3, paid_amount: 504, paid_at: "2026-10-27T10:00:00Z" });
    assert.equal(n.fee_percent, 7.01);
    assert.equal(n.net, 468.67);
});

test("valor pago zerado ou ausente vale o valor da venda", () => {
    const n = infinitePayNet(order(100, { capture_method: "credit_card", installments: 1, paid_amount: 0 }));
    assert.equal(n.paid, 100);
    assert.equal(n.net, 95.8);
    const m = infinitePayNet(order(100, { capture_method: "pix", paid_amount: null }));
    assert.equal(m.net, 100);
});

test("parcelas fora de 1 a 12 ficam no limite", () => {
    assert.equal(infinitePayNet(order(100, { capture_method: "credit_card", installments: 18, paid_amount: 100 })).installments, 12);
    assert.equal(infinitePayNet(order(100, { capture_method: "credit_card", installments: 0, paid_amount: 100 })).installments, 1);
    assert.equal(infinitePayNet(order(100, { capture_method: "pix", installments: 3, paid_amount: 100 })).installments, 1);
});

test("pedido não pago não tem líquido", () => {
    assert.equal(infinitePayNet({ status: "pending", total: 100, payments: [] }), null);
    assert.equal(infinitePayNet({ status: "expired", total: 100 }), null);
    assert.equal(infinitePayNet(null), null);
});

test("pedido cancelado depois de pago mantém o pagamento (estorno)", () => {
    const n = infinitePayNet(order(200, { capture_method: "pix", paid_amount: 200 }, { status: "cancelled" }));
    assert.equal(n.net, 200);
});

test("taxa nova vale só a partir da data dela", () => {
    const original = INFINITEPAY_FEE_TABLES.slice();
    INFINITEPAY_FEE_TABLES.push({ since: "2027-01-01", plan: "teste", pix: 0, credit: Array(12).fill(1) });
    try {
        assert.equal(infinitePayNet(order(100, { capture_method: "credit_card", installments: 1, paid_amount: 100 })).fee_percent, 4.2);
        assert.equal(infinitePayNet(order(100, { capture_method: "credit_card", installments: 1, paid_amount: 100 }, { paid_at: "2027-01-02T10:00:00Z" })).fee_percent, 1);
        assert.equal(infinitePayFeeTable("2025-05-01").since, original[0].since);
    } finally {
        INFINITEPAY_FEE_TABLES.length = 0;
        INFINITEPAY_FEE_TABLES.push(...original);
    }
});

// ----- Vendas da loja (Olist) na maquininha: estimativa -----
const { olistPaymentKind, olistStoreNet, cardBillingByMonth } = require("../backend/infinitepay-fees.js");
const loja = (total, pagamento, info = null, data = "2026-11-03") => ({ data, total, pagamento, pagamento_info: info, detail_at: "2026-11-04T22:00:00Z" });

test("forma de pagamento da loja", () => {
    assert.deepEqual(olistPaymentKind(loja(100, "INFINITY PIX")), { kind: "pix", installments: 1 });
    assert.equal(olistPaymentKind(loja(100, "Dinheiro")).kind, "other");
    assert.equal(olistPaymentKind(loja(100, "INFINITY CREDITO-DEBITO")).kind, "card");
    assert.equal(olistPaymentKind(loja(100, "INFINITY CREDITO-DEBITO", { meio: "Cartão de débito" })).kind, "debit");
    assert.deepEqual(olistPaymentKind(loja(100, "INFINITY CREDITO-DEBITO", { meio: "Cartão de crédito", parcelas: 3 })), { kind: "credit", installments: 3 });
    assert.deepEqual(olistPaymentKind(loja(100, "INFINITY CREDITO-DEBITO", { condicao: "30 60 90", parcelas: 1 })), { kind: "credit", installments: 3 });
    assert.deepEqual(olistPaymentKind(loja(100, "Cartão de crédito", { condicao: "5x" })), { kind: "credit", installments: 5 });
    assert.equal(olistPaymentKind(loja(100, "Múltiplas")).kind, "card");
    assert.equal(olistPaymentKind({ data: "2026-11-03", total: 100, pagamento: null, detail_at: null }).kind, "unknown");
});

test("faixa da maquininha pelo faturamento em cartão do mês anterior", () => {
    const sale = loja(1000, "INFINITY CREDITO-DEBITO");
    assert.equal(olistStoreNet(sale, { "2026-10": 18000 }).fee_percent, 3.15);
    assert.equal(olistStoreNet(sale, { "2026-10": 18000 }).tier, "até R$ 20 mil");
    assert.equal(olistStoreNet(sale, { "2026-10": 25000 }).fee_percent, 2.89);
    assert.equal(olistStoreNet(sale, { "2026-10": 45000 }).fee_percent, 2.79);
    assert.equal(olistStoreNet(sale, { "2026-10": 90000 }).fee_percent, 2.69);
    // Sem o mês anterior nos dados: usa o próprio mês.
    assert.equal(olistStoreNet(loja(1000, "INFINITY CREDITO-DEBITO", null, "2026-07-10"), { "2026-07": 25000 }).fee_percent, 2.89);
    // Janeiro olha dezembro do ano anterior.
    assert.equal(olistStoreNet(loja(1000, "INFINITY CREDITO-DEBITO", null, "2027-01-05"), { "2026-12": 50000 }).fee_percent, 2.79);
});

test("líquido estimado da loja", () => {
    const b = { "2026-10": 18000 };
    const pix = olistStoreNet(loja(479.55, "INFINITY PIX"), b);
    assert.deepEqual([pix.fee, pix.net, pix.estimated, pix.label], [0, 479.55, false, "Pix"]);
    const card = olistStoreNet(loja(514, "INFINITY CREDITO-DEBITO"), b);
    assert.deepEqual([card.fee_percent, card.fee, card.net, card.estimated], [3.15, 16.19, 497.81, true]);
    const debit = olistStoreNet(loja(514, "INFINITY CREDITO-DEBITO", { meio: "Cartão de débito" }), b);
    assert.deepEqual([debit.fee_percent, debit.net, debit.label], [1.37, 506.96, "Débito"]);
    const tres = olistStoreNet(loja(733, "INFINITY CREDITO-DEBITO", { meio: "Cartão de crédito", parcelas: 3 }), b);
    assert.deepEqual([tres.fee_percent, tres.net, tres.label], [6.12, 688.14, "Crédito 3x"]);
    const cash = olistStoreNet(loja(200, "Dinheiro"), b);
    assert.deepEqual([cash.fee, cash.net, cash.estimated], [0, 200, false]);
    const semDetalhe = olistStoreNet({ data: "2026-11-03", total: 300, detail_at: null }, b);
    assert.deepEqual([semDetalhe.fee_percent, semDetalhe.estimated, semDetalhe.label], [3.15, true, "Cartão (sem detalhe)"]);
});

test("faturamento em cartão por mês (Pix e dinheiro não contam)", () => {
    const out = cardBillingByMonth(
        [loja(500, "INFINITY CREDITO-DEBITO", null, "2026-10-02"), loja(300, "INFINITY PIX", null, "2026-10-03"), loja(100, "Dinheiro", null, "2026-10-04"), loja(200, "INFINITY CREDITO-DEBITO", null, "2026-11-01")],
        [{ capture_method: "credit_card", paid_amount: 999.53, created_at: "2026-10-10T12:00:00Z" }, { capture_method: "pix", paid_amount: 490.59, created_at: "2026-10-31T12:00:00Z" }]
    );
    assert.deepEqual(out, { "2026-10": 1499.53, "2026-11": 200 });
});

// Formato real das vendas da loja na Olist (nov/2026).
test("vendas reais da loja: crédito parcelado e Pix", () => {
    const b = { "2026-10": 18000 };
    const credito5 = loja(422.13, "INFINITY CREDITO-DEBITO", { dias: [1, 2, 3, 4, 5], meio: "INFINITY CREDITO-DEBITO", forma: "Cartão de crédito", condicao: "1 2 3 4 5", parcelas: 5, meios_parcelas: ["INFINITY CREDITO-DEBITO", "Cartão de crédito"] });
    const n = olistStoreNet(credito5, b);
    assert.deepEqual([n.method, n.installments, n.label, n.fee_percent], ["credit", 5, "Crédito 5x", 7.57]);
    assert.equal(n.net, 390.17);
    const pix = olistStoreNet(loja(439.56, "INFINITY PIX", { dias: [0], meio: "INFINITY PIX", forma: "Pix", condicao: "0", parcelas: 1, meios_parcelas: ["INFINITY PIX", "Pix"] }), b);
    assert.deepEqual([pix.method, pix.fee, pix.net, pix.estimated], ["pix", 0, 439.56, false]);
    const debito = olistStoreNet(loja(300, "INFINITY CREDITO-DEBITO", { meio: "INFINITY CREDITO-DEBITO", forma: "Cartão de débito", condicao: "1", parcelas: 1, meios_parcelas: ["INFINITY CREDITO-DEBITO", "Cartão de débito"] }), b);
    assert.deepEqual([debito.method, debito.label, debito.fee_percent], ["debit", "Débito", 1.37]);
});
