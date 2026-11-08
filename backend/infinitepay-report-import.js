// Importação do "Relatório de Vendas" da InfinitePay (o painel lê o PDF e envia as linhas).
// Aqui ficam as regras que o servidor aplica antes de gravar: conferir cada linha, montar a
// chave da transação e juntar os períodos que já foram conferidos com um relatório.
// Sem dados pessoais: o relatório só traz data, meio, tipo, código da transação e valores.

const DAY_MS = 24 * 60 * 60 * 1000;
const TEXT = /^[\p{L}\p{N} .:/()+-]{1,40}$/u;
const IDENT = /^[A-Za-z0-9-]{1,64}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const validDate = s => typeof s === "string" && YMD.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z")) && new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s;
const amount = v => {
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) > 10000000) return null;
    return Math.round(n * 100) / 100;
};
const label = v => {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v).normalize("NFKC").replace(/\s+/g, " ").trim();
    return TEXT.test(s) ? s : undefined;
};

// Uma linha do relatório, já lida pelo painel. Devolve null se algo estiver fora do formato.
function sanitizeReportRow(row) {
    if (!row || typeof row !== "object") return null;
    if (!validDate(row.data)) return null;
    const hora = row.hora === null || row.hora === undefined ? null : String(row.hora);
    if (hora !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return null;
    const meio = label(row.meio), tipo = label(row.tipo), status = label(row.status), plano = label(row.plano);
    if (meio === undefined || tipo === undefined || plano === undefined || !status) return null;
    const ident = row.identificador === null || row.identificador === undefined || row.identificador === "" ? null : String(row.identificador);
    if (ident !== null && !IDENT.test(ident)) return null;
    const parcelas = Number(row.parcelas ?? 1);
    if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 24) return null;
    const valor = amount(row.valor), liquido = amount(row.liquido), taxa = amount(row.taxa ?? 0);
    if (valor === null || liquido === null || taxa === null) return null;
    let pct = row.taxa_percentual;
    if (pct === null || pct === undefined || pct === "") pct = null;
    else {
        pct = Number(pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
        pct = Math.round(pct * 100) / 100;
    }
    const n = Number(row.n ?? 0);
    if (!Number.isInteger(n) || n < 0 || n > 999) return null;
    return { data: row.data, hora, meio, tipo, identificador: ident, parcelas, status, valor, liquido, taxa, taxa_percentual: pct, plano, n };
}

// A mesma transação tem a mesma chave em relatórios diferentes (o status pode mudar: uma
// venda aprovada que depois é estornada é atualizada, não duplicada). "n" separa linhas
// idênticas dentro do mesmo relatório.
function reportRowKey(row) {
    return [row.data, row.hora || "", row.tipo || "", row.meio || "", row.parcelas, row.valor.toFixed(2), row.identificador || "", row.n || 0].join("|");
}

// Data (AAAA-MM-DD) no horário de Brasília.
function brDate(ms) {
    return new Date(ms - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Até quando o relatório confere: a hora em que foi gerado, se for no último dia do período;
// senão o fim do último dia.
function reportUntil(summary) {
    const endOfDay = Date.parse(summary.to + "T23:59:59-03:00");
    const created = Date.parse(summary.created || "");
    if (Number.isFinite(created) && brDate(created) === summary.to && created < endOfDay) return new Date(created).toISOString();
    return new Date(endOfDay).toISOString();
}

function sanitizeSummary(s) {
    if (!s || typeof s !== "object") return null;
    if (!validDate(s.from) || !validDate(s.to) || s.from > s.to) return null;
    const count = Number(s.count);
    if (!Number.isInteger(count) || count < 1 || count > 100000) return null;
    const created = s.created && Number.isFinite(Date.parse(s.created)) ? new Date(Date.parse(s.created)).toISOString() : null;
    const total = amount(s.total), fees = amount(s.fees), net = amount(s.net);
    return { from: s.from, to: s.to, created, count, total, fees, net };
}

// Junta os períodos já conferidos (um relatório novo pode cobrir só uma parte).
function mergeCoverage(ranges, next) {
    const list = (Array.isArray(ranges) ? ranges : []).filter(r => r && validDate(r.from) && validDate(r.to)).concat(next ? [next] : []);
    list.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const out = [];
    for (const r of list) {
        const last = out[out.length - 1];
        const touches = last && Date.parse(r.from + "T12:00:00Z") - Date.parse(last.to + "T12:00:00Z") <= DAY_MS;
        if (!touches) { out.push({ from: r.from, to: r.to, until: r.until }); continue; }
        if (r.to > last.to) { last.to = r.to; last.until = r.until; }
        else if (r.to === last.to && String(r.until || "") > String(last.until || "")) last.until = r.until;
    }
    return out;
}

// Soma das aprovadas, para conferir com os totais do relatório.
function reportTotals(rows) {
    const ok = rows.filter(r => r.status === "Aprovada");
    const sum = k => Math.round(ok.reduce((a, r) => a + Math.round(Number(r[k]) * 100), 0)) / 100;
    return { approved: ok.length, total: sum("valor"), fees: sum("taxa"), net: sum("liquido") };
}

// ---------- Relatório de movimentações (extrato da conta) ----------
// Guardado no kv_store_48db9b7e ("infinitepay_statement"): os períodos conferidos, o resumo do
// último extrato e cada movimentação (data, hora, tipo, detalhe e valor, sem o nome de quem
// pagou ou recebeu). O painel desconta do líquido o que foi pago com o saldo (fatura do cartão...).

const MAX_STATEMENT_MOVES = 20000;
// Texto livre do extrato ("Fatura de cartão de crédito", "Depósito InfinitePay"): fica só o
// que é letra, número e pontuação simples.
const freeText = v => {
    if (v === null || v === undefined) return null;
    const s = String(v).normalize("NFKC").replace(/[^\p{L}\p{N} .:/()+-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    return s || null;
};

function sanitizeStatementRow(row) {
    if (!row || typeof row !== "object" || !validDate(row.data)) return null;
    const hora = row.hora === null || row.hora === undefined ? null : String(row.hora);
    if (hora !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return null;
    const tipo = freeText(row.tipo), detalhe = freeText(row.detalhe), valor = amount(row.valor);
    if (!tipo || valor === null || valor === 0) return null;
    return { data: row.data, hora, tipo, detalhe, valor };
}

function sanitizeStatementSummary(s) {
    if (!s || typeof s !== "object") return null;
    if (!validDate(s.from) || !validDate(s.to) || s.from > s.to) return null;
    const count = Number(s.count);
    if (!Number.isInteger(count) || count < 1 || count > 5000) return null;
    const created = s.created && Number.isFinite(Date.parse(s.created)) ? new Date(Date.parse(s.created)).toISOString() : null;
    const opening = amount(s.opening), inflow = amount(s.inflow), outflow = amount(s.outflow), closing = amount(s.closing);
    if ([opening, inflow, outflow, closing].some(v => v === null)) return null;
    return { from: s.from, to: s.to, created, count, opening, inflow, outflow, closing };
}

// As movimentações batem com os totais do extrato? (entradas, saídas e saldo final)
function statementMatches(summary, rows) {
    const c = v => Math.round(Number(v) * 100);
    const inflow = rows.filter(r => r.valor > 0).reduce((a, r) => a + c(r.valor), 0);
    const outflow = rows.filter(r => r.valor < 0).reduce((a, r) => a - c(r.valor), 0);
    return rows.length === summary.count && inflow === c(summary.inflow) && outflow === c(summary.outflow) &&
        c(summary.opening) + inflow - outflow === c(summary.closing);
}

// Junta o extrato novo ao que já estava gravado: as movimentações do período dele trocam as antigas.
function mergeStatement(state, summary, rows, now) {
    const old = Array.isArray(state && state.moves) ? state.moves : [];
    const moves = old.filter(m => m && (m.data < summary.from || m.data > summary.to)).concat(rows)
        .sort((a, b) => a.data.localeCompare(b.data) || String(a.hora || "").localeCompare(String(b.hora || "")))
        .slice(-MAX_STATEMENT_MOVES);
    return {
        ranges: mergeCoverage(state && state.ranges, { from: summary.from, to: summary.to, until: reportUntil(summary) }),
        last: { ...summary, imported_at: now },
        moves
    };
}

module.exports = {
    sanitizeReportRow, reportRowKey, reportUntil, sanitizeSummary, mergeCoverage, reportTotals, brDate,
    sanitizeStatementRow, sanitizeStatementSummary, statementMatches, mergeStatement
};
