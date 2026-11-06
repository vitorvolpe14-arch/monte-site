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

// Pedido MONTÊ-0076: link de R$ 514,00 com o desconto do Pix pela InfinitePay. O pedido ficou
// com R$ 489,05 e a InfinitePay cobrou R$ 489,08 (arredondamento do desconto). Pix não tem
// parcelamento, juros nem taxa: os R$ 0,03 são só o arredondamento.
test("Pix: diferença do desconto da InfinitePay não é juros", () => {
    const n = infinitePayNet(order(489.05, { capture_method: "pix", installments: 1, amount: 514, paid_amount: 489.08 }, { paid_at: "2026-11-06T02:50:43Z" }));
    assert.deepEqual(
        { method: n.method, installments: n.installments, paid: n.paid, interest: n.interest, fee: n.fee, net: n.net, pix_rounding: n.pix_rounding },
        { method: "pix", installments: 1, paid: 489.08, interest: 0, fee: 0, net: 489.08, pix_rounding: 0.03 }
    );
    // Abaixo do valor do pedido, também é arredondamento (a cliente pagou menos).
    const menos = infinitePayNet(order(977.6, { capture_method: "pix", installments: 1, amount: 1028, paid_amount: 977.53 }));
    assert.deepEqual([menos.interest, menos.pix_rounding, menos.net], [0, -0.07, 977.53]);
    // No cartão não há arredondamento do Pix.
    const cartao = infinitePayNet(order(514, { capture_method: "credit_card", installments: 5, paid_amount: 524.09 }));
    assert.deepEqual([cartao.interest, cartao.pix_rounding], [10.09, 0]);
});

test("crédito à vista e 3x sem juros: a taxa sai da loja", () => {
    const vista = infinitePayNet(order(569.5, { capture_method: "credit_card", installments: 1, paid_amount: 569.5 }));
    assert.equal(vista.fee_percent, 4.2);
    assert.equal(vista.fee, 23.91);
    assert.equal(vista.net, 545.59);
    const tres = infinitePayNet(order(963, { capture_method: "credit_card", installments: 3, paid_amount: 963 }));
    assert.equal(tres.fee_percent, 7.01);
    assert.equal(tres.fee, 67.50);
    assert.equal(tres.net, 895.50);
    assert.equal(tres.interest, 0);
    assert.equal(tres.cost, 67.50);
});

// Vendas reais do site: a cliente pagou os juros e a loja recebeu quase o mesmo que em 3x
// (valor da venda × (1 − 7,01%)), o que confirma a tabela.
test("parcelado com juros pagos pela cliente", () => {
    for (const [total, installments, paid, net] of [[514, 5, 524.09, 477.98], [913, 10, 999.53, 849.01], [504, 12, 562.36, 468.68]]) {
        const n = infinitePayNet(order(total, { capture_method: "credit_card", installments, paid_amount: paid }));
        assert.equal(n.installments, installments);
        assert.equal(n.paid, paid);
        assert.equal(n.net, net, `${installments}x`);
        assert.equal(n.interest, Math.round((paid - total) * 100) / 100);
        assert.ok(Math.abs(n.net - total * (1 - 0.0701)) < 0.02, `${installments}x igual ao de 3x`);
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

// Os prints do app da InfinitePay (vendas do site): a taxa tem os centavos cortados.
test("site: igual ao app da InfinitePay", () => {
    const tres = infinitePayNet(order(977.6, { capture_method: "credit_card", installments: 3, paid_amount: 977.6 }, { paid_at: "2026-11-04T12:16:27Z" }));
    assert.deepEqual([tres.fee_percent, tres.fee, tres.net], [7.01, 68.52, 909.08]);
    const doze = infinitePayNet(order(504, { capture_method: "credit_card", installments: 12, paid_amount: 562.36 }, { paid_at: "2026-10-21T18:04:26Z" }));
    assert.deepEqual([doze.fee_percent, doze.fee, doze.net], [16.66, 93.68, 468.68]);
    const pix = infinitePayNet(order(528.01, { capture_method: "pix", installments: 1, paid_amount: 528.01 }, { paid_at: "2026-11-02T15:31:15Z" }));
    assert.deepEqual([pix.fee, pix.net], [0, 528.01]);
});

// ----- Vendas da loja (Olist) -----
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

// As vendas da loja no cartão passam pelo link de pagamento da InfinitePay (prints do app):
// mesmas taxas do site. A maquininha (faixa pelo faturamento) fica só para o débito.
test("loja: igual ao app da InfinitePay (link de pagamento)", () => {
    const credito = (total, n, data) => loja(total, "INFINITY CREDITO-DEBITO", { meio: "INFINITY CREDITO-DEBITO", forma: "Cartão de crédito", condicao: Array.from({ length: n }, (_, k) => k + 1).join(" "), parcelas: n, meios_parcelas: ["INFINITY CREDITO-DEBITO", "Cartão de crédito"] }, data);
    for (const [total, n, data, percent, fee, net] of [
        [556.05, 10, "2026-11-04", 15.06, 83.74, 472.31],
        [733, 2, "2026-11-04", 6.09, 44.63, 688.37],
        [514, 3, "2026-10-29", 7.01, 36.03, 477.97],
        [544.49, 5, "2026-10-16", 8.80, 47.91, 496.58]
    ]) {
        const v = olistStoreNet(credito(total, n, data), { "2026-09": 18000, "2026-10": 18000 });
        assert.deepEqual([v.method, v.installments, v.fee_percent, v.fee, v.net, v.estimated], ["credit", n, percent, fee, net, false], `${total} em ${n}x`);
        assert.equal(v.label, `Crédito ${n}x`);
    }
});

test("faixa da maquininha (débito) pelo faturamento em cartão do mês anterior", () => {
    const sale = loja(1000, "INFINITY CREDITO-DEBITO", { forma: "Cartão de débito" });
    assert.equal(olistStoreNet(sale, { "2026-10": 18000 }).fee_percent, 1.37);
    assert.equal(olistStoreNet(sale, { "2026-10": 18000 }).tier, "até R$ 20 mil");
    assert.equal(olistStoreNet(sale, { "2026-10": 25000 }).fee_percent, 0.85);
    assert.equal(olistStoreNet(sale, { "2026-10": 45000 }).fee_percent, 0.79);
    assert.equal(olistStoreNet(sale, { "2026-10": 90000 }).fee_percent, 0.75);
    // Sem o mês anterior nos dados: usa o próprio mês.
    assert.equal(olistStoreNet(loja(1000, "INFINITY CREDITO-DEBITO", { forma: "Cartão de débito" }, "2026-07-10"), { "2026-07": 25000 }).fee_percent, 0.85);
    // Janeiro olha dezembro do ano anterior.
    assert.equal(olistStoreNet(loja(1000, "INFINITY CREDITO-DEBITO", { forma: "Cartão de débito" }, "2027-01-05"), { "2026-12": 50000 }).fee_percent, 0.79);
    // O crédito não depende da faixa.
    assert.equal(olistStoreNet(loja(1000, "INFINITY CREDITO-DEBITO", { forma: "Cartão de crédito", parcelas: 3 }), { "2026-10": 90000 }).fee_percent, 7.01);
});

test("líquido da loja: o que é exato e o que é estimado", () => {
    const b = { "2026-10": 18000 };
    const pix = olistStoreNet(loja(479.55, "INFINITY PIX"), b);
    assert.deepEqual([pix.fee, pix.net, pix.estimated, pix.label], [0, 479.55, false, "Pix"]);
    // Cartão sem dizer crédito ou débito: crédito à vista, estimado.
    const card = olistStoreNet(loja(514, "INFINITY CREDITO-DEBITO"), b);
    assert.deepEqual([card.fee_percent, card.fee, card.net, card.estimated], [4.2, 21.58, 492.42, true]);
    const debit = olistStoreNet(loja(514, "INFINITY CREDITO-DEBITO", { meio: "Cartão de débito" }), b);
    assert.deepEqual([debit.fee_percent, debit.net, debit.label, debit.estimated], [1.37, 506.96, "Débito", true]);
    const tres = olistStoreNet(loja(733, "INFINITY CREDITO-DEBITO", { meio: "Cartão de crédito", parcelas: 3 }), b);
    assert.deepEqual([tres.fee_percent, tres.fee, tres.net, tres.label, tres.estimated], [7.01, 51.38, 681.62, "Crédito 3x", false]);
    const cash = olistStoreNet(loja(200, "Dinheiro"), b);
    assert.deepEqual([cash.fee, cash.net, cash.estimated], [0, 200, false]);
    const semDetalhe = olistStoreNet({ data: "2026-11-03", total: 300, detail_at: null }, b);
    assert.deepEqual([semDetalhe.fee_percent, semDetalhe.net, semDetalhe.estimated, semDetalhe.label], [4.2, 287.4, true, "Cartão (sem detalhe)"]);
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
    assert.deepEqual([n.method, n.installments, n.label, n.fee_percent], ["credit", 5, "Crédito 5x", 8.8]);
    assert.equal(n.net, 384.99);
    const pix = olistStoreNet(loja(439.56, "INFINITY PIX", { dias: [0], meio: "INFINITY PIX", forma: "Pix", condicao: "0", parcelas: 1, meios_parcelas: ["INFINITY PIX", "Pix"] }), b);
    assert.deepEqual([pix.method, pix.fee, pix.net, pix.estimated], ["pix", 0, 439.56, false]);
    const debito = olistStoreNet(loja(300, "INFINITY CREDITO-DEBITO", { meio: "INFINITY CREDITO-DEBITO", forma: "Cartão de débito", condicao: "1", parcelas: 1, meios_parcelas: ["INFINITY CREDITO-DEBITO", "Cartão de débito"] }), b);
    assert.deepEqual([debito.method, debito.label, debito.fee_percent], ["debit", "Débito", 1.37]);
});
