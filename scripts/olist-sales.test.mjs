// Testes do resumo das vendas da Olist para a Visão geral (backend/olist-sales.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OLIST_SALE_SITUATIONS, OLIST_SALES_LIST_EVERY_MS, olistSaleDate, olistMoney, olistSaleSummary, olistSaleDetail, olistSalesListNow } = require("../backend/olist-sales.js");

test("data do pedido em vários formatos", () => {
    assert.equal(olistSaleDate("2026-10-08"), "2026-10-08");
    assert.equal(olistSaleDate("2026-10-08 14:06:00"), "2026-10-08");
    assert.equal(olistSaleDate("08/10/2026"), "2026-10-08");
    assert.equal(olistSaleDate(""), null);
    assert.equal(olistSaleDate(null), null);
});

test("valor em reais", () => {
    assert.equal(olistMoney(514), 514);
    assert.equal(olistMoney("514.00"), 514);
    assert.equal(olistMoney("1234.5"), 1234.5);
    assert.equal(olistMoney("1.234,56"), 1234.56);
    assert.equal(olistMoney("R$ 89,90"), 89.9);
    assert.equal(olistMoney(""), 0);
    assert.equal(olistMoney(null), 0);
});

test("venda feita fora do site (PDV)", () => {
    const row = olistSaleSummary({
        id: 900123, numeroPedido: 57, situacao: 1, dataCriacao: "2026-11-02", valor: "389.00", origemPedido: 1,
        ecommerce: { id: null, nome: null, numeroPedidoEcommerce: null },
        cliente: { nome: "Cliente da loja", cpfCnpj: "123.456.789-00", email: "x@y.z" },
        transportador: { formaEnvio: { id: 1, nome: "Retirada" } }
    });
    assert.deepEqual(row, {
        id: 900123, numero: 57, data: "2026-11-02", situacao: 1, total: 389, origem: 1,
        canal: null, numero_ecommerce: null, envio: "Retirada", from_site: false
    });
    // Nenhum dado pessoal da cliente vai para o banco.
    assert.ok(!JSON.stringify(row).includes("123.456.789-00"));
    assert.ok(!JSON.stringify(row).includes("Cliente da loja"));
});

test("pedido que o site criou na Olist não conta como fora do site", () => {
    assert.equal(olistSaleSummary({ id: 1, situacao: 3, ecommerce: { numeroPedidoEcommerce: "MONTE-1730000000000-abc" } }).from_site, true);
    assert.equal(olistSaleSummary({ id: 2, situacao: 3, ecommerce: { numeroPedidoEcommerce: "monte-123" } }).from_site, true);
    // Pelo id guardado no pedido do site, mesmo sem o número do e-commerce.
    assert.equal(olistSaleSummary({ id: 777, situacao: 3, ecommerce: {} }, new Set(["777"])).from_site, true);
    assert.equal(olistSaleSummary({ id: 778, situacao: 3, ecommerce: { numeroPedidoEcommerce: "MLB-99" , nome: "Mercado Livre"} }, new Set(["777"])).from_site, false);
});

test("canal de venda informado na Olist", () => {
    assert.equal(olistSaleSummary({ id: 3, ecommerce: { nome: "Mercado Livre", canalVenda: "" } }).canal, "Mercado Livre");
    assert.equal(olistSaleSummary({ id: 4, ecommerce: { nome: "Loja X", canalVenda: "Instagram" } }).canal, "Instagram");
});

test("itens e pagamento do detalhe", () => {
    const d = olistSaleDetail({
        id: 900123,
        itens: [
            { produto: { id: 1, sku: "MT-100-P", descricao: "Bolsa Paris Preta" }, quantidade: 2, valorUnitario: "389.00" },
            { produto: { id: 2, sku: "", descricao: "" }, quantidade: 0, valorUnitario: null }
        ],
        pagamento: { formaRecebimento: { id: 5, nome: "Pix" }, parcelas: [] }
    });
    assert.deepEqual(d, {
        id: 900123,
        itens: [
            { sku: "MT-100-P", descricao: "Bolsa Paris Preta", quantidade: 2, valor: 389 },
            { sku: null, descricao: "Produto", quantidade: 1, valor: 0 }
        ],
        pagamento: "Pix",
        pagamento_info: { forma: "Pix", meio: null, condicao: null, parcelas: 0, meios_parcelas: [], dias: [] }
    });
    // Cartão na maquininha em 3x: guarda a condição e as parcelas, sem as observações.
    const c = olistSaleDetail({
        id: 2,
        pagamento: {
            formaRecebimento: { id: 9, nome: "INFINITY CREDITO-DEBITO" },
            meioPagamento: { id: 3, nome: "Cartão de crédito" },
            condicaoPagamento: "30 60 90",
            parcelas: [1, 2, 3].map(n => ({ dias: n * 30, valor: 163, observacoes: "Cliente Fulana CPF 000", meioPagamento: { nome: "Cartão de crédito" }, formaRecebimento: { nome: "INFINITY CREDITO-DEBITO" } }))
        }
    });
    assert.equal(c.pagamento, "Cartão de crédito");
    assert.deepEqual(c.pagamento_info, { forma: "INFINITY CREDITO-DEBITO", meio: "Cartão de crédito", condicao: "30 60 90", parcelas: 3, meios_parcelas: ["Cartão de crédito", "INFINITY CREDITO-DEBITO"], dias: [30, 60, 90] });
    assert.ok(!JSON.stringify(c).includes("Fulana"));
    assert.equal(olistSaleDetail({ id: 1, pagamento: { meioPagamento: "Cartão de crédito" } }).pagamento, "Cartão de crédito");
    assert.equal(olistSaleDetail({ id: 1, pagamento: { parcelas: [{ formaRecebimento: { nome: "Dinheiro" } }] } }).pagamento, "Dinheiro");
    assert.equal(olistSaleDetail({ id: 1 }).pagamento, null);
});

test("situações que contam como venda", () => {
    assert.deepEqual(OLIST_SALE_SITUATIONS, [1, 3, 4, 5, 6, 7]);
    [0, 2, 8, 9, 10].forEach(s => assert.ok(!OLIST_SALE_SITUATIONS.includes(s)));
});

test("quando reler a lista de pedidos da Olist", () => {
    const now = Date.parse("2026-11-05T13:51:00Z");
    const ago = ms => new Date(now - ms).toISOString();
    // Leitura automática: a cada execução de 5 em 5 minutos, nunca mais de uma vez no intervalo.
    assert.ok(OLIST_SALES_LIST_EVERY_MS <= 5 * 60 * 1000);
    assert.equal(olistSalesListNow({ listedAt: ago(5 * 60 * 1000), now }), true);
    assert.equal(olistSalesListNow({ listedAt: ago(60 * 1000), now }), false);
    assert.equal(olistSalesListNow({ listedAt: null, now }), true);
    // Botão ATUALIZAR DA OLIST (e o painel ao abrir): relê na hora, mesmo lida há pouco.
    assert.equal(olistSalesListNow({ listedAt: ago(60 * 1000), now, fresh: true }), true);
    // Leitura completa em andamento: sempre lê.
    assert.equal(olistSalesListNow({ listedAt: ago(1000), now, full: true }), true);
});
