// Visão geral do painel: comparação com o mesmo período do mês anterior (de 01/11 a 05/11 → de 01/10 a 05/10)
// e se o número subiu, caiu ou ficou igual. Roda no navegador (painel) e no Node (testes).
(function (root) {
    "use strict";

    const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();

    // A mesma data k meses antes. O dia que não existe no mês (31/03 → fevereiro) vira o último dia;
    // com endOfMonth, o último dia do mês continua sendo o último (30/11 → 31/10), para um mês
    // inteiro comparar com o mês anterior inteiro.
    function monthsBefore(date, k, endOfMonth) {
        const y = date.getFullYear(), m = date.getMonth() - k, max = lastDay(y, m);
        const isLast = date.getDate() === lastDay(date.getFullYear(), date.getMonth());
        return new Date(y, m, endOfMonth && isLast ? max : Math.min(date.getDate(), max));
    }

    // from e to: os dias do período (os dois inclusos); now: agora.
    // Devolve as datas do período anterior e o intervalo em milissegundos (start incluso, end não).
    // Período maior que um mês volta quantos meses precisar para não se sobrepor ao atual.
    // Quando o período termina hoje, o anterior para no mesmo horário de agora: o dia de hoje
    // ainda não acabou e não deve ser comparado com um dia inteiro.
    function previousMonthRange(from, to, now) {
        let k = 1, pFrom, pTo;
        do { pFrom = monthsBefore(from, k, false); pTo = monthsBefore(to, k, true); k++; } while (pTo >= from);
        const today = now.getFullYear() === to.getFullYear() && now.getMonth() === to.getMonth() && now.getDate() === to.getDate();
        const end = today
            ? new Date(pTo.getFullYear(), pTo.getMonth(), pTo.getDate(), now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds())
            : new Date(pTo.getFullYear(), pTo.getMonth(), pTo.getDate() + 1);
        return { from: pFrom, to: pTo, start: pFrom.getTime(), end: end.getTime() };
    }

    // "up" (subiu), "down" (caiu) ou "flat" (igual), em centavos: o ticket médio é uma divisão.
    function trend(cur, prev) {
        const c = Math.round(Number(cur || 0) * 100), p = Math.round(Number(prev || 0) * 100);
        return c > p ? "up" : c < p ? "down" : "flat";
    }

    const api = { monthsBefore, previousMonthRange, trend };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.DashCompare = api;
})(typeof self !== "undefined" ? self : this);
