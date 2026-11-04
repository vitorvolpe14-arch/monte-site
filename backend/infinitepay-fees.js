"use strict";

/* =====================================================
   VALOR LÍQUIDO DA INFINITEPAY
   O aviso de pagamento da InfinitePay não informa a taxa: chega o valor do pedido
   (amount), o valor pago pela cliente (paid_amount), a forma e as parcelas. O líquido
   sai da tabela de taxas dela para o checkout do site (link de pagamento):

       líquido = valor pago pela cliente × (1 − taxa da forma e das parcelas)

   Fonte: https://www.infinitepay.io/taxas, "Link de Pagamento & Venda Online",
   em 1 dia útil (antecipado), Visa, Mastercard, Elo e Amex.
   Conferido com as vendas do site de out/2026: nas vendas em 5x, 10x e 12x a cliente
   pagou os juros e a loja recebeu exatamente valor da venda × (1 − 7,01%), a taxa de 3x
   (o parcelamento sem juros da loja vai até 3x).

   A InfinitePay mudou a taxa, ou a loja mudou o prazo de recebimento no app? Acrescente
   uma tabela no fim da lista com a data de início: as vendas anteriores ficam com a taxa
   da época.
===================================================== */

const INFINITEPAY_FEE_TABLES = [
    {
        since: "2026-01-01",
        plan: "Link de pagamento, recebendo em 1 dia útil",
        pix: 0,
        // Crédito à vista, 2x, 3x ... 12x (% sobre o valor pago).
        credit: [4.20, 6.09, 7.01, 7.91, 8.80, 9.67, 12.59, 13.42, 14.25, 15.06, 15.87, 16.66]
    }
];

const SALE_STATUSES = ["paid", "processing", "shipped", "delivered"];

function cents(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// Tabela que valia no dia da venda (a mais recente sem data).
function infinitePayFeeTable(when) {
    const day = String(when || "").slice(0, 10);
    let pick = INFINITEPAY_FEE_TABLES[0];
    for (const table of INFINITEPAY_FEE_TABLES) {
        if (!day || table.since <= day) pick = table;
    }
    return pick;
}

// Líquido de um pedido do site (orders com payments). null quando não houve pagamento.
// Pedido cancelado depois de pago (pré-venda recusada) mantém o pagamento: o estorno
// é feito no app da InfinitePay.
function infinitePayNet(order) {
    if (!order) return null;
    const payments = Array.isArray(order.payments) ? order.payments : [];
    const payment = payments.find(p => p && p.status === "paid") || payments[0] || null;
    if (!payment && !SALE_STATUSES.includes(order.status)) return null;

    const method = String(payment?.capture_method || order.payment_method || "").toLowerCase() === "pix" ? "pix" : "credit_card";
    const installments = method === "pix"
        ? 1
        : Math.min(12, Math.max(1, Math.round(Number(payment?.installments || order.installments) || 1)));
    const sale = cents(order.total ?? payment?.amount);
    // Sem o valor pago (ou zerado no aviso), vale o valor da venda.
    const paidValue = cents(payment?.paid_amount ?? order.paid_amount);
    const paid = paidValue > 0 ? paidValue : sale;

    const table = infinitePayFeeTable(order.paid_at || payment?.created_at || order.created_at);
    const percent = method === "pix" ? table.pix : table.credit[installments - 1];
    const fee = Math.round(paid * percent / 100);
    const net = paid - fee;

    return {
        method,
        installments,
        sale: sale / 100,                         // valor da venda (total do pedido)
        paid: paid / 100,                         // o que a cliente pagou (com os juros, se houver)
        interest: Math.max(0, paid - sale) / 100, // juros do parcelamento pagos pela cliente
        fee_percent: percent,
        fee: fee / 100,                           // taxa da InfinitePay
        net: net / 100,                           // o que cai na conta
        cost: (sale - net) / 100,                 // quanto a loja deixou de receber da venda
        plan: table.plan
    };
}

// Tabela em vigor, para o painel mostrar de onde vem a conta.
function currentInfinitePayFees() {
    const table = infinitePayFeeTable("");
    return { since: table.since, plan: table.plan, pix: table.pix, credit: table.credit.slice() };
}

module.exports = { INFINITEPAY_FEE_TABLES, infinitePayFeeTable, infinitePayNet, currentInfinitePayFees };
