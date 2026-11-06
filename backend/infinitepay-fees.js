"use strict";

/* =====================================================
   VALOR LÍQUIDO DA INFINITEPAY
   O aviso de pagamento da InfinitePay não informa a taxa: chega o valor do pedido
   (amount), o valor pago pela cliente (paid_amount), a forma e as parcelas. O líquido
   sai da tabela de taxas dela para o checkout do site (link de pagamento):

       líquido = valor pago pela cliente − taxa
       taxa    = valor pago × taxa da forma e das parcelas, com os centavos cortados

   Fonte: https://www.infinitepay.io/taxas, "Link de Pagamento & Venda Online",
   em 1 dia útil (antecipado), Visa, Mastercard, Elo e Amex.
   Conferido com as vendas do site de out/2026: nas vendas em 5x, 10x e 12x a cliente
   pagou os juros e a loja recebeu exatamente valor da venda × (1 − 7,01%), a taxa de 3x
   (o parcelamento sem juros da loja vai até 3x).

   Conferido também com o app da InfinitePay (nov/2026): R$ 977,60 em 3x → taxa R$ 68,52
   (7,01% = 68,5298: os centavos são cortados, não arredondados) e líquido R$ 909,08.

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

// Taxa em centavos como o app da InfinitePay: valor × percentual, com os centavos cortados.
function feeCents(paidCents, percent) {
    const basisPoints = Math.round(Number(percent || 0) * 100); // 7,01% → 701
    return Math.floor(paidCents * basisPoints / 10000);
}

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
    const fee = feeCents(paid, percent);
    const net = paid - fee;
    // Pix não tem parcelamento, juros nem taxa. A diferença entre o pago e o pedido no Pix é o
    // arredondamento do desconto do Pix na InfinitePay (backend/pix-discount.js), para mais ou
    // para menos.
    const interest = method === "pix" ? 0 : Math.max(0, paid - sale);
    const pixRounding = method === "pix" ? paid - sale : 0;

    return {
        method,
        installments,
        sale: sale / 100,                         // valor da venda (total do pedido)
        paid: paid / 100,                         // o que a cliente pagou (com os juros, se houver)
        interest: interest / 100,                 // juros do parcelamento pagos pela cliente
        pix_rounding: pixRounding / 100,          // arredondamento do desconto do Pix (+ ou −)
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

/* =====================================================
   VENDAS DA LOJA (OLIST) NA INFINITEPAY
   As vendas da loja chegam da Olist com o nome do pagamento ("INFINITY PIX",
   "INFINITY CREDITO-DEBITO"...) e o meio, a condição e as parcelas
   (olist_sales.pagamento_info). Daí sai a taxa:
   - Pix: grátis. Dinheiro, boleto, transferência: sem taxa (não passam pela InfinitePay).
   - Crédito: a loja cobra pelo link de pagamento da InfinitePay (conferido no app: vendas
     de 16/10 a 04/11 em 2x, 3x, 5x e 10x), então vale a mesma tabela do site, pelas
     parcelas. O valor da Olist já é o que a cliente pagou (com os juros, se houver).
   - Débito: só existe na maquininha; taxa de débito da faixa (estimada).
   - Cartão sem dizer se foi débito ou crédito, ou ainda sem o detalhe: crédito à vista
     (estimado).
   A faixa da maquininha sai do faturamento em cartão do mês anterior (site + loja; o Pix
   não conta), como a InfinitePay faz. Bandeira: Visa e Mastercard.
   Fonte: https://www.infinitepay.io/taxas.
===================================================== */

const INFINITEPAY_MACHINE_TABLES = [
    {
        since: "2026-01-01",
        plan: "Maquininha, recebendo em 1 dia útil (Visa e Mastercard)",
        // Do maior faturamento para o menor; "acima de" = mais que o valor.
        tiers: [
            { above: 80000, label: "acima de R$ 80 mil", debit: 0.75, credit: [2.69, 3.94, 4.46, 4.98, 5.49, 5.99, 6.51, 6.99, 7.51, 7.99, 8.49, 8.99] },
            { above: 40000, label: "acima de R$ 40 mil", debit: 0.79, credit: [2.79, 4.08, 4.65, 5.21, 5.77, 6.32, 6.87, 7.42, 7.96, 8.49, 9.03, 9.56] },
            { above: 20000, label: "acima de R$ 20 mil", debit: 0.85, credit: [2.89, 4.22, 4.83, 5.44, 6.05, 6.64, 7.24, 7.82, 8.41, 8.98, 9.56, 10.12] },
            { above: -1, label: "até R$ 20 mil", debit: 1.37, credit: [3.15, 5.39, 6.12, 6.85, 7.57, 8.28, 8.99, 9.69, 10.38, 11.06, 11.74, 12.40] }
        ]
    }
];

function machineTable(when) {
    const day = String(when || "").slice(0, 10);
    let pick = INFINITEPAY_MACHINE_TABLES[0];
    for (const table of INFINITEPAY_MACHINE_TABLES) {
        if (!day || table.since <= day) pick = table;
    }
    return pick;
}

function machineTier(table, cardBilling) {
    const value = Number(cardBilling) || 0;
    return table.tiers.find(tier => value > tier.above) || table.tiers[table.tiers.length - 1];
}

function plain(value) {
    return String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Como a venda da loja foi paga: { kind: pix | debit | credit | card | other | unknown, installments }.
function olistPaymentKind(sale) {
    if (!sale || !sale.detail_at) return { kind: "unknown", installments: 1 };
    const info = sale.pagamento_info && typeof sale.pagamento_info === "object" ? sale.pagamento_info : {};
    const names = [sale.pagamento, info.forma, info.meio, ...(Array.isArray(info.meios_parcelas) ? info.meios_parcelas : [])].map(plain).filter(Boolean);
    const words = names.join(" | ");
    const condition = plain(info.condicao);
    // Um nome que diz só débito (ou só crédito) vale mais que o geral "CREDITO-DEBITO".
    const onlyDebit = names.some(n => /debito/.test(n) && !/credito/.test(n));
    const onlyCredit = names.some(n => /credito/.test(n) && !/debito/.test(n));
    const debit = onlyDebit || (!onlyCredit && /debito/.test(words));
    const credit = onlyCredit || (!onlyDebit && /credito/.test(words));
    // "INFINITY PIX" é Pix: o nome da InfinitePay sozinho não quer dizer cartão.
    const cardWords = debit || credit || /cart|maquin|pos\b|\btap\b/.test(words);
    const card = cardWords || (/infinit/.test(words) && !/pix/.test(words));
    const parcelas = Number(info.parcelas) || 0;
    const byCondition = (() => {
        const x = condition.match(/(\d{1,2})\s*x/);
        if (x) return Number(x[1]);
        const days = condition.match(/\d+/g);
        return days && days.length > 1 ? days.length : 0;
    })();
    const installments = Math.min(12, Math.max(1, parcelas > 1 ? parcelas : byCondition || 1));
    if (/pix/.test(words) && !cardWords) return { kind: "pix", installments: 1 };
    if (!card && /dinheiro|especie|boleto|transfer|deposito|ted\b|doc\b/.test(words)) return { kind: "other", installments: 1 };
    if (debit && !credit) return { kind: "debit", installments: 1 };
    if (credit && !debit) return { kind: "credit", installments };
    if (card) return { kind: installments > 1 ? "credit" : "card", installments };
    // "Múltiplas" ou nome desconhecido: conta como cartão à vista.
    return { kind: words.trim() ? "card" : "unknown", installments: 1 };
}

const KIND_LABEL = { pix: "Pix", debit: "Débito", other: "Sem taxa" };
function olistPaymentLabel(p) {
    if (KIND_LABEL[p.kind]) return KIND_LABEL[p.kind];
    if (p.kind === "credit") return p.installments > 1 ? `Crédito ${p.installments}x` : "Crédito à vista";
    if (p.kind === "card") return "Cartão (crédito à vista)";
    return "Cartão (sem detalhe)";
}

// Líquido estimado de uma venda da loja. cardBillingByMonth: { "2026-10": 18500, ... }
// (faturamento em cartão do mês, site + loja). Sem o mês anterior nos dados, usa o próprio mês.
function olistStoreNet(sale, cardBillingByMonth = {}) {
    if (!sale) return null;
    const sale_ = cents(sale.total);
    const month = String(sale.data || "").slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const prev = y && m ? (m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`) : "";
    const billing = Object.prototype.hasOwnProperty.call(cardBillingByMonth, prev) ? cardBillingByMonth[prev] : cardBillingByMonth[month];
    const table = machineTable(sale.data);
    const tier = machineTier(table, billing);
    const link = infinitePayFeeTable(sale.data);
    const payment = olistPaymentKind(sale);
    const percent = payment.kind === "pix" || payment.kind === "other" ? 0
        : payment.kind === "debit" ? tier.debit
        : link.credit[payment.installments - 1];
    const fee = feeCents(sale_, percent);
    return {
        method: payment.kind,
        installments: payment.installments,
        label: olistPaymentLabel(payment),
        sale: sale_ / 100,
        paid: sale_ / 100,
        interest: 0,
        fee_percent: percent,
        fee: fee / 100,
        net: (sale_ - fee) / 100,
        cost: fee / 100,
        // Exato quando a Olist diz que foi Pix ou crédito em N vezes; estimado no débito
        // (faixa da maquininha) e quando não diz a forma.
        estimated: payment.kind === "debit" || payment.kind === "card" || payment.kind === "unknown",
        tier: payment.kind === "debit" ? tier.label : null,
        plan: payment.kind === "debit" ? table.plan : link.plan
    };
}

// Faturamento em cartão por mês: vendas da loja que não são Pix nem sem taxa + cartão do site.
function cardBillingByMonth(olistSales = [], sitePayments = []) {
    const out = {};
    const add = (month, value) => { if (month) out[month] = Math.round(((out[month] || 0) + (Number(value) || 0)) * 100) / 100; };
    olistSales.forEach(sale => {
        const kind = olistPaymentKind(sale).kind;
        if (kind !== "pix" && kind !== "other") add(String(sale.data || "").slice(0, 7), sale.total);
    });
    sitePayments.forEach(p => {
        if (String(p.capture_method || "").toLowerCase() !== "pix") add(String(p.created_at || "").slice(0, 7), p.paid_amount ?? p.amount);
    });
    return out;
}

function currentMachineFees() {
    const table = machineTable("");
    return { since: table.since, plan: table.plan, tiers: table.tiers.map(t => ({ label: t.label, debit: t.debit, credit: t.credit.slice() })) };
}

module.exports = { INFINITEPAY_FEE_TABLES, INFINITEPAY_MACHINE_TABLES, infinitePayFeeTable, infinitePayNet, currentInfinitePayFees, olistPaymentKind, olistStoreNet, cardBillingByMonth, currentMachineFees };
