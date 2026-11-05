// Vendas da Olist na Visão geral do painel (backend/sql/vendas-olist.sql).
//
// Transforma um pedido da API v3 da Olist (lista GET /pedidos e detalhe GET /pedidos/{id})
// no resumo guardado em olist_sales, sem dados pessoais da cliente. Os pedidos que o
// próprio site criou na Olist (número do e-commerce MONTE-... ou o id guardado no pedido
// do site) ficam com from_site = true: o painel já conta esses pelos pedidos do site.
// O painel (admin.js) usa a mesma lista de situações para decidir o que é venda.

// Situações que contam como venda: 1 faturada, 3 aprovada, 4 preparando envio, 5 enviada,
// 6 entregue, 7 pronto para envio. Não contam: 0 aberta, 2 cancelada, 8 dados incompletos,
// 9 não entregue, 10 em devolução.
const OLIST_SALE_SITUATIONS = [1, 3, 4, 5, 6, 7];

function text(value) {
    return value === undefined || value === null ? "" : String(value).trim();
}

// "2026-10-08", "2026-10-08 14:06:00" ou "08/10/2026" → "2026-10-08".
function olistSaleDate(value) {
    const t = text(value);
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + "-" + m[2] + "-" + m[3];
    m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    return m ? m[3] + "-" + m[2] + "-" + m[1] : null;
}

// 514, "514.00", "1234.5" ou "1.234,56" → número com centavos.
function olistMoney(value) {
    if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
    const t = text(value).replace(/[^\d,.-]/g, "");
    const normalized = /,\d{1,2}$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
    const n = Number(normalized);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function intOrNull(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Um pedido da lista → linha de olist_sales (sem itens: eles vêm do detalhe).
function olistSaleSummary(order, siteOlistIds = new Set()) {
    const ecommerce = order?.ecommerce || {};
    const numeroEcommerce = text(ecommerce.numeroPedidoEcommerce ?? order?.numeroPedidoEcommerce).slice(0, 80) || null;
    const transportador = order?.transportador || {};
    return {
        id: Number(order.id),
        numero: intOrNull(order.numeroPedido),
        data: olistSaleDate(order.dataCriacao || order.data),
        situacao: intOrNull(order.situacao),
        total: olistMoney(order.valor ?? order.valorTotalPedido),
        origem: intOrNull(order.origemPedido),
        canal: text(ecommerce.canalVenda || ecommerce.nome).slice(0, 80) || null,
        numero_ecommerce: numeroEcommerce,
        envio: text(transportador?.formaEnvio?.nome || transportador?.nome).slice(0, 80) || null,
        from_site: (numeroEcommerce || "").toUpperCase().startsWith("MONTE-") || siteOlistIds.has(String(order.id))
    };
}

function name(value) {
    return text(value && typeof value === "object" ? value.nome ?? value.descricao : value);
}

// Detalhe do pedido → itens e meio de pagamento.
function olistSaleDetail(detail) {
    const itens = (Array.isArray(detail?.itens) ? detail.itens : []).slice(0, 60).map(item => ({
        sku: text(item?.produto?.sku).slice(0, 60) || null,
        descricao: text(item?.produto?.descricao).slice(0, 160) || "Produto",
        quantidade: Number(item?.quantidade) > 0 ? Number(item.quantidade) : 1,
        valor: olistMoney(item?.valorUnitario)
    }));
    const pagamento = detail?.pagamento || {};
    const parcelas = Array.isArray(pagamento.parcelas) ? pagamento.parcelas : [];
    const parcela = parcelas[0] || {};
    const meio = [pagamento.meioPagamento, pagamento.formaRecebimento, parcela.meioPagamento, parcela.formaRecebimento].map(name).find(Boolean) || "";
    // Como foi pago (para estimar a taxa da maquininha): forma, meio, condição e parcelas.
    // Só nomes e números; as observações das parcelas ficam de fora.
    const short = v => name(v).slice(0, 60) || null;
    const pagamentoInfo = {
        forma: short(pagamento.formaRecebimento),
        meio: short(pagamento.meioPagamento),
        condicao: text(pagamento.condicaoPagamento).slice(0, 60) || null,
        parcelas: parcelas.length,
        meios_parcelas: [...new Set(parcelas.flatMap(p => [short(p?.meioPagamento), short(p?.formaRecebimento)]).filter(Boolean))].slice(0, 5),
        dias: parcelas.slice(0, 12).map(p => intOrNull(p?.dias))
    };
    return { id: Number(detail.id), itens, pagamento: meio.slice(0, 60) || null, pagamento_info: pagamentoInfo };
}

// A lista de pedidos da Olist (a primeira página) é relida no máximo a cada 4 minutos: a leitura
// automática roda de 5 em 5 minutos e pega a venda lançada na Olist nesse tempo. fresh = o botão
// ATUALIZAR DA OLIST (ou o painel ao abrir), que relê na hora; full = leitura completa em andamento.
const OLIST_SALES_LIST_EVERY_MS = 4 * 60 * 1000;

function olistSalesListNow({ listedAt = null, now = Date.now(), fresh = false, full = false } = {}) {
    if (full || fresh) return true;
    return now - (Date.parse(listedAt || "") || 0) >= OLIST_SALES_LIST_EVERY_MS;
}

module.exports = { OLIST_SALE_SITUATIONS, OLIST_SALES_LIST_EVERY_MS, olistSaleDate, olistMoney, olistSaleSummary, olistSaleDetail, olistSalesListNow };
