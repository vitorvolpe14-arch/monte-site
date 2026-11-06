// Desconto do Pix aplicado pela própria InfinitePay (options.discounts.pix no link).
//
// O link sai com o preço cheio (o do cartão) e a InfinitePay tira o desconto só se a
// cliente pagar no Pix. Assim o desconto não vale no cartão, mesmo que a cliente troque a
// forma de pagamento na página da InfinitePay.
//
// A InfinitePay desconta um percentual do link inteiro (peças + frete), mas a MONTÊ dá o
// desconto só nas peças, com o frete integral. Por isso o percentual enviado é o que leva o
// total do link ao valor do Pix calculado pela loja (o mesmo que o site mostra).
//
// A InfinitePay guarda o percentual com duas casas e corta os centavos do desconto. Pedido
// MONTÊ-0076: o site mandou 4,854%, ela aplicou 4,85%, R$ 514,00 × 4,85% = R$ 24,929 → R$ 24,92
// de desconto, e a cliente pagou R$ 489,08 no Pix em vez dos R$ 489,05 do site.
//
// Com um percentual só no link inteiro, quase nunca dá para chegar exatamente em "5% nas peças
// com o frete integral". Por isso o site mostra o valor que a InfinitePay vai cobrar
// (infinitePayPixQuote): o percentual vai com duas casas, o menor que não deixa o Pix passar dos
// 5% nas peças, e os centavos que sobram entram no desconto do Pix (a cliente ganha alguns
// centavos a mais, nunca a menos). script.js faz a mesma conta no navegador.

// Valor do Pix pela conta da InfinitePay, em centavos: link − desconto com os centavos cortados.
function infinitePayPixCents(linkCents, percent) {
    const link = Math.round(Number(linkCents));
    const basisPoints = Math.round(Number(percent) * 100); // 4,85% → 485
    return link - Math.floor(link * basisPoints / 10000);
}

// Percentual para options.discounts.pix, com duas casas. 0 quando não há desconto.
function pixLinkDiscountPercent(linkCents, pixCents) {
    const link = Math.round(Number(linkCents));
    const pix = Math.round(Number(pixCents));
    if (!Number.isFinite(link) || !Number.isFinite(pix) || link <= 0 || pix <= 0 || pix >= link) return 0;
    // Menor percentual em centésimos (0,01% = 1) cujo desconto, com os centavos cortados, chega
    // ao desconto da loja: link × p / 10000 ≥ link − pix.
    const basisPoints = Math.ceil((link - pix) * 10000 / link);
    if (basisPoints <= 0 || basisPoints >= 10000) return 0;
    return basisPoints / 100;
}

// Pix que a InfinitePay cobra para o Pix calculado pela loja: { percent, cents }. É o valor que
// o site mostra e o pedido guarda. Sem desconto (Pix igual ao cartão), percent 0 e o próprio Pix.
function infinitePayPixQuote(linkCents, pixCents) {
    const percent = pixLinkDiscountPercent(linkCents, pixCents);
    const pix = Math.round(Number(pixCents));
    return { percent, cents: percent > 0 ? infinitePayPixCents(linkCents, percent) : (Number.isFinite(pix) ? pix : 0) };
}

// Diferença aceita, em centavos, entre o valor do Pix informado pela InfinitePay e o
// calculado pela loja (arredondamento do percentual do lado dela).
function pixAmountTolerance(linkCents) {
    return Math.max(2, Math.ceil(Number(linkCents) / 10000));
}

function isExpectedPixAmount(amountCents, pixCents, linkCents) {
    const amount = Number(amountCents);
    return Number.isFinite(amount) && Math.abs(amount - Number(pixCents)) <= pixAmountTolerance(linkCents);
}

// Valor que vale para o pedido depois do pagamento (orders.payment_options): "pix" quando a
// InfinitePay cobrou o valor com o desconto; "credit_card" (preço cheio) no cartão e também
// num Pix em que o desconto não foi aplicado. payment: resposta do payment_check (centavos).
function paidPriceKey(paymentOptions, payment) {
    if (payment?.capture_method !== "pix") return "credit_card";
    const linkCents = Math.round(Number(paymentOptions?.link_total) * 100);
    const pixCents = Math.round(Number(paymentOptions?.pix?.total) * 100);
    if (!Number.isFinite(linkCents) || !Number.isFinite(pixCents)) return "credit_card";
    const charged = [payment.paid_amount, payment.amount].filter(value => value !== null && value !== undefined && value !== "");
    return charged.some(value => isExpectedPixAmount(value, pixCents, linkCents)) ? "pix" : "credit_card";
}

module.exports = { pixLinkDiscountPercent, infinitePayPixCents, infinitePayPixQuote, pixAmountTolerance, isExpectedPixAmount, paidPriceKey };
