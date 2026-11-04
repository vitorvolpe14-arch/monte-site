// Desconto do Pix aplicado pela própria InfinitePay (options.discounts.pix no link).
//
// O link sai com o preço cheio (o do cartão) e a InfinitePay tira o desconto só se a
// cliente pagar no Pix. Assim o desconto não vale no cartão, mesmo que a cliente troque a
// forma de pagamento na página da InfinitePay.
//
// A InfinitePay desconta um percentual do link inteiro (peças + frete), mas a MONTÊ dá o
// desconto só nas peças, com o frete integral. Por isso o percentual enviado é o que leva o
// total do link exatamente ao valor do Pix calculado pela loja (o mesmo que o site mostra).

const MAX_DECIMAL_PLACES = 6;

// Percentual para options.discounts.pix: o de menos casas decimais que, aplicado ao link
// inteiro e arredondado em centavos, dá o valor do Pix. 0 quando não há desconto.
function pixLinkDiscountPercent(linkCents, pixCents) {
    const link = Number(linkCents);
    const pix = Number(pixCents);
    if (!Number.isFinite(link) || !Number.isFinite(pix) || link <= 0 || pix <= 0 || pix >= link) return 0;
    const exact = (link - pix) / link * 100;
    for (let places = 0; places <= MAX_DECIMAL_PLACES; places++) {
        const percent = Number(exact.toFixed(places));
        if (percent <= 0 || percent >= 100) continue;
        // Folga de um quarto de centavo para o valor não ficar no limite do arredondamento.
        if (Math.abs(link * (100 - percent) / 100 - pix) <= 0.25) return percent;
    }
    return Number(exact.toFixed(MAX_DECIMAL_PLACES));
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

module.exports = { pixLinkDiscountPercent, pixAmountTolerance, isExpectedPixAmount, paidPriceKey };
