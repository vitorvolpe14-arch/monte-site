// Testes das vendas do site que a Olist ainda não baixou (backend/olist-stock-waiting.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { olistWaitingSales } = require("../backend/olist-stock-waiting.js");

test("sem venda do site aguardando, nada a descontar", () => {
    assert.equal(olistWaitingSales({ sold: 0, available: 3, reserved: 0, prev: { olist: 3, sold: 1, pend: 1 } }), 0);
});

test("sem conferência anterior: desconta a venda, menos o reservado (como antes)", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 2, reserved: 0, prev: null }), 1);
    assert.equal(olistWaitingSales({ sold: 2, available: 2, reserved: 1, prev: null }), 1);
    assert.equal(olistWaitingSales({ sold: 1, available: 2, reserved: 3, prev: null }), 0);
    // Conferência no formato antigo (sem "sold") ou que deu erro (sem "olist").
    assert.equal(olistWaitingSales({ sold: 1, available: 1, reserved: 0, prev: { olist: 1, pend: 1 } }), 1);
    assert.equal(olistWaitingSales({ sold: 1, available: 1, reserved: 0, prev: { olist: null, sold: 1, pend: 0 } }), 1);
});

test("venda nova que a Olist ainda não baixou: desconta", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 2, reserved: 0, prev: { olist: 2, sold: 0, pend: 0 } }), 1);
});

test("Bag Cambridge caramelo: a Olist já baixou a venda (2 → 1), o site não desconta de novo", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 1, reserved: 0, prev: { olist: 2, sold: 0, pend: 0 } }), 0);
});

test("a Olist baixa depois: para de descontar na conferência seguinte", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 1, reserved: 0, prev: { olist: 2, sold: 1, pend: 1 } }), 0);
});

test("venda já baixada na Olist continua baixada nas conferências seguintes", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 1, reserved: 0, prev: { olist: 1, sold: 1, pend: 0 } }), 0);
});

test("reposição na Olist não conta como venda baixada", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 5, reserved: 0, prev: { olist: 2, sold: 1, pend: 1 } }), 1);
});

test("duas vendas e a Olist baixou uma", () => {
    assert.equal(olistWaitingSales({ sold: 2, available: 2, reserved: 0, prev: { olist: 3, sold: 0, pend: 0 } }), 1);
    assert.equal(olistWaitingSales({ sold: 2, available: 1, reserved: 0, prev: { olist: 2, sold: 2, pend: 1 } }), 0);
});

test("venda nova quando outra já estava baixada", () => {
    assert.equal(olistWaitingSales({ sold: 2, available: 1, reserved: 0, prev: { olist: 1, sold: 1, pend: 0 } }), 1);
});

test("pedido enviado sai da lista e leva a parte dele", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 3, reserved: 0, prev: { olist: 3, sold: 2, pend: 2 } }), 1);
    assert.equal(olistWaitingSales({ sold: 0, available: 1, reserved: 0, prev: { olist: 1, sold: 1, pend: 1 } }), 0);
});

test("reservado na Olist é venda registrada lá (nunca desconta mais que vendido − reservado)", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 2, reserved: 1, prev: { olist: 2, sold: 1, pend: 1 } }), 0);
});

test("nunca negativo nem maior que o vendido", () => {
    assert.equal(olistWaitingSales({ sold: 1, available: 0, reserved: 0, prev: { olist: 5, sold: 0, pend: 0 } }), 0);
    assert.equal(olistWaitingSales({ sold: 1, available: 2, reserved: 0, prev: { olist: 2, sold: 1, pend: 4 } }), 1);
});
