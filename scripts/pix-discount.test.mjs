// Testes da conta do desconto do Pix aplicado pela InfinitePay (backend/pix-discount.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pixLinkDiscountPercent, infinitePayPixCents, infinitePayPixQuote, pixAmountTolerance, isExpectedPixAmount, paidPriceKey } = require("../backend/pix-discount.js");

const places = percent => (String(percent).split(".")[1] || "").length;

// Pedido real: o site mandou 4,854% e a InfinitePay aplicou 4,85% (duas casas) e cortou os
// centavos do desconto: R$ 514,00 × 4,85% = R$ 24,929 → R$ 24,92 → R$ 489,08 no Pix.
test("pedido MONTÊ-0076: a conta da InfinitePay", () => {
    assert.equal(infinitePayPixCents(51400, 4.85), 48908);
    assert.equal(infinitePayPixCents(51400, 4.854), 48908);
});

test("pedido MONTÊ-0076: duas casas e nunca acima do Pix do site", () => {
    // Bag de R$ 499,00 (R$ 474,05 no Pix) e frete de R$ 15,00.
    const percent = pixLinkDiscountPercent(51400, 48905);
    assert.equal(percent, 4.86);
    assert.equal(infinitePayPixCents(51400, percent), 48902);
    assert.ok(isExpectedPixAmount(48902, 48905, 51400));
});

test("pedido MONTÊ-0072: 5% só nas peças, frete integral", () => {
    // Peças de R$ 509,00 e R$ 499,00 e frete de R$ 20,00. No Pix: 483,55 + 474,05 + 20,00.
    const linkCents = 50900 + 49900 + 2000;
    const pixCents = 48355 + 47405 + 2000;
    const percent = pixLinkDiscountPercent(linkCents, pixCents);
    assert.equal(percent, 4.91);
    const charged = infinitePayPixCents(linkCents, percent);
    assert.ok(charged <= pixCents && isExpectedPixAmount(charged, pixCents, linkCents), `cobrado ${charged}`);
});

test("frete grátis: o percentual é o do painel", () => {
    assert.equal(pixLinkDiscountPercent(100000, 95000), 5);
    assert.equal(pixLinkDiscountPercent(29900, 28405), 5);
});

test("duas casas, nunca acima do Pix do site e dentro da margem do pagamento", () => {
    for (let productCents = 1000; productCents < 600000; productCents += 7919) {
        for (const shippingCents of [0, 1500, 2000, 3890]) {
            const pixCents = Math.round(productCents * 0.95) + shippingCents;
            const total = productCents + shippingCents;
            const percent = pixLinkDiscountPercent(total, pixCents);
            const charged = infinitePayPixCents(total, percent);
            const label = `link ${total}, Pix ${pixCents}, ${percent}% → ${charged}`;
            assert.ok(places(percent) <= 2, `${label}: casas demais`);
            assert.ok(charged <= pixCents, `${label}: acima do Pix do site`);
            // O menor percentual que não passa do Pix: com 0,01% a menos, passaria.
            assert.ok(infinitePayPixCents(total, Math.round(percent * 100 - 1) / 100) > pixCents, `${label}: desconto maior que o preciso`);
            assert.ok(isExpectedPixAmount(charged, pixCents, total), `${label}: fora da margem`);
        }
    }
});

// O site mostra o valor que a InfinitePay vai cobrar: o pedido guarda esse valor e o link sai
// com um percentual que chega nele exatamente.
test("pedido MONTÊ-0076: o site mostra o mesmo Pix da InfinitePay", () => {
    assert.deepEqual(infinitePayPixQuote(51400, 48905), { percent: 4.86, cents: 48902 });
});

test("valor do Pix do site: igual ao da InfinitePay, nunca acima dos 5% nas peças", () => {
    for (let productCents = 1000; productCents < 600000; productCents += 3917) {
        for (const shippingCents of [0, 990, 1500, 2000, 3890]) {
            const storePix = Math.round(productCents * 0.95) + shippingCents;
            const link = productCents + shippingCents;
            const quote = infinitePayPixQuote(link, storePix);
            const label = `link ${link}, Pix da loja ${storePix} → ${quote.cents}`;
            assert.ok(quote.cents <= storePix, `${label}: acima do Pix da loja`);
            assert.equal(infinitePayPixCents(link, quote.percent), quote.cents, `${label}: a InfinitePay cobraria outro valor`);
            // O percentual do link sai do valor do site já ajustado e chega nele.
            assert.equal(infinitePayPixCents(link, pixLinkDiscountPercent(link, quote.cents)), quote.cents, `${label}: link`);
        }
    }
});

test("sem desconto o Pix fica como está", () => {
    assert.deepEqual(infinitePayPixQuote(10000, 10000), { percent: 0, cents: 10000 });
    assert.deepEqual(infinitePayPixQuote(0, 0), { percent: 0, cents: 0 });
});

// script.js faz a mesma conta no navegador para mostrar o total do checkout.
test("site (script.js) e servidor fazem a mesma conta", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../script.js", import.meta.url), "utf8");
    const match = source.match(/function infinitePayPixTotalCents\([^)]*\) \{[\s\S]*?\n\}\n/);
    assert.ok(match, "infinitePayPixTotalCents no script.js");
    const siteQuote = new Function(match[0] + "return infinitePayPixTotalCents;")();
    for (const [link, pix] of [[51400, 48905], [102800, 97760], [29900, 28405], [101980, 96882], [10000, 10000], [5000, 4750], [1099, 1044]]) {
        assert.equal(siteQuote(link, pix), infinitePayPixQuote(link, pix).cents, `link ${link}, Pix ${pix}`);
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
