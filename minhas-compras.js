/* Minhas Compras (antes ficava dentro do HTML; a CSP não aceita mais). */
const form = document.getElementById("purchaseLookup");
const result = document.getElementById("purchaseResult");
const errorBox = document.getElementById("purchaseError");

const orderFromEmail = new URLSearchParams(window.location.search).get("order_nsu");
if (orderFromEmail) {
    document.getElementById("purchaseOrder").value = orderFromEmail;
}

function money(v) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v || 0));
}
function date(v) {
    return v ? new Date(v).toLocaleString("pt-BR") : "—";
}
function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, m => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[m]));
}
function statusLabel(s) {
    return ({
        pending: "Aguardando pagamento",
        expired: "Pagamento não concluído",
        paid: "Pagamento confirmado",
        processing: "Pedido em preparação",
        shipped: "Pedido enviado",
        delivered: "Pedido entregue"
    })[s] || s || "Em atualização";
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.textContent = "";
    result.hidden = true;

    const order = document.getElementById("purchaseOrder").value.trim();
    const email = document.getElementById("purchaseEmail").value.trim().toLowerCase();

    try {
        const response = await fetch("/api/minhas-compras?order_nsu=" + encodeURIComponent(order) + "&email=" + encodeURIComponent(email), {
            headers: { "Accept": "application/json" }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Não foi possível consultar o pedido.");

        const o = data.order;
        const discount = Math.round((Number(o.subtotal || 0) + Number(o.shipping || 0) - Number(o.total || 0)) * 100) / 100;
        const items = (o.items || []).map(item => `
            <div class="purchase-item">
                <div>
                    <strong>${esc(item.product_name)}</strong>
                    <span>${esc(item.variant_color || "Sem cor")} · ${Number(item.quantity)} unidade(s)</span>
                </div>
                <strong>${money(item.total_price)}</strong>
            </div>`).join("");

        const tracking = o.tracking_code
            ? `
                <div class="tracking-card">
                    <p class="section-label">RASTREIO</p>
                    <h2>Seu pedido está a caminho</h2>
                    <p>${esc(o.shipping_carrier || o.shipping_service_name || "Transportadora")}</p>
                    <div class="tracking-code">${esc(o.tracking_code)}</div>
                    ${o.tracking_url ? `<a class="tracking-button" href="${esc(o.tracking_url)}" target="_blank" rel="noopener">ACOMPANHAR ENTREGA</a>` : ""}
                </div>`
            : `
                <div class="tracking-card tracking-pending">
                    <p class="section-label">RASTREIO</p>
                    <h2>Rastreio ainda não disponível</h2>
                    <p>Assim que o pedido for postado e o código for cadastrado, ele aparecerá aqui.</p>
                </div>`;

        setHTML(result, `
            <div class="purchase-header">
                <div>
                    <p class="section-label">PEDIDO</p>
                    <h2>${esc(o.order_code||o.order_nsu)}</h2>
                    <p>Realizado em ${date(o.created_at)}</p>
                </div>
                <span class="purchase-status">${esc(statusLabel(o.status))}</span>
            </div>

            <div class="purchase-timeline">
                <div class="${["paid","processing","shipped","delivered"].includes(o.status) ? "done" : ""}"><span>1</span><small>Pagamento</small></div>
                <div class="${["processing","shipped","delivered"].includes(o.status) ? "done" : ""}"><span>2</span><small>Preparação</small></div>
                <div class="${["shipped","delivered"].includes(o.status) ? "done" : ""}"><span>3</span><small>Enviado</small></div>
                <div class="${o.status === "delivered" ? "done" : ""}"><span>4</span><small>Entregue</small></div>
            </div>

            <div class="purchase-columns">
                <div class="purchase-panel">
                    <h3>Produtos</h3>
                    ${items || "<p>Nenhum item registrado.</p>"}
                </div>
                <div class="purchase-panel">
                    <h3>Resumo</h3>
                    <p>Subtotal <strong>${money(o.subtotal)}</strong></p>
                    ${discount > 0 ? `<p>Desconto Pix <strong>-${money(discount)}</strong></p>` : ""}
                    <p>Frete <strong>${money(o.shipping)}</strong></p>
                    <p class="purchase-total">Total <strong>${money(o.total)}</strong></p>
                </div>
            </div>

            ${tracking}
        `);
        result.hidden = false;
        result.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
        errorBox.textContent = error.message;
    }
});
