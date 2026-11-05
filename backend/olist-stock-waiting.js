// Vendas do site que a Olist ainda não baixou, de uma cor (sincronização Olist → site).
//
// O estoque do site é o disponível na Olist menos as vendas do site que a Olist ainda não
// registrou. A venda do site fica na lista (sold) até o pedido ser enviado ou passar uma
// semana, mas a Olist costuma baixar a peça poucos minutos depois da venda. Descontar a
// venda de novo deixava o site com uma peça a menos que a Olist até o envio.
//
// Por isso cada conferência guarda o que viu (olist = disponível, sold = vendas do site na
// lista, pend = quantas dessas ainda não estavam baixadas) e a seguinte compara: o quanto o
// disponível da Olist caiu desde então é venda do site que a Olist baixou. Reposição na
// Olist (o disponível sobe) não conta como baixa. Sem conferência anterior, vale a regra
// segura: desconta todas as vendas do site, menos as reservadas na Olist.

function count(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function known(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function olistWaitingSales({ sold, available, reserved = 0, prev = null } = {}) {
    const total = count(sold);
    if (!total) return 0;
    let waiting = total;
    if (prev && known(prev.olist) && known(prev.sold)) {
        // As que já aguardavam (um pedido que saiu da lista leva a parte dele), mais as
        // vendas novas, menos o que a Olist baixou desde a última conferência.
        const before = Math.min(count(prev.pend), count(prev.sold), total);
        const fresh = Math.max(0, total - count(prev.sold));
        const dropped = Math.max(0, count(prev.olist) - count(available));
        waiting = Math.max(0, before + fresh - dropped);
    }
    // O que a Olist reservou também já está registrado lá.
    return Math.min(waiting, Math.max(0, total - count(reserved)));
}

module.exports = { olistWaitingSales };
