// Testes da conta do desconto do Pix aplicado pela InfinitePay (backend/pix-discount.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pixLinkDiscountPercent, pixAmountTolerance, isExpectedPixAmount, paidPriceKey } = require("../backend/pix-discount.js");

// Valor no Pix pela conta da InfinitePay: o percentual sobre o link inteiro, em centavos.
const infinitePayPix = (linkCents, percent) => Math.round(linkCents * (100 - percent) / 100);

test("pedido MONTÊ-0072: 5% só nas peças, frete integral", () => {
    // Peças de R$ 509,00 e R$ 499,00 e frete de R$ 20,00. No Pix: 483,55 + 474,05 + 20,00.
    const linkCents = 50900 + 49900 + 2000;
    const pixCents = 48355 + 47405 + 2000;
    const percent = pixLinkDiscountPercent(linkCents, pixCents);
    assert.ok(percent > 4.9 && percent < 4.91, `percentual ${percent}`);
    assert.equal(infinitePayPix(linkCents, percent), pixCents);
});

test("frete grátis: o percentual é o do painel", () => {
    assert.equal(pixLinkDiscountPercent(100000, 95000), 5);
    assert.equal(pixLinkDiscountPercent(29900, 28405), 5);
});

test("usa poucas casas decimais e sempre fecha no centavo", () => {
    for (let linkCents = 1000; linkCents < 600000; linkCents += 7919) {
        for (const shippingCents of [0, 1500, 2000, 3890]) {
            const productCents = linkCents;
            const pixCents = Math.round(productCents * 0.95) + shippingCents;
            const total = productCents + shippingCents;
            const percent = pixLinkDiscountPercent(total, pixCents);
            assert.equal(infinitePayPix(total, percent), pixCents, `link ${total}, Pix ${pixCents}, ${percent}%`);
            const places = (String(percent).split(".")[1] || "").length;
            assert.ok(places <= 6, `${percent} tem casas demais`);
        }
    }
});

test("sem desconto não manda percentual", () => {
    assert.equal(pixLinkDiscountPercent(10000, 10000), 0);
    assert.equal(pixLinkDiscountPercent(10000, 12000), 0);
    assert.equal(pixLinkDiscountPercent(0, 0), 0);
    assert.equal(pixLinkDiscountPercent(NaN, 100), 0);
});

test("margem do valor do Pix: pequena e proporcional ao link", () => {
    assert.equal(pixAmountTolerance(1000), 2);
    assert.equal(pixAmountTolerance(102800), 11);
    assert.ok(isExpectedPixAmount(97760, 97760, 102800));
    assert.ok(isExpectedPixAmount(97765, 97760, 102800));
    assert.ok(!isExpectedPixAmount(102800, 97760, 102800));
    assert.ok(!isExpectedPixAmount(NaN, 97760, 102800));
});

test("depois do pagamento: vale o valor da forma que a cliente usou", () => {
    const options = { link_total: 1028, pix: { total: 977.6 }, credit_card: { total: 1028 } };
    // Pix com o desconto: amount é o valor original do link e paid_amount o pago.
    assert.equal(paidPriceKey(options, { capture_method: "pix", amount: 102800, paid_amount: 97760 }), "pix");
    // Pix com o desconto informado já no amount.
    assert.equal(paidPriceKey(options, { capture_method: "pix", amount: 97760, paid_amount: 97760 }), "pix");
    // Pix em que a InfinitePay não aplicou o desconto: preço cheio.
    assert.equal(paidPriceKey(options, { capture_method: "pix", amount: 102800, paid_amount: 102800 }), "credit_card");
    // Cartão: preço cheio, com ou sem juros do parcelamento repassados.
    assert.equal(paidPriceKey(options, { capture_method: "credit_card", amount: 102800, paid_amount: 102800 }), "credit_card");
    assert.equal(paidPriceKey(options, { capture_method: "credit_card", amount: 102800, paid_amount: 109000 }), "credit_card");
    assert.equal(paidPriceKey(null, { capture_method: "pix", amount: 97760 }), "credit_card");
});
