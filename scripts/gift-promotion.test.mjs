// Testes da quantidade de presentes por compra (backend/gift-promotion.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { promotionGiftCount, PROMOTION_GIFTS_CEILING } = require("../backend/gift-promotion.js");

const every = { min_subtotal: 499, gift_every: true, max_gifts: null };

test("um cinto a cada R$ 499 em peças", () => {
    assert.equal(promotionGiftCount(every, 498.99), 0);
    assert.equal(promotionGiftCount(every, 499), 1);
    assert.equal(promotionGiftCount(every, 997.99), 1);
    assert.equal(promotionGiftCount(every, 998), 2);
    assert.equal(promotionGiftCount(every, 1497), 3);
    assert.equal(promotionGiftCount(every, 1996), 4);
    assert.equal(promotionGiftCount(every, 2495), 5);
    assert.equal(promotionGiftCount({ ...every, min_subtotal: "499.00" }, "1008.00"), 2);
});

test("limite de presentes por pedido", () => {
    assert.equal(promotionGiftCount({ ...every, max_gifts: 3 }, 5000), 3);
    assert.equal(promotionGiftCount({ ...every, max_gifts: 3 }, 998), 2);
    assert.equal(promotionGiftCount(every, 100000), PROMOTION_GIFTS_CEILING);
    assert.equal(promotionGiftCount({ ...every, max_gifts: 50 }, 100000), PROMOTION_GIFTS_CEILING);
});

test("promoção comum: um presente só", () => {
    const once = { min_subtotal: 499, gift_every: false };
    assert.equal(promotionGiftCount(once, 400), 0);
    assert.equal(promotionGiftCount(once, 499), 1);
    assert.equal(promotionGiftCount(once, 5000), 1);
    assert.equal(promotionGiftCount({ min_subtotal: 499 }, 5000), 1);
});

test("valores inválidos não dão presente", () => {
    assert.equal(promotionGiftCount(null, 1000), 0);
    assert.equal(promotionGiftCount({ min_subtotal: 0, gift_every: true }, 1000), 0);
    assert.equal(promotionGiftCount(every, NaN), 0);
});
