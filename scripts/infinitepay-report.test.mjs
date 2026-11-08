// Testes do relatório de vendas da InfinitePay: leitura do PDF (infinitepay-report.js), cruzamento
// com as vendas registradas e as regras de importação do servidor (backend/infinitepay-report-import.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../infinitepay-report.js");
const I = require("../backend/infinitepay-report-import.js");

// Monta um PDF no mesmo formato do relatório da InfinitePay (wkhtmltopdf): fonte Type0 com
// Identity-H e mapa ToUnicode, um glifo por "Td <código> Tj", texto de cabeça para baixo (cm).
function makePdf(lines, created = "D:20261031225707Z") {
    const chars = [...new Set(lines.map(l => l.s).join(""))];
    const code = new Map(chars.map((c, i) => [c, i + 1]));
    const hex = n => n.toString(16).toUpperCase().padStart(4, "0");
    let content = "/GSa gs\nq 0.75 0 0 -0.75 0 595 cm\n";
    for (const l of lines) {
        content += `BT\n/F1 10 Tf 1 0 0 -1 0 0 Tm\n${l.x} ${-l.y} Td <${hex(code.get(l.s[0]))}> Tj\n`;
        for (const c of l.s.slice(1)) content += `5 0 Td <${hex(code.get(c))}> Tj\n`;
        content += "ET\n";
    }
    content += "Q\n";
    const toUni = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
        `${chars.length} beginbfchar\n` + chars.map(c => `<${hex(code.get(c))}> <${hex(c.charCodeAt(0))}>`).join("\n") + "\nendbfchar\nendcmap\nend\nend\n";
    const flate = s => zlib.deflateSync(Buffer.from(s, "latin1"));
    const objs = [];
    objs[1] = Buffer.from(`<<\n/Creator (wkhtmltopdf)\n/CreationDate (${created})\n>>`, "latin1");
    objs[2] = Buffer.from("<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>", "latin1");
    objs[3] = Buffer.from("<<\n/Type /Page\n/Parent 2 0 R\n/Contents 4 0 R\n/Resources 5 0 R\n/MediaBox [0 0 842 595]\n>>", "latin1");
    const c = flate(content);
    objs[4] = Buffer.concat([Buffer.from(`<<\n/Length 9 0 R\n/Filter /FlateDecode\n>>\nstream\n`, "latin1"), c, Buffer.from("\nendstream", "latin1")]);
    objs[5] = Buffer.from("<<\n/Font <<\n/F1 6 0 R\n>>\n>>", "latin1");
    objs[6] = Buffer.from("<< /Type /Font\n/Subtype /Type0\n/BaseFont /CeraPro-Medium\n/Encoding /Identity-H\n/DescendantFonts [7 0 R]\n/ToUnicode 8 0 R>>", "latin1");
    objs[7] = Buffer.from("<< /Type /Font\n/Subtype /CIDFontType2\n/BaseFont /CeraPro-Medium\n/CIDToGIDMap /Identity\n>>", "latin1");
    const t = flate(toUni);
    objs[8] = Buffer.concat([Buffer.from(`<<\n/Length ${t.length}\n/Filter /FlateDecode\n>>\nstream\n`, "latin1"), t, Buffer.from("\nendstream", "latin1")]);
    objs[9] = Buffer.from(String(c.length), "latin1");
    objs[10] = Buffer.from("<<\n/Type /Catalog\n/Pages 2 0 R\n>>", "latin1");
    const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
    const offsets = [];
    let pos = parts[0].length;
    for (let n = 1; n < objs.length; n++) {
        offsets[n] = pos;
        const b = Buffer.concat([Buffer.from(`${n} 0 obj\n`, "latin1"), objs[n], Buffer.from("\nendobj\n", "latin1")]);
        parts.push(b);
        pos += b.length;
    }
    const xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") +
        `trailer\n<<\n/Size ${objs.length}\n/Info 1 0 R\n/Root 10 0 R\n>>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(Buffer.from(xref, "latin1"));
    return new Uint8Array(Buffer.concat(parts));
}

const at = (x, y, s) => ({ x, y, s });
const HEADER = [
    at(20, 10, "Relatório de Vendas"), at(20, 20, "01/10/2026 - 31/10/2026"),
    at(20, 40, "Total em vendas"), at(20, 48, "R$ 1.012,00"),
    at(400, 36, "Total em vendas"), at(480, 36, "R$ 1.012,00"),
    at(400, 44, "Total em taxas aplicadas"), at(480, 44, "R$ 35,36"),
    at(400, 52, "Total a receber no período"), at(480, 52, "R$ 976,64"),
    at(20, 60, "Data e hora"), at(90, 60, "Meio"), at(150, 60, "Tipo"), at(220, 60, "Identificador"), at(350, 60, "Status"),
    at(440, 60, "Valor (R$)"), at(500, 60, "Líquido (R$)"), at(560, 60, "Taxa Aplicada"), at(620, 60, "Plano")
];
const ROWS = [
    // Link de pagamento 3x, taxa em duas linhas.
    at(20, 80, "28 Out, 2026 ·"), at(20, 90, "13:01"), at(90, 80, "Crédito"), at(90, 90, "3x"), at(150, 85, "Link de Pagamento"),
    at(220, 85, "302673"), at(350, 85, "Aprovada"), at(440, 85, "+ 504,00"), at(500, 85, "+ 468,67"), at(560, 80, "R$ - 35,33"),
    at(562, 90, "(7.01%)"), at(620, 85, "1 Dia Útil"),
    // Pix na conta, data e hora na mesma linha.
    at(20, 115, "28 Out, 2026 · 17:01"), at(90, 110, "Pix"), at(90, 120, "À Vista"), at(150, 115, "Conta Inteligente"),
    at(220, 115, "E0036030520261028200095b7a5c5624"), at(350, 115, "Aprovada"), at(440, 115, "+ 506,00"), at(500, 115, "+ 506,00"),
    at(560, 115, "0,00 (0%)"), at(620, 115, "Outro"),
    // Negada: fica fora dos totais.
    at(20, 140, "27 Out, 2026 ·"), at(20, 150, "10:00"), at(90, 140, "Crédito"), at(90, 150, "10x"), at(150, 145, "Link Integrado"),
    at(220, 145, "000000"), at(350, 145, "Negada"), at(440, 145, "+ 453,24"), at(500, 145, "+ 453,24"), at(560, 145, "0,00 (0%)"),
    at(620, 145, "1 Dia Útil"),
    // InfiniteTap: o tipo ocupa três linhas (nome da maquininha).
    at(150, 165, "InfiniteTap"), at(20, 175, "27 Out, 2026 · 11:32"), at(90, 170, "Débito"), at(90, 180, "À Vista"), at(150, 175, "MV: SAMUEL"),
    at(150, 185, "VITOR VOLPATO"), at(220, 175, "5RzGSQ"), at(350, 175, "Aprovada"), at(440, 175, "+ 2,00"), at(500, 175, "+ 1,97"),
    at(560, 175, "R$ - 0,03 (1.5%)"), at(620, 175, "1 Dia Útil"),
    at(20, 300, "A Central de Ajuda está disponível todos os dias pelo chat no app"), at(600, 300, "Página 1 de 1")
];

test("lê o relatório: período, totais e cada transação", async () => {
    const rep = await R.readInfinitePayReport(makePdf(HEADER.concat(ROWS)));
    assert.deepEqual(rep.unread, []);
    assert.deepEqual(rep.summary, { from: "2026-10-01", to: "2026-10-31", total: 1012, fees: 35.36, net: 976.64, created: "2026-10-31T22:57:07.000Z" });
    assert.equal(rep.rows.length, 4);
    assert.deepEqual(rep.rows[0], {
        data: "2026-10-28", hora: "13:01", meio: "Crédito", tipo: "Link de Pagamento", identificador: "302673", parcelas: 3,
        status: "Aprovada", valor: 504, liquido: 468.67, taxa: 35.33, taxa_percentual: 7.01, plano: "1 Dia Útil"
    });
    assert.deepEqual(rep.rows[1], {
        data: "2026-10-28", hora: "17:01", meio: "Pix", tipo: "Conta Inteligente", identificador: "E0036030520261028200095b7a5c5624", parcelas: 1,
        status: "Aprovada", valor: 506, liquido: 506, taxa: 0, taxa_percentual: 0, plano: "Outro"
    });
    assert.equal(rep.rows[2].status, "Negada");
    assert.equal(rep.rows[2].parcelas, 10);
    assert.deepEqual([rep.rows[3].tipo, rep.rows[3].meio, rep.rows[3].identificador, rep.rows[3].taxa, rep.rows[3].liquido], ["InfiniteTap", "Débito", "5RzGSQ", 0.03, 1.97]);
    assert.equal(rep.check.ok, true);
    assert.equal(rep.check.approved, 3);
});

test("relatório com uma linha errada não confere", async () => {
    const wrong = ROWS.map(r => (r.s === "+ 468,67" ? { ...r, s: "+ 468,76" } : r));
    const rep = await R.readInfinitePayReport(makePdf(HEADER.concat(wrong)));
    assert.equal(rep.check.ok, false);
    assert.equal(rep.check.got.net, 976.73);
});

test("arquivo que não é PDF", async () => {
    await assert.rejects(R.readInfinitePayReport(new TextEncoder().encode("não é um pdf")), /não é um PDF/);
});

test("mapa ToUnicode com faixas (bfrange com lista e sequência)", () => {
    const cmap = R.parseCMap("1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfrange\n<0001> <0003> [<0054> <006F> <00E9>]\n<0010> <0012> <0041>\nendbfrange");
    assert.equal(cmap.bytes, 2);
    assert.deepEqual([1, 2, 3, 16, 17, 18].map(c => cmap.map.get(c)), ["T", "o", "é", "A", "B", "C"]);
});

test("linhas iguais no mesmo relatório ganham número de ordem", () => {
    const row = { data: "2026-10-01", hora: "13:01", tipo: "Link de Pagamento", meio: "Crédito", parcelas: 1, valor: 454, identificador: "000000" };
    assert.deepEqual(R.numberRows([row, row, { ...row, hora: "13:02" }]).map(r => r.n), [0, 1, 0]);
});

test("cruzamento: site pela hora, loja pelo valor e dia", () => {
    const tx = (data, hora, tipo, valor) => ({ data, hora, tipo, meio: "Crédito", valor });
    const transactions = [
        tx("2026-11-04", "09:16", "Link Integrado", 977.6),          // pedido do site pago às 12:16 UTC
        tx("2026-10-14", "10:32", "Link de Pagamento", 513.7),        // na Olist 513,71
        tx("2026-10-10", "17:37", "Link de Pagamento", 489),          // 489 + 504 = venda de 993
        tx("2026-10-10", "11:54", "Link de Pagamento", 504),
        tx("2026-10-21", "08:51", "Conta Inteligente", 45),           // sem venda na Olist
        tx("2026-10-20", "10:00", "Link de Pagamento", 300),          // venda lançada 2 dias depois
        tx("2026-10-20", "10:05", "Link de Pagamento", 300)           // a mesma venda não serve duas vezes
    ];
    const sales = [
        { site: true, time: Date.parse("2026-11-04T12:16:27Z"), amount: 977.6, ref: "site" },
        { site: false, day: "2026-10-14", amount: 513.71, ref: "180" },
        { site: false, day: "2026-10-10", amount: 993, ref: "176" },
        { site: false, day: "2026-10-22", amount: 300, ref: "190" },
        { site: false, day: "2026-10-09", amount: 958, ref: "178" }   // sem cobrança igual
    ];
    const m = R.matchTransactions(transactions, sales);
    assert.deepEqual(m.txSale, [0, 1, 2, 2, -1, 3, -1]);
    assert.deepEqual(m.txKind, ["exato", "centavos", "dividido", "dividido", null, "exato", null]);
    assert.deepEqual(m.saleTx[4], []);
});

test("cruzamento: pagamento do site com valor igual mas longe da hora não vale como exato", () => {
    const m = R.matchTransactions(
        [{ data: "2026-10-08", hora: "14:08", tipo: "Link Integrado", valor: 963 }],
        [{ site: true, time: Date.parse("2026-10-12T17:08:57Z"), amount: 963 }]
    );
    assert.deepEqual(m.txSale, [-1]);
});

test("servidor: confere cada linha antes de gravar", () => {
    const row = { data: "2026-10-28", hora: "13:01", meio: "Crédito", tipo: "Link de Pagamento", identificador: "302673", parcelas: 3, status: "Aprovada", valor: 504, liquido: 468.67, taxa: 35.33, taxa_percentual: 7.01, plano: "1 Dia Útil", n: 0 };
    assert.deepEqual(I.sanitizeReportRow(row), row);
    assert.equal(I.reportRowKey(row), "2026-10-28|13:01|Link de Pagamento|Crédito|3|504.00|302673|0");
    assert.equal(I.sanitizeReportRow({ ...row, data: "2026-02-30" }), null);
    assert.equal(I.sanitizeReportRow({ ...row, hora: "25:00" }), null);
    assert.equal(I.sanitizeReportRow({ ...row, identificador: "<script>" }), null);
    assert.equal(I.sanitizeReportRow({ ...row, tipo: "x".repeat(41) }), null);
    assert.equal(I.sanitizeReportRow({ ...row, valor: "abc" }), null);
    assert.equal(I.sanitizeReportRow({ ...row, parcelas: 0 }), null);
    assert.equal(I.sanitizeReportRow({ ...row, status: "" }), null);
    assert.deepEqual(I.sanitizeReportRow({ ...row, identificador: null, hora: null, taxa_percentual: null }).identificador, null);
});

test("servidor: até quando o relatório confere", () => {
    // Gerado às 19:57 de 04/11 (horário de Brasília), no último dia do período.
    assert.equal(I.reportUntil({ to: "2026-11-04", created: "2026-11-04T22:57:07Z" }), "2026-11-04T22:57:07.000Z");
    // Gerado depois do período: vale o dia inteiro.
    assert.equal(I.reportUntil({ to: "2026-10-31", created: "2026-11-04T22:57:07Z" }), "2026-11-01T02:59:59.000Z");
    assert.equal(I.reportUntil({ to: "2026-10-31", created: null }), "2026-11-01T02:59:59.000Z");
});

test("servidor: junta os períodos conferidos", () => {
    const a = { from: "2019-01-01", to: "2026-11-04", until: "2026-11-04T22:57:07.000Z" };
    assert.deepEqual(I.mergeCoverage([a], { from: "2026-11-01", to: "2026-11-10", until: "2026-11-10T20:00:00.000Z" }), [{ from: "2019-01-01", to: "2026-11-10", until: "2026-11-10T20:00:00.000Z" }]);
    assert.deepEqual(I.mergeCoverage([a], { from: "2026-11-05", to: "2026-11-06", until: "x" }), [{ from: "2019-01-01", to: "2026-11-06", until: "x" }]);
    assert.deepEqual(I.mergeCoverage([a], { from: "2026-12-01", to: "2026-12-05", until: "y" }).length, 2);
    assert.deepEqual(I.mergeCoverage([a], { from: "2026-10-01", to: "2026-10-31", until: "z" }), [a]);
});

test("servidor: soma das aprovadas", () => {
    const rows = [{ status: "Aprovada", valor: "504.00", taxa: "35.33", liquido: "468.67" }, { status: "Negada", valor: 453.24, taxa: 0, liquido: 453.24 }, { status: "Aprovada", valor: 0.1, taxa: 0, liquido: 0.2 }];
    assert.deepEqual(I.reportTotals(rows), { approved: 2, total: 504.1, fees: 35.33, net: 468.87 });
});

// ---------- Relatório de movimentações (extrato da conta) ----------
// Mesmo layout do extrato do app: um cabeçalho por dia, a data só na primeira movimentação do
// dia, "Saldo do dia" no fim de cada dia, a fatura do cartão em duas linhas e com "--R$".
const STATEMENT = [
    at(16, 55, "Relatório de movimentações"), at(16, 78, "01 Nov, 2026 - 08 Nov, 2026"), at(760, 78, "Valor em R$"),
    at(16, 96, "Saldo ﬁnal do período"), at(421, 97, "Saldo inicial"), at(778, 97, "+ 8.512,52"),
    at(16, 114, "R$ 4.099,03"), at(421, 118, "Total de entradas"), at(779, 118, "+ 4.124,03"),
    at(421, 139, "Total de saídas"), at(781, 139, "- 8.537,52"),
    at(421, 160, "Saldo ﬁnal do período"), at(775, 160, "+ 4.099,03"),
    at(13, 198, "Data"), at(97, 198, "Hora"), at(164, 198, "Tipo de transação"), at(299, 198, "Nome"), at(568, 198, "Detalhe"), at(788, 198, "Valor (R$)"),
    at(13, 222, "02 Nov, 2026"), at(97, 222, "08:25"), at(164, 222, "Pix"), at(299, 222, "Pix FULANA DE TAL"), at(568, 222, "Enviado"), at(793, 222, "-8.512,52"),
    at(97, 246, "12:31"), at(164, 246, "Pix"), at(299, 246, "Pix CICLANA"), at(568, 246, "Recebido"), at(798, 246, "+528,01"),
    at(164, 270, "Saldo do dia"), at(795, 270, "+ 528,01"),
    at(13, 303, "Data"), at(97, 303, "Hora"), at(164, 303, "Tipo de transação"), at(299, 303, "Nome"), at(568, 303, "Detalhe"), at(788, 303, "Valor (R$)"),
    at(13, 327, "05 Nov, 2026"), at(97, 327, "00:45"), at(164, 327, "Depósito de vendas"), at(299, 327, "Vendas"), at(568, 327, "Depósito InﬁnitePay"), at(791, 327, "+2.069,76"),
    at(164, 351, "Fatura de cartão de"), at(97, 357, "09:20"), at(299, 357, "Fatura • Nov 2026"), at(568, 357, "Pago"), at(787, 357, "--R$ 25,00"), at(164, 363, "crédito"),
    at(97, 387, "10:00"), at(164, 387, "Pix"), at(299, 387, "Pix BELTRANA"), at(568, 387, "Recebido"), at(796, 387, "+508,05"),
    at(97, 411, "13:13"), at(164, 411, "Pix"), at(299, 411, "Pix OUTRA PESSOA"), at(568, 411, "Recebido"), at(805, 411, "+27,91"),
    at(97, 435, "23:50"), at(164, 435, "Pix"), at(299, 435, "Pix MAIS UMA"), at(568, 435, "Recebido"), at(797, 435, "+489,08"),
    at(164, 459, "Saldo do dia"), at(789, 459, "+ 3.597,81"),
    at(13, 492, "Data"), at(97, 492, "Hora"), at(164, 492, "Tipo de transação"), at(299, 492, "Nome"), at(568, 492, "Detalhe"), at(788, 492, "Valor (R$)"),
    at(13, 516, "06 Nov, 2026"), at(97, 516, "00:54"), at(164, 516, "Depósito de vendas"), at(299, 516, "Vendas"), at(568, 516, "Depósito InﬁnitePay"), at(798, 516, "+501,22"),
    at(164, 540, "Saldo do dia"), at(786, 540, "+ 4.099,03"),
    at(8, 583, "A Central de Ajuda está disponível todos os dias pelo chat no app"), at(785, 583, "Página 1 de 1")
];

test("extrato: período, totais e cada movimentação, sem os nomes", async () => {
    const st = await R.readInfinitePayPdf(makePdf(STATEMENT, "D:20261108223553+00'00'"));
    assert.equal(st.kind, "statement");
    assert.deepEqual(st.unread, []);
    assert.deepEqual(st.summary, { from: "2026-11-01", to: "2026-11-08", created: "2026-11-08T22:35:53.000Z", opening: 8512.52, inflow: 4124.03, outflow: 8537.52, closing: 4099.03 });
    assert.equal(st.check.ok, true);
    assert.deepEqual(st.rows.map(r => [r.data, r.hora, r.tipo, r.detalhe, r.valor]), [
        ["2026-11-02", "08:25", "Pix", "Enviado", -8512.52],
        ["2026-11-02", "12:31", "Pix", "Recebido", 528.01],
        ["2026-11-05", "00:45", "Depósito de vendas", "Depósito InfinitePay", 2069.76],
        ["2026-11-05", "09:20", "Fatura de cartão de crédito", "Pago", -25],
        ["2026-11-05", "10:00", "Pix", "Recebido", 508.05],
        ["2026-11-05", "13:13", "Pix", "Recebido", 27.91],
        ["2026-11-05", "23:50", "Pix", "Recebido", 489.08],
        ["2026-11-06", "00:54", "Depósito de vendas", "Depósito InfinitePay", 501.22]
    ]);
    assert.ok(st.rows.every(r => !JSON.stringify(r).includes("FULANA") && !JSON.stringify(r).includes("Fatura •")));
    // Só a fatura sai do que fica na conta; o Pix enviado é retirada; o resto já está nas vendas.
    assert.deepEqual(st.rows.map(R.statementKind), ["withdrawal", "sale", "sale", "payment", "sale", "sale", "sale", "sale"]);
});

test("extrato com uma movimentação errada não confere", async () => {
    const st = await R.readInfinitePayPdf(makePdf(STATEMENT.map(r => (r.s === "+27,91" ? { ...r, s: "+27,19" } : r))));
    assert.equal(st.check.ok, false);
});

test("o mesmo leitor reconhece o Relatório de Vendas", async () => {
    const rep = await R.readInfinitePayPdf(makePdf(HEADER.concat(ROWS)));
    assert.equal(rep.kind, "sales");
    assert.equal(rep.check.ok, true);
});

test("tipo de cada movimentação do extrato", () => {
    const k = (tipo, detalhe, valor) => R.statementKind({ tipo, detalhe, valor });
    assert.equal(k("Boleto", "Pago", -120), "payment");
    assert.equal(k("Tarifa", "Cobrada", -2.5), "payment");
    assert.equal(k("Transferência", "Enviada", -300), "withdrawal");
    assert.equal(k("Rendimento", "Recebido", 1.2), "other");
});

test("servidor: extrato confere e troca as movimentações do mesmo período", () => {
    const summary = I.sanitizeStatementSummary({ from: "2026-11-01", to: "2026-11-08", created: "2026-11-08T22:35:53.000Z", count: 3, opening: 100, inflow: 528.01, outflow: 125, closing: 503.01 });
    assert.ok(summary);
    const rows = [
        { data: "2026-11-02", hora: "08:25", tipo: "Pix", detalhe: "Enviado", valor: -100 },
        { data: "2026-11-02", hora: "12:31", tipo: "Pix", detalhe: "Recebido", valor: 528.01 },
        { data: "2026-11-05", hora: "09:20", tipo: "Fatura de cartão de crédito", detalhe: "Pago • Nov", valor: -25 }
    ].map(I.sanitizeStatementRow);
    assert.equal(rows[2].detalhe, "Pago Nov");
    assert.equal(I.statementMatches(summary, rows), true);
    assert.equal(I.statementMatches(summary, rows.slice(1)), false);
    assert.equal(I.sanitizeStatementRow({ data: "2026-11-02", hora: "25:00", tipo: "Pix", valor: 1 }), null);
    assert.equal(I.sanitizeStatementRow({ data: "2026-11-02", tipo: "Pix", valor: 0 }), null);
    const old = { ranges: [{ from: "2026-10-01", to: "2026-10-31", until: "2026-10-31T23:59:59.000Z" }], moves: [
        { data: "2026-10-30", hora: "10:00", tipo: "Boleto", detalhe: "Pago", valor: -10 },
        { data: "2026-11-03", hora: "10:00", tipo: "Boleto", detalhe: "Pago", valor: -99 }
    ] };
    const next = I.mergeStatement(old, summary, rows, "2026-11-08T23:00:00.000Z");
    assert.deepEqual(next.ranges, [{ from: "2026-10-01", to: "2026-11-08", until: "2026-11-08T22:35:53.000Z" }]);
    assert.deepEqual(next.moves.map(m => m.valor), [-10, -100, 528.01, -25]);
    assert.equal(next.last.imported_at, "2026-11-08T23:00:00.000Z");
});
