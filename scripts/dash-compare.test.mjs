// Testes da comparação da Visão geral com o mesmo período do mês anterior (dash-compare.js).
// Rodar: node --test scripts/*.test.mjs
process.env.TZ = "America/Sao_Paulo";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../dash-compare.js");

const d = (y, m, day, h = 0, min = 0) => new Date(y, m - 1, day, h, min);
const br = t => new Date(t).toLocaleDateString("pt-BR");
const range = (from, to, now) => {
    const p = C.previousMonthRange(from, to, now);
    return { from: br(p.from), to: br(p.to), start: p.start, end: p.end };
};

test("mês até hoje: as mesmas datas do mês anterior, até o mesmo horário", () => {
    const now = d(2026, 11, 5, 15, 30);
    const p = range(d(2026, 11, 1), d(2026, 11, 5), now);
    assert.equal(p.from, "01/10/2026");
    assert.equal(p.to, "05/10/2026");
    assert.equal(p.start, d(2026, 10, 1).getTime());
    assert.equal(p.end, d(2026, 10, 5, 15, 30).getTime());
});

test("período que já terminou: o último dia do anterior entra inteiro", () => {
    const p = range(d(2026, 10, 10), d(2026, 10, 20), d(2026, 11, 5, 9));
    assert.equal(p.from, "10/09/2026");
    assert.equal(p.to, "20/09/2026");
    assert.equal(p.end, d(2026, 9, 21).getTime());
});

test("um dia só: o mesmo dia do mês anterior", () => {
    const p = range(d(2026, 10, 15), d(2026, 10, 15), d(2026, 11, 5));
    assert.equal(p.from, "15/09/2026");
    assert.equal(p.to, "15/09/2026");
});

test("mês inteiro compara com o mês anterior inteiro", () => {
    let p = range(d(2026, 11, 1), d(2026, 11, 30), d(2026, 12, 3));
    assert.equal(p.from, "01/10/2026");
    assert.equal(p.to, "31/10/2026");
    p = range(d(2026, 3, 1), d(2026, 3, 31), d(2026, 4, 2));
    assert.equal(p.from, "01/02/2026");
    assert.equal(p.to, "28/02/2026");
    p = range(d(2028, 3, 1), d(2028, 3, 31), d(2028, 4, 2));
    assert.equal(p.to, "29/02/2028", "ano bissexto");
});

test("dia que não existe no mês anterior vira o último dia", () => {
    const p = range(d(2026, 3, 1), d(2026, 3, 30), d(2026, 3, 30, 11));
    assert.equal(p.to, "28/02/2026");
    assert.equal(p.end, d(2026, 2, 28, 11).getTime());
});

test("janeiro compara com dezembro do ano anterior", () => {
    const p = range(d(2027, 1, 1), d(2027, 1, 5), d(2027, 1, 5, 8));
    assert.equal(p.from, "01/12/2026");
    assert.equal(p.to, "05/12/2026");
});

test("período atravessando dois meses: um mês antes", () => {
    const p = range(d(2026, 10, 15), d(2026, 11, 5), d(2026, 11, 5, 18));
    assert.equal(p.from, "15/09/2026");
    assert.equal(p.to, "05/10/2026");
});

test("período maior que um mês volta o necessário para não se sobrepor", () => {
    const p = range(d(2026, 9, 1), d(2026, 10, 31), d(2026, 11, 5));
    assert.equal(p.from, "01/07/2026");
    assert.equal(p.to, "31/08/2026");
    assert.ok(p.end <= d(2026, 9, 1).getTime());
});

test("subiu, caiu ou igual", () => {
    assert.equal(C.trend(1500, 1000), "up");
    assert.equal(C.trend(800, 1000), "down");
    assert.equal(C.trend(1000, 1000), "flat");
    assert.equal(C.trend(0, 0), "flat");
    assert.equal(C.trend(3, 0), "up");
    assert.equal(C.trend(0, 3), "down");
    assert.equal(C.trend(1000.01, 1000), "up", "um centavo a mais já é mais");
    assert.equal(C.trend(300 / 3, 100), "flat", "ticket médio: conta em centavos");
    assert.equal(C.trend(null, undefined), "flat");
});
