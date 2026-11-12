/* =====================================================
   CONTAS DOS GRÁFICOS DO PAINEL (sem desenho)
   Usado por admin-charts.js e testado em scripts/chart-data.test.mjs.
   - days: a série diária do Analytics em números (AAAA-MM-DD).
   - weeks: semanas de 7 dias contadas a partir do dia mais recente,
     com a média de visitantes por dia (a semana incompleta não parece menor).
   - weekdays: média de visitantes de cada dia da semana, de segunda a domingo.
   - funnel: cada etapa do funil com a parte da primeira e da anterior.
   - cumulative: faturamento acumulado dia a dia a partir do início do período.
===================================================== */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.ChartData = api;
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";
    const DAY_MS = 86400000;
    const num = v => Number(v) || 0;

    function days(series) {
        return (Array.isArray(series) ? series : [])
            .filter(x => x && /^\d{4}-\d{2}-\d{2}/.test(String(x.date || "")))
            .map(x => {
                const visitors = num(x.visitors), purchases = num(x.purchases);
                return {
                    date: String(x.date).slice(0, 10), visitors, pageViews: num(x.pageViews), purchases, revenue: num(x.revenue),
                    conversion: visitors ? purchases / visitors * 100 : 0
                };
            })
            .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    }

    function weeks(list) {
        const out = [];
        for (let end = list.length; end > 0; end -= 7) {
            const g = list.slice(Math.max(0, end - 7), end), sum = k => g.reduce((n, d) => n + d[k], 0);
            out.unshift({
                first: g[0], last: g[g.length - 1], n: g.length, visitors: sum("visitors"), pageViews: sum("pageViews"),
                purchases: sum("purchases"), revenue: sum("revenue"), daily: sum("visitors") / g.length, week: true
            });
        }
        return out;
    }

    // Segunda (1) a domingo (0). O dia da semana vem da data, ao meio-dia (sem pular de dia pelo fuso).
    const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
    function weekdays(list) {
        const acc = new Map(WEEK_ORDER.map(wd => [wd, { weekday: wd, n: 0, visitors: 0, purchases: 0 }]));
        list.forEach(d => {
            const wd = new Date(d.date + "T12:00:00").getDay(), a = acc.get(wd);
            a.n++; a.visitors += d.visitors; a.purchases += d.purchases;
        });
        return WEEK_ORDER.map(wd => {
            const a = acc.get(wd);
            return { ...a, avg: a.n ? a.visitors / a.n : 0, conversion: a.visitors ? a.purchases / a.visitors * 100 : 0 };
        });
    }

    function funnel(steps) {
        const list = (Array.isArray(steps) ? steps : []).map(s => ({ label: s.label, value: Math.max(0, num(s.value)) }));
        const first = list.length ? list[0].value : 0;
        return list.map((s, i) => ({
            ...s,
            ofFirst: first ? s.value / first * 100 : 0,
            ofPrev: i === 0 ? 100 : (list[i - 1].value ? s.value / list[i - 1].value * 100 : 0)
        }));
    }

    // Um valor por dia (0 = o dia do início): o total vendido do início até o fim daquele dia.
    function cumulative(sales, start, dayCount) {
        const n = Math.max(0, Math.floor(num(dayCount))), perDay = new Array(n).fill(0);
        (Array.isArray(sales) ? sales : []).forEach(s => {
            const i = Math.floor((num(s.time) - start) / DAY_MS);
            if (i >= 0 && i < n) perDay[i] += num(s.total);
        });
        let run = 0;
        return perDay.map(v => Math.round((run += v) * 100) / 100);
    }

    return { days, weeks, weekdays, funnel, cumulative, WEEK_ORDER };
});
