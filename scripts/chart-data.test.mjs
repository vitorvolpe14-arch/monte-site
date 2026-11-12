// Testes das contas dos gráficos do painel (chart-data.js).
// Rodar: node --test scripts/*.test.mjs
process.env.TZ = "America/Sao_Paulo";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../chart-data.js");

const serie = (from, values) => values.map((v, i) => {
    const d = new Date(from + "T12:00:00"); d.setDate(d.getDate() + i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { date, visitors: v, pageViews: v * 3, purchases: v >= 100 ? 1 : 0, revenue: v >= 100 ? 500 : 0 };
});

test("days: números, ordem por data, conversão do dia e linhas sem data de fora", () => {
    const d = C.days([{ date: "2026-11-02", visitors: "50", purchases: 1 }, { date: "", visitors: 9 }, { date: "2026-11-01", visitors: 0 }]);
    assert.deepEqual(d.map(x => x.date), ["2026-11-01", "2026-11-02"]);
    assert.equal(d[1].visitors, 50);
    assert.equal(d[1].conversion, 2);
    assert.equal(d[0].conversion, 0);
});

test("weeks: semanas a partir do dia mais recente, com a média por dia", () => {
    const d = C.days(serie("2026-11-01", [10, 10, 10, 70, 70, 70, 70, 70, 70, 70]));
    const w = C.weeks(d);
    assert.equal(w.length, 2);
    assert.equal(w[1].n, 7);
    assert.equal(w[1].visitors, 490);
    assert.equal(w[1].daily, 70);
    assert.equal(w[0].n, 3);
    assert.equal(w[0].daily, 10, "a semana incompleta usa a média dos dias que tem");
    assert.equal(w[1].last.date, "2026-11-10");
});

test("weekdays: segunda a domingo, média por dia e conversão", () => {
    // 2026-11-02 é segunda-feira; duas semanas inteiras.
    const d = C.days(serie("2026-11-02", [100, 20, 20, 20, 20, 60, 80, 120, 20, 20, 20, 20, 60, 80]));
    const w = C.weekdays(d);
    assert.deepEqual(w.map(x => x.weekday), [1, 2, 3, 4, 5, 6, 0]);
    assert.equal(w[0].n, 2);
    assert.equal(w[0].avg, 110);
    assert.equal(w[0].conversion, 2 / 220 * 100);
    assert.equal(w[6].avg, 80, "domingo é o último");
});

test("weekdays: dia da semana sem nenhum dia no período fica zerado", () => {
    const w = C.weekdays(C.days(serie("2026-11-02", [10, 20])));
    assert.equal(w[0].n, 1);
    assert.equal(w[2].n, 0);
    assert.equal(w[2].avg, 0);
});

test("funnel: parte da primeira etapa e da anterior", () => {
    const f = C.funnel([{ label: "Visitas", value: 1000 }, { label: "Carrinho", value: 100 }, { label: "Checkout", value: 25 }, { label: "Pagos", value: 10 }]);
    assert.deepEqual(f.map(x => x.ofFirst), [100, 10, 2.5, 1]);
    assert.deepEqual(f.map(x => x.ofPrev), [100, 10, 25, 40]);
});

test("funnel: etapa anterior zerada não divide por zero", () => {
    const f = C.funnel([{ label: "Visitas", value: 0 }, { label: "Pagos", value: 3 }]);
    assert.equal(f[1].ofFirst, 0);
    assert.equal(f[1].ofPrev, 0);
});

test("cumulative: soma dia a dia desde o início; fora do período não entra", () => {
    const start = new Date(2026, 10, 1).getTime(), at = (day, h) => new Date(2026, 10, day, h).getTime();
    const c = C.cumulative([{ time: at(1, 10), total: 100 }, { time: at(1, 23), total: 50 }, { time: at(3, 9), total: 200 }, { time: at(5, 9), total: 999 }, { time: at(0, 9), total: 7 }], start, 4);
    assert.deepEqual(c, [150, 150, 350, 350]);
});
