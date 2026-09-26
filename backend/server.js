// MONTÊ backend — alterações de frontend acompanham este serviço.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const cors = require("cors");
const sharp = require("sharp");
require("dotenv").config();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

/* =====================================================
   CONFIGURAÇÕES
   Fluxo atual: MONTÊ → InfinitePay → Supabase → painel admin.
===================================================== */

const SITE_URL =
    process.env.SITE_URL ||
    "https://monte-site-itjk.onrender.com";

const INFINITEPAY_API =
    "https://api.checkout.infinitepay.io/links";

const INFINITEPAY_HANDLE =
    process.env.INFINITEPAY_HANDLE ||
    "monte-64839705-0z9";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://uvrhougaurupvkxmezwy.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPERFRETE_API_URL = process.env.SUPERFRETE_API_URL || "https://api.superfrete.com";
const SUPERFRETE_TOKEN = process.env.SUPERFRETE_TOKEN;
const SUPERFRETE_ORIGIN_CEP = String(process.env.SUPERFRETE_ORIGIN_CEP || "60183680").replace(/\D/g, "");
const SUPERFRETE_USER_AGENT = process.env.SUPERFRETE_USER_AGENT || "MONTÊ/1.0 (vitorvolpe14@gmail.com)";
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v23.0";
const WHATSAPP_PHONE_NUMBER_ID = safeString(process.env.WHATSAPP_PHONE_NUMBER_ID);
const WHATSAPP_ACCESS_TOKEN = safeString(process.env.WHATSAPP_ACCESS_TOKEN);
const WHATSAPP_TEMPLATE_NAME = safeString(process.env.WHATSAPP_TEMPLATE_NAME || "monte_rastreio");
const WHATSAPP_TEMPLATE_LANGUAGE = safeString(process.env.WHATSAPP_TEMPLATE_LANGUAGE || "pt_BR");
const WHATSAPP_ADMIN_PHONE = safeString(process.env.WHATSAPP_ADMIN_PHONE);
const WHATSAPP_ADMIN_TEMPLATE_NAME = safeString(process.env.WHATSAPP_ADMIN_TEMPLATE_NAME || "monte_nova_venda");
const WHATSAPP_ADMIN_TEMPLATE_LANGUAGE = safeString(process.env.WHATSAPP_ADMIN_TEMPLATE_LANGUAGE || "pt_BR");

const RESEND_API_KEY = safeString(process.env.RESEND_API_KEY);
const RESEND_FROM_EMAIL = safeString(process.env.RESEND_FROM_EMAIL || "contato@oficialmontee.com.br");
const RESEND_MARKETING_FROM_EMAIL = safeString(process.env.RESEND_MARKETING_FROM_EMAIL || "mkt@oficialmontee.com.br");
const RESEND_FROM_NAME = safeString(process.env.RESEND_FROM_NAME || "MONTÊ");
const ORDER_NOTIFICATION_EMAILS = safeString(process.env.ORDER_NOTIFICATION_EMAILS);
const PIX_KEY = safeString(process.env.PIX_KEY).replace(/[^0-9A-Za-z@._+\-]/g, "");
const PIX_MERCHANT_NAME = safeString(process.env.PIX_MERCHANT_NAME || "MONTE").slice(0, 25);
const PIX_MERCHANT_CITY = safeString(process.env.PIX_MERCHANT_CITY || "FORTALEZA").slice(0, 15);
function pixField(id, value) { const str = String(value ?? ""); return String(id).padStart(2, "0") + String(str.length).padStart(2, "0") + str; }
function crc16Pix(payload) {
    let crc = 0xFFFF;
    for (let i = 0; i < payload.length; i++) {
        crc ^= payload.charCodeAt(i) << 8;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, "0");
}
function buildPixPayload(amount, txid = "***") {
    if (!PIX_KEY) throw new Error("PIX_KEY não configurada no servidor.");
    const merchantAccount = pixField(0, "BR.GOV.BCB.PIX") + pixField(1, PIX_KEY);
    const additionalData = pixField(5, String(txid).replace(/[^A-Za-z0-9*]/g, "").slice(0, 25) || "***");
    const body = [
        pixField(0, "01"), pixField(26, merchantAccount), pixField(52, "0000"),
        pixField(53, "986"), pixField(54, Number(amount).toFixed(2)), pixField(58, "BR"),
        pixField(59, PIX_MERCHANT_NAME), pixField(60, PIX_MERCHANT_CITY), pixField(62, additionalData)
    ].join("") + "6304";
    return body + crc16Pix(body);
}


async function sendWhatsAppTrackingNotification(order) {
    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
        return { sent: false, status: "not_configured", message_id: null };
    }

    let phone = String(order.customer_whatsapp || order.customer_phone || "").replace(/\D/g, "");
    // Meta expects the country code. Accept both 5585... and local 85... formats.
    if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
    const trackingCode = safeString(order.tracking_code);
    const trackingUrl = safeString(order.tracking_url);
    if (phone.length < 10 || !trackingCode) {
        return { sent: false, status: "invalid_recipient_or_tracking", message_id: null };
    }

    const firstName = safeString(order.customer_name).split(/\s+/)[0] || "cliente";
    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const apiUrl = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            type: "template",
            template: {
                name: WHATSAPP_TEMPLATE_NAME,
                language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
                components: [
                    {
                        type: "body",
                        parameters: [
                            { type: "text", text: firstName },
                            { type: "text", text: orderCode },
                            { type: "text", text: trackingCode },
                            { type: "text", text: trackingUrl || "Acompanhe pelo site da MONTÊ." }
                        ]
                    }
                ]
            }
        })
    });

    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }

    if (!response.ok) {
        throw new Error(`WhatsApp API ${response.status}: ${JSON.stringify(data)}`);
    }

    const messageId = data?.messages?.[0]?.id || null;
    return { sent: true, status: "sent", message_id: messageId };
}

function formatWhatsAppCurrency(value) {
    return "R$ " + Number(value || 0).toFixed(2).replace(".", ",");
}

function formatWhatsAppPaymentMethod(method) {
    const value = safeString(method).toLowerCase();
    if (value === "pix") return "Pix";
    if (value === "credit_card" || value === "card") return "Cartão de crédito";
    return value || "Não informado";
}

function formatWhatsAppAddress(address) {
    if (!address || typeof address !== "object") return "Não informado";
    const parts = [
        address.street,
        address.number ? "nº " + address.number : "",
        address.complement,
        address.neighborhood,
        address.city,
        address.state,
        address.cep ? "CEP " + address.cep : ""
    ].filter(Boolean);
    return parts.join(", ") || "Não informado";
}

async function sendWhatsAppAdminNewOrderNotification(order) {
    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN || !WHATSAPP_ADMIN_PHONE) {
        return { sent: false, status: "not_configured", message_id: null };
    }
    if (!order || order.whatsapp_admin_notification_sent_at) {
        return { sent: false, status: "already_sent", message_id: order?.whatsapp_admin_notification_message_id || null };
    }

    let phone = WHATSAPP_ADMIN_PHONE.replace(/\D/g, "");
    if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
    if (phone.length < 12) return { sent: false, status: "invalid_admin_phone", message_id: null };

    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const customerName = safeString(order.customer_name) || "Não informado";
    const customerPhone = safeString(order.customer_phone || order.customer_whatsapp) || "Não informado";
    const cpf = safeString(order.customer_cpf) || "Não informado";
    const products = Array.isArray(order.items) && order.items.length
        ? order.items.map(item => {
            const variant = safeString(item.variant_color || item.color);
            const name = safeString(item.name || item.product_name || item.description) || "Produto";
            const qty = Math.max(1, Number(item.quantity || 1));
            const unit = Number(item.price ?? item.unit_price ?? 0);
            return qty + "x " + name + (variant ? " (" + variant + ")" : "") + " — " + formatWhatsAppCurrency(unit);
        }).join("\n")
        : "Consultar itens no painel administrativo.";
    const customerData = "Tel.: " + customerPhone + "\nCPF: " + cpf + "\nEndereço: " + formatWhatsAppAddress(order.customer_address);
    const apiUrl = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + WHATSAPP_ACCESS_TOKEN,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            type: "template",
            template: {
                name: WHATSAPP_ADMIN_TEMPLATE_NAME,
                language: { code: WHATSAPP_ADMIN_TEMPLATE_LANGUAGE },
                components: [{
                    type: "body",
                    parameters: [
                        { type: "text", text: orderCode },
                        { type: "text", text: customerName },
                        { type: "text", text: products },
                        { type: "text", text: formatWhatsAppPaymentMethod(order.payment_method) },
                        { type: "text", text: formatWhatsAppCurrency(order.total) },
                        { type: "text", text: customerData }
                    ]
                }]
            }
        })
    });

    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }
    if (!response.ok) {
        throw new Error("WhatsApp API " + response.status + ": " + JSON.stringify(data));
    }
    return {
        sent: true,
        status: "sent",
        message_id: data?.messages?.[0]?.id || null
    };
}

function formatOrderCode(value) {
    const raw = safeString(value);
    if (/^\d{4}$/.test(raw)) return "MONTÊ-" + raw;
    if (/^MONTÊ-\d{4}$/i.test(raw)) return "MONTÊ-" + raw.slice(-4);
    return raw;
}

function normalizeOrderCode(value) {
    const raw = safeString(value).trim();
    const match = raw.match(/^MONTÊ-(\d{4})$/i);
    return match ? match[1] : raw;
}

function escapeEmailHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(new RegExp(String.fromCharCode(39), "g"), "&#039;");
}

async function sendOrderConfirmationEmail(order) {
    if (!order?.customer_email || !order?.order_nsu) return { sent: false, status: "invalid_recipient" };
    if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { sent: false, status: "not_configured" };
    const email = safeString(order.customer_email).toLowerCase();
    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const customerName = safeString(order.customer_name).split(/\s+/)[0] || "cliente";
    const total = Number(order.total || 0);
    const purchasesUrl = SITE_URL.replace(/\/$/, "") + "/minhas-compras.html?order_nsu=" + encodeURIComponent(orderCode);
    const html = "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
      "<div style=\"max-width:620px;margin:0 auto;padding:40px 20px;\"><div style=\"background:#111;color:#fff;text-align:center;padding:24px 20px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
      "<div style=\"background:#fff;padding:38px 30px;\"><p style=\"margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#777;\">COMPRA CONFIRMADA</p>" +
      "<h1 style=\"margin:0 0 18px;font-size:28px;font-weight:500;\">Obrigada pela sua compra, " + escapeEmailHtml(customerName) + ".</h1>" +
      "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Seu pagamento foi confirmado e seu pedido já está registrado na MONTÊ.</p>" +
      "<div style=\"margin:28px 0;padding:20px;background:#f7f5f2;\"><p style=\"margin:0 0 8px;font-size:11px;letter-spacing:1.5px;color:#777;\">NÚMERO DO PEDIDO</p><strong style=\"font-size:20px;\">" + escapeEmailHtml(orderCode) + "</strong><p style=\"margin:14px 0 0;font-size:14px;color:#555;\">Total: <strong>R$ " + total.toFixed(2).replace(".", ",") + "</strong></p></div>" +
      "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Acompanhe o status do seu pedido e novas atualizações pela área <strong>Minhas Compras</strong>.</p>" +
      "<div style=\"text-align:center;margin:30px 0;\"><a href=\"" + purchasesUrl + "\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:15px 26px;font-size:13px;letter-spacing:1.5px;\">ACESSAR MINHAS COMPRAS</a></div></div>" +
      "<p style=\"text-align:center;font-size:11px;color:#999;margin:20px 0;\">MONTÊ — Bolsas e acessórios</p></div></body></html>";
    const text = "Compra confirmada na MONTÊ\n\nPedido: " + orderCode + "\nTotal: R$ " + total.toFixed(2).replace(".", ",") + "\n\nAcesse: " + purchasesUrl;
    const idempotencyKey = "monte-order-confirmation-" + String(order.order_nsu);
    const response = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{"Authorization":"Bearer "+RESEND_API_KEY,"Content-Type":"application/json","Accept":"application/json"},
        body:JSON.stringify({
            from:RESEND_FROM_NAME+" <"+RESEND_FROM_EMAIL+">",
            to:[email],
            subject:"MONTÊ — Pedido "+orderCode+" confirmado",
            text, html,
            tags:[{name:"type",value:"order_confirmation"},{name:"order_nsu",value:String(order.order_nsu)}]
        })
    });
    const responseText=await response.text();
    let data={}; try{data=responseText?JSON.parse(responseText):{}}catch{data={raw:responseText};}
    if(!response.ok) throw new Error("Resend API "+response.status+": "+JSON.stringify(data));
    return {sent:true,status:"sent",message_id:data?.id||null,idempotency_key:idempotencyKey};
}
function trackingStatusLabel(status) {
    return ({
        paid: "Pagamento confirmado",
        processing: "Pedido em separação",
        shipped: "Pedido enviado",
        delivered: "Pedido entregue"
    })[status] || status || "Atualização do pedido";
}


async function sendAdminSaleNotificationEmail(order) {
    if (!order?.order_nsu) return { sent: false, status: "invalid_order" };
    if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { sent: false, status: "not_configured" };
    const recipients = ORDER_NOTIFICATION_EMAILS.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
    if (!recipients.length) return { sent: false, status: "no_recipients" };
    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const customerName = safeString(order.customer_name) || "Não informado";
    const customerEmail = safeString(order.customer_email) || "Não informado";
    const customerPhone = safeString(order.customer_phone || order.customer_whatsapp) || "Não informado";
    const paymentMethod = formatWhatsAppPaymentMethod(order.payment_method);
    const address = formatWhatsAppAddress(order.customer_address);
    const total = Number(order.total || 0);
    const items = Array.isArray(order.items) && order.items.length
        ? order.items.map(item => {
            const name = safeString(item.name || item.product_name || item.description) || "Produto";
            const color = safeString(item.variant_color || item.color);
            const qty = Math.max(1, Number(item.quantity || 1));
            const unit = Number(item.price ?? item.unit_price ?? 0);
            return qty + "x " + name + (color ? " (" + color + ")" : "") + " — R$ " + unit.toFixed(2).replace(".", ",");
        }).join("<br>")
        : "Consultar itens do pedido no painel.";
    const html =
        "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
        "<div style=\"max-width:680px;margin:0 auto;padding:32px 18px;\">" +
        "<div style=\"background:#111;color:#fff;text-align:center;padding:22px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
        "<div style=\"background:#fff;padding:30px;\">" +
        "<p style=\"margin:0 0 8px;font-size:11px;letter-spacing:2px;color:#777;\">NOVA VENDA</p>" +
        "<h1 style=\"margin:0 0 22px;font-size:28px;font-weight:500;\">Pagamento confirmado</h1>" +
        "<div style=\"padding:18px;background:#f7f5f2;margin-bottom:20px;\"><strong style=\"font-size:20px;\">" + escapeEmailHtml(orderCode) + "</strong><br><span style=\"font-size:14px;color:#555;\">Total: <strong>R$ " + total.toFixed(2).replace(".", ",") + "</strong></span></div>" +
        "<h3 style=\"font-size:14px;letter-spacing:1px;\">CLIENTE</h3>" +
        "<p style=\"line-height:1.7;font-size:14px;\">Nome: " + escapeEmailHtml(customerName) + "<br>E-mail: " + escapeEmailHtml(customerEmail) + "<br>Telefone: " + escapeEmailHtml(customerPhone) + "<br>Endereço: " + escapeEmailHtml(address) + "</p>" +
        "<h3 style=\"font-size:14px;letter-spacing:1px;\">PRODUTOS</h3>" +
        "<p style=\"line-height:1.8;font-size:14px;\">" + items + "</p>" +
        "<p style=\"font-size:14px;line-height:1.7;\"><strong>Pagamento:</strong> " + escapeEmailHtml(paymentMethod) + "<br><strong>Frete:</strong> R$ " + Number(order.shipping || 0).toFixed(2).replace(".", ",") + "<br><strong>Total:</strong> R$ " + total.toFixed(2).replace(".", ",") + "</p>" +
        "</div><p style=\"text-align:center;font-size:11px;color:#999;margin:18px 0;\">MONTÊ — Notificação interna de venda</p></div></body></html>";
    const text =
        "NOVA VENDA MONTÊ\n\nPedido: " + orderCode + "\nCliente: " + customerName +
        "\nE-mail: " + customerEmail + "\nTelefone: " + customerPhone +
        "\nProdutos: " + (Array.isArray(order.items) ? order.items.map(i => (i.quantity || 1) + "x " + (i.name || i.product_name || "Produto")).join("; ") : "Consultar pedido") +
        "\nPagamento: " + paymentMethod + "\nTotal: R$ " + total.toFixed(2).replace(".", ",");
    const response = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{"Authorization":"Bearer "+RESEND_API_KEY,"Content-Type":"application/json","Accept":"application/json"},
        body:JSON.stringify({from:RESEND_FROM_NAME+" <"+RESEND_FROM_EMAIL+">",to:recipients,subject:"MONTÊ — NOVA VENDA "+orderCode+" — R$ "+total.toFixed(2).replace(".", ","),text,html})
    });
    const responseText=await response.text();
    let data={}; try{data=responseText?JSON.parse(responseText):{}}catch{data={raw:responseText};}
    if(!response.ok) throw new Error("Resend API "+response.status+": "+JSON.stringify(data));
    return {sent:true,status:"sent",message_id:data?.id||null};
}
async function ensureAdminSaleNotificationEmail(order) {
    if (!order || order.admin_sale_email_sent_at) return {sent:false,status:"already_sent"};
    try {
        const result=await sendAdminSaleNotificationEmail(order);
        await supabaseRequest("orders?id=eq."+encodeURIComponent(order.id),{method:"PATCH",body:JSON.stringify({admin_sale_email_status:result.status,admin_sale_email_sent_at:result.sent?new Date().toISOString():null})});
        return result;
    } catch(error) {
        console.error("E-mail interno de nova venda:",error);
        await supabaseRequest("orders?id=eq."+encodeURIComponent(order.id),{method:"PATCH",body:JSON.stringify({admin_sale_email_status:"error"})}).catch(()=>{});
        return {sent:false,status:"error",error:error.message};
    }
}
async function sendOrderTrackingEmail(order) {
    if (!order?.customer_email || !order?.order_nsu) return { sent: false, status: "invalid_recipient", message_id: null };
    if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { sent: false, status: "not_configured", message_id: null };

    const email = safeString(order.customer_email).toLowerCase();
    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const customerName = safeString(order.customer_name).split(/\s+/)[0] || "cliente";
    const status = safeString(order.status).toLowerCase();
    const statusLabel = trackingStatusLabel(status);
    const carrier = safeString(order.shipping_carrier);
    const trackingCode = safeString(order.tracking_code);
    const trackingUrl = safeString(order.tracking_url);
    const purchasesUrl = SITE_URL.replace(/\/$/, "") + "/minhas-compras.html?order_nsu=" + encodeURIComponent(orderCode);
    const total = Number(order.total || 0);

    if (status === "shipped" && !trackingCode) {
        throw new Error("O pedido precisa ter código de rastreio para enviar o e-mail de envio.");
    }

    let shippingBlock = "";
    if (status === "shipped" || status === "delivered") {
        shippingBlock =
            "<div style=\"margin:24px 0;padding:20px;background:#f7f5f2;\">" +
            "<p style=\"margin:0 0 12px;font-size:11px;letter-spacing:1.5px;color:#777;\">DETALHES DA ENTREGA</p>" +
            (carrier ? "<p style=\"margin:7px 0;font-size:14px;\"><strong>Transportadora:</strong> " + escapeEmailHtml(carrier) + "</p>" : "") +
            "<p style=\"margin:7px 0;font-size:14px;\"><strong>Código de rastreio:</strong> " + escapeEmailHtml(trackingCode || "—") + "</p>" +
            (trackingUrl ? "<p style=\"margin:16px 0 0;\"><a href=\"" + trackingUrl.replace(/"/g, "&quot;") + "\" style=\"color:#111;font-size:14px;font-weight:bold;\">ACOMPANHAR ENTREGA</a></p>" : "") +
            "</div>";
    }

    const html =
        "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
        "<div style=\"max-width:620px;margin:0 auto;padding:40px 20px;\">" +
        "<div style=\"background:#111;color:#fff;text-align:center;padding:24px 20px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
        "<div style=\"background:#fff;padding:38px 30px;\">" +
        "<p style=\"margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#777;\">ATUALIZAÇÃO DO PEDIDO</p>" +
        "<h1 style=\"margin:0 0 18px;font-size:28px;font-weight:500;\">Olá, " + escapeEmailHtml(customerName) + ".</h1>" +
        "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Seu pedido <strong>" + escapeEmailHtml(orderCode) + "</strong> foi atualizado.</p>" +
        "<div style=\"margin:24px 0;padding:22px;background:#f7f5f2;text-align:center;\"><p style=\"margin:0 0 8px;font-size:11px;letter-spacing:1.5px;color:#777;\">STATUS ATUAL</p><strong style=\"font-size:21px;\">" + escapeEmailHtml(statusLabel) + "</strong></div>" +
        shippingBlock +
        "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Você pode consultar os detalhes completos do pedido e acompanhar novas atualizações pela área <strong>Minhas Compras</strong>.</p>" +
        "<div style=\"text-align:center;margin:30px 0;\"><a href=\"" + purchasesUrl + "\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:15px 26px;font-size:13px;letter-spacing:1.5px;\">ACESSAR MINHAS COMPRAS</a></div>" +
        "<p style=\"font-size:13px;line-height:1.6;color:#777;\">Total do pedido: <strong>R$ " + total.toFixed(2).replace(".", ",") + "</strong></p>" +
        "</div><p style=\"text-align:center;font-size:11px;color:#999;margin:20px 0;\">MONTÊ — Bolsas e acessórios</p></div></body></html>";

    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
            from: RESEND_FROM_NAME ? RESEND_FROM_NAME + " <" + RESEND_FROM_EMAIL + ">" : RESEND_FROM_EMAIL,
            to: [email],
            subject: "MONTÊ — Pedido " + orderCode + " · " + statusLabel,
            html
        })
    });

    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }
    if (!response.ok) throw new Error("Resend API " + response.status + ": " + JSON.stringify(data));
    return { sent: true, status: "sent", message_id: data?.id || null };
}

async function ensureWhatsAppAdminNewOrderNotification(order) {
    if (!order || order.whatsapp_admin_notification_sent_at) {
        return { sent: false, status: "already_sent", message_id: order?.whatsapp_admin_notification_message_id || null };
    }
    try {
        const result = await sendWhatsAppAdminNewOrderNotification(order);
        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
            method: "PATCH",
            body: JSON.stringify({
                whatsapp_admin_notification_status: result.status,
                whatsapp_admin_notification_sent_at: result.sent ? new Date().toISOString() : null,
                whatsapp_admin_notification_message_id: result.message_id
            })
        });
        return result;
    } catch (error) {
        console.error("WhatsApp nova venda:", error);
        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
            method: "PATCH",
            body: JSON.stringify({ whatsapp_admin_notification_status: "error" })
        }).catch(() => {});
        return { sent: false, status: "error", message_id: null, error: error.message };
    }
}

async function ensureOrderConfirmationEmail(order) {
    if (!order || order.order_confirmation_email_sent_at) return { sent: false, status: "already_sent" };
    try {
        const result = await sendOrderConfirmationEmail(order);
        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
            method: "PATCH",
            body: JSON.stringify({ order_confirmation_email_status: result.status, order_confirmation_email_sent_at: result.sent ? new Date().toISOString() : null })
        });
        return result;
    } catch (error) {
        console.error("E-mail de confirmação do pedido:", error);
        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), { method: "PATCH", body: JSON.stringify({ order_confirmation_email_status: "error" }) }).catch(() => {});
        return { sent: false, status: "error", error: error.message };
    }
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function supabaseRequest(path, options = {}) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
    }

    const startedAt = Date.now();
    const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
            ...(options.headers || {})
        }
    }, 12000);

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
        throw new Error(`Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }

    console.log(`Supabase OK ${response.status} em ${Date.now() - startedAt}ms: ${String(path).slice(0, 140)}`);
    return data;
}

const METROPOLITAN_CITIES = new Set(["AQUIRAZ","CAUCAIA","EUSEBIO","GUAIUBA","ITAITINGA","MARACANAU"]);

function localShippingOption(city, state) {
    const normalized = normalizeCity(city);
    const normalizedState = safeString(state).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    if (normalizedState !== "CE") return null;
    if (normalized === "FORTALEZA") return { id:"monte-fortaleza", name:"Entrega MONTÊ — Fortaleza", price:15, delivery_days:1 };
    if (METROPOLITAN_CITIES.has(normalized)) return { id:"monte-regiao-metropolitana", name:"Entrega MONTÊ — Região Metropolitana", price:20, delivery_days:3 };
    return null;
}

const SHIPPING_DEFAULTS = {
    bolsas: { weight: 0.8, height: 12, width: 25, length: 32 },
    acessorios: { weight: 0.3, height: 8, width: 20, length: 25 }
};

function normalizeShippingProduct(row, quantity) {
    const defaults = SHIPPING_DEFAULTS[String(row.category || "bolsas").toLowerCase()] || SHIPPING_DEFAULTS.bolsas;
    const values = [
        Number(row.shipping_weight_kg),
        Number(row.shipping_height_cm),
        Number(row.shipping_width_cm),
        Number(row.shipping_length_cm)
    ];
    const fallback = [defaults.weight, defaults.height, defaults.width, defaults.length];
    const resolved = values.map((value, index) => (
        Number.isFinite(value) && value > 0 ? value : fallback[index]
    ));
    return {
        quantity: Math.max(1, Number(quantity || 1)),
        weight: resolved[0],
        height: resolved[1],
        width: resolved[2],
        length: resolved[3]
    };
}

async function calculateSuperfreteQuotes({toCep,items}) {
    if (!SUPERFRETE_TOKEN) throw new Error("SUPERFRETE_TOKEN não configurado no Render.");
    if (!SUPERFRETE_ORIGIN_CEP || SUPERFRETE_ORIGIN_CEP.length!==8) throw new Error("SUPERFRETE_ORIGIN_CEP não configurado corretamente.");
    const grouped=new Map();
    for(const item of Array.isArray(items)?items:[]){const id=safeString(item.id||item.product_id);const quantity=Math.max(1,Number(item.quantity||1));if(id) grouped.set(id,(grouped.get(id)||0)+quantity);}
    if(!grouped.size) throw new Error("Nenhum produto válido para calcular o frete.");
    const productRows=await Promise.all([...grouped.entries()].map(async([id,quantity])=>{
        const rows=await supabaseRequest("products?id=eq."+encodeURIComponent(id)+"&active=eq.true&select=id,name,category,shipping_weight_kg,shipping_height_cm,shipping_width_cm,shipping_length_cm",{method:"GET"});
        const product=Array.isArray(rows)?rows[0]:null;
        if(!product) throw new Error("Produto não encontrado para cálculo de frete.");
        const shippingProduct=normalizeShippingProduct(product,quantity);
        if(!shippingProduct) throw new Error(`O produto "${product.name||"sem nome"}" ainda não possui peso e dimensões cadastrados para o cálculo de frete.`);
        return shippingProduct;
    }));
    const response=await fetch(`${SUPERFRETE_API_URL.replace(/\/$/,"")}/api/v0/calculator`,{
        method:"POST",
        headers:{"Authorization":`Bearer ${SUPERFRETE_TOKEN}`,"User-Agent":SUPERFRETE_USER_AGENT,"Accept":"application/json","Content-Type":"application/json"},
        body:JSON.stringify({from:{postal_code:SUPERFRETE_ORIGIN_CEP},to:{postal_code:String(toCep).replace(/\D/g,"")},services:"1,2,17,3,33",options:{own_hand:false,receipt:false,insurance_value:0,use_insurance_value:false},products:productRows})
    });
    const responseText=await response.text();
    let data={}; try{data=responseText?JSON.parse(responseText):{}}catch{data={raw:responseText};}
    if(!response.ok){console.error("SuperFrete cotação:",response.status,data);throw new Error("A SuperFrete não conseguiu calcular o frete para este CEP.");}
    const candidates=Array.isArray(data)?data:(data?.services||data?.data||data?.results||data?.cotation||data?.quotes||[]);
    const list=Array.isArray(candidates)?candidates:(candidates&&typeof candidates==="object"?Object.values(candidates):[]);
    const quotes=list.map(service=>{
        const price=Number(service?.price??service?.custom_price??service?.value??service?.amount);
        const id=service?.id??service?.service_id??service?.code;
        const name=service?.name||service?.service||service?.service_name;
        const range=service?.delivery_range||service?.deliveryRange||{};
        const min=Number(service?.delivery_min??service?.delivery_time_min??range?.min??service?.delivery_time);
        const max=Number(service?.delivery_max??service?.delivery_time_max??range?.max??service?.delivery_time);
        if(!id||!name||!Number.isFinite(price)||price<=0)return null;
        return {id:String(id),name:String(name),price:Number(price.toFixed(2)),delivery_days:Number.isFinite(max)?Math.max(1,max):null,delivery_min_days:Number.isFinite(min)?Math.max(1,min):null,delivery_max_days:Number.isFinite(max)?Math.max(1,max):null};
    }).filter(Boolean);
    const unique=new Map(); for(const quote of quotes) if(!unique.has(quote.id)) unique.set(quote.id,quote);
    return [...unique.values()];
}

/* =====================================================
   REDIRECIONAMENTO INFINITEPAY
   Desktop: navegação direta pelo frontend.
   Mobile: endpoint same-origin com HTTP 302, evitando bloqueios
   de Safari/iOS e navegadores embutidos.
===================================================== */
app.get("/pagamento-infinitepay", (req, res) => {
    try {
        const target = String(req.query?.url || "").trim();
        const parsed = new URL(target);

        if (parsed.protocol !== "https:" || !("checkout.infinitepay.io" === parsed.hostname || "checkout.infinitepay.com.br" === parsed.hostname || "buy.infinitepay.com" === parsed.hostname)) {
            return res.status(400).send("Link de pagamento inválido.");
        }

        res.setHeader("Cache-Control", "no-store");
        return res.redirect(302, parsed.href);
    } catch {
        return res.status(400).send("Link de pagamento inválido.");
    }
});

/* =====================================================
   MIDDLEWARES
===================================================== */

const allowedOrigins = new Set([
    SITE_URL.replace(/\/$/, ""),
    "https://oficialmontee.com.br",
    "https://www.oficialmontee.com.br",
    "https://monte-site-itjk.onrender.com"
]);

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", [
        "default-src 'self'",
        "base-uri 'self'",
        "frame-ancestors 'self'",
        "object-src 'none'",
        "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' https://uvrhougaurupvkxmezwy.supabase.co https://viacep.com.br",
        "form-action 'self' https:",
        "upgrade-insecure-requests"
    ].join("; "));
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (req.path.startsWith("/api/admin/")) {
        res.setHeader("Cache-Control", "no-store");
    }
    next();
});

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) {
                return callback(null, true);
            }
            return callback(new Error("Origem não autorizada."));
        },
        methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: false
    })
);

app.use(express.json({ limit: "30mb" }));

/* =====================================================
   RATE LIMITING — proteção contra abuso de endpoints
===================================================== */
function createRateLimiter({ windowMs, max, keyFn = req => req.ip || "unknown" }) {
    const buckets = new Map();

    const cleanup = () => {
        const now = Date.now();
        for (const [key, bucket] of buckets.entries()) {
            if (now - bucket.startedAt >= windowMs) buckets.delete(key);
        }
    };

    setInterval(cleanup, Math.min(windowMs, 5 * 60 * 1000)).unref();

    return (req, res, next) => {
        const key = String(keyFn(req) || "unknown");
        const now = Date.now();
        let bucket = buckets.get(key);

        if (!bucket || now - bucket.startedAt >= windowMs) {
            bucket = { startedAt: now, count: 0 };
            buckets.set(key, bucket);
        }

        bucket.count += 1;

        if (bucket.count > max) {
            const retryAfter = Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000));
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                message: "Muitas solicitações. Aguarde alguns instantes e tente novamente."
            });
        }

        next();
    };
}

const checkoutRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 12
});

const adminLoginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20
});

const orderStatusRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30
});

// Endpoints públicos que acionam APIs externas ou processamento pesado recebem
// limites próprios para reduzir abuso, consumo de quota e DoS.
const shippingQuoteRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 20
});

const newsletterRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5
});

const imageNormalizeRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 20
});

const infinitePayWebhookRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30
});

/* =====================================================
   MONTÊ ADMIN AUTH — acesso exclusivo do administrador
===================================================== */
const ADMIN_EMAIL = safeString(process.env.ADMIN_EMAIL);
const ADMIN_PASSWORD_HASH = safeString(process.env.ADMIN_PASSWORD_HASH);
const ADMIN_SESSION_TTL = 1000 * 60 * 60 * 8;
const adminSessions = new Map();
const adminLoginAttempts = new Map();
function parseCookies(req){const h=req.headers.cookie||"";const o={};h.split(";").filter(Boolean).forEach(p=>{const i=p.indexOf("=");if(i>=0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())});return o}
function getAdminSession(req){const t=parseCookies(req)["monte_admin_session"];if(!t)return null;const s=adminSessions.get(t);if(!s)return null;if(Date.now()>s.expiresAt){adminSessions.delete(t);return null}return {token:t,...s}}
function requireAdmin(req,res,next){
    const origin = safeString(req.headers.origin);
    if (origin && !allowedOrigins.has(origin.replace(/\/$/, ""))) {
        return res.status(403).json({success:false,message:"Origem não autorizada."});
    }
    const s=getAdminSession(req);
    if(!s)return res.status(401).json({success:false,message:"Acesso administrativo não autorizado."});
    req.adminSession=s;
    next();
}
function normalizeCity(value) {
    return safeString(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isValidCpf(value){
    const cpf=String(value||"").replace(/\D/g,"");
    if(cpf.length!==11||/^([0-9])\1{10}$/.test(cpf)) return false;
    let sum=0;
    for(let i=0;i<9;i++) sum+=Number(cpf[i])*(10-i);
    let digit=(sum*10)%11; if(digit===10) digit=0;
    if(digit!==Number(cpf[9])) return false;
    sum=0;
    for(let i=0;i<10;i++) sum+=Number(cpf[i])*(11-i);
    digit=(sum*10)%11; if(digit===10) digit=0;
    return digit===Number(cpf[10]);
}
function passwordMatches(password){try{const [salt,storedHex]=ADMIN_PASSWORD_HASH.split(":");if(!salt||!storedHex)return false;const stored=Buffer.from(storedHex,"hex");const derived=crypto.scryptSync(String(password||""),salt,stored.length);return crypto.timingSafeEqual(stored,derived)}catch{return false}}
function loginKey(req,email){return `${req.ip||"unknown"}:${safeString(email).toLowerCase()}`}
function loginAllowed(req,email){const r=adminLoginAttempts.get(loginKey(req,email));if(!r)return true;if(r.lockedUntil&&Date.now()<r.lockedUntil)return false;if(r.lockedUntil)adminLoginAttempts.delete(loginKey(req,email));return true}
function failedLogin(req,email){const k=loginKey(req,email);const r=adminLoginAttempts.get(k)||{count:0,lockedUntil:0};r.count++;if(r.count>=5){r.count=0;r.lockedUntil=Date.now()+15*60*1000}adminLoginAttempts.set(k,r)}
function clearLoginFailures(req,email){adminLoginAttempts.delete(loginKey(req,email))}
function setAdminCookie(res,t){res.setHeader("Set-Cookie",`monte_admin_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL/1000)}`)}
function clearAdminCookie(res){res.setHeader("Set-Cookie","monte_admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")}
app.post("/api/admin/login",adminLoginRateLimit,(req,res)=>{const email=safeString(req.body?.email).toLowerCase(),password=req.body?.password;if(!ADMIN_EMAIL||!ADMIN_PASSWORD_HASH)return res.status(503).json({success:false,message:"Acesso administrativo não configurado no servidor."});if(!loginAllowed(req,email))return res.status(429).json({success:false,message:"Muitas tentativas. Tente novamente em 15 minutos."});if(email!==ADMIN_EMAIL.toLowerCase()||!passwordMatches(password)){failedLogin(req,email);return res.status(401).json({success:false,message:"E-mail ou senha incorretos."})}clearLoginFailures(req,email);const token=crypto.randomBytes(32).toString("hex");adminSessions.set(token,{email:ADMIN_EMAIL,expiresAt:Date.now()+ADMIN_SESSION_TTL});setAdminCookie(res,token);return res.json({success:true,email:ADMIN_EMAIL})});
app.post("/api/admin/logout",(req,res)=>{const t=parseCookies(req).monte_admin_session;if(t)adminSessions.delete(t);clearAdminCookie(res);return res.json({success:true})});
app.get("/api/admin/session",(req,res)=>{const s=getAdminSession(req);if(!s)return res.status(401).json({success:false});return res.json({success:true,email:s.email})});
const CAROUSEL_KV_KEY = "site_carousel_images";

async function readCarouselImages(){
  const rows=await supabaseRequest("kv_store_48db9b7e?key=eq."+encodeURIComponent(CAROUSEL_KV_KEY)+"&select=key,value",{method:"GET"});
  if(Array.isArray(rows)&&rows[0]?.value?.images&&Array.isArray(rows[0].value.images)){
    return rows[0].value.images.filter(v=>typeof v==="string"&&v).slice(0,20);
  }
  return [
    SITE_URL.replace(/\/$/,"") + "/backend/assets/carousel-photo-1.webp",
    SITE_URL.replace(/\/$/,"") + "/backend/assets/carousel-photo-2.webp"
  ];
}
function normalizeCarouselImages(images){
  return Array.isArray(images)?images.map(v=>safeString(v)).filter(Boolean).slice(0,20):[];
}
app.get("/api/carousel",async(req,res)=>{
  try{return res.json({success:true,images:await readCarouselImages()})}
  catch(e){console.error("Public carousel GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar o carrossel."})}
});
app.get("/api/admin/carousel",requireAdmin,async(req,res)=>{
  try{return res.json({success:true,images:await readCarouselImages()})}
  catch(e){console.error("Admin carousel GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar o carrossel."})}
});
app.put("/api/admin/carousel",requireAdmin,async(req,res)=>{
  try{
    const images=normalizeCarouselImages(req.body?.images);
    if(!images.length)return res.status(400).json({success:false,message:"Adicione pelo menos uma foto ao carrossel."});
    const body=JSON.stringify({key:CAROUSEL_KV_KEY,value:{images,updated_at:new Date().toISOString()}});
    await supabaseRequest("kv_store_48db9b7e",{method:"POST",body,headers:{"Prefer":"resolution=merge-duplicates,return=representation"}});
    return res.json({success:true,images});
  }catch(e){console.error("Admin carousel PUT:",e);return res.status(500).json({success:false,message:e.message||"Não foi possível salvar o carrossel."})}
});

app.get("/api/admin/products",requireAdmin,async(req,res)=>{try{const data=await supabaseRequest("products?select=*,product_variants(*)&order=created_at.desc");return res.json({success:true,products:data||[]})}catch(e){console.error("Admin products GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar os produtos."})}});

function analyticsClientInfo(req){
  const ua=String(req.headers["user-agent"]||"");
  return {
    device_type:/mobile|android|iphone|ipad|ipod/i.test(ua)?"mobile":"desktop",
    browser:/edg/i.test(ua)?"Edge":/chrome/i.test(ua)?"Chrome":/safari/i.test(ua)&&!/chrome/i.test(ua)?"Safari":/firefox/i.test(ua)?"Firefox":"Outro",
    os:/windows/i.test(ua)?"Windows":/mac os|macintosh/i.test(ua)?"macOS":/android/i.test(ua)?"Android":/iphone|ipad|ipod/i.test(ua)?"iOS":/linux/i.test(ua)?"Linux":"Outro"
  };
}
app.post("/api/analytics/event",checkoutRateLimit,async(req,res)=>{
  try{
    const b=req.body||{}, allowed=["page_view","view_product","add_to_cart","remove_from_cart","begin_checkout","checkout_started","checkout_completed","purchase"];
    const event_name=safeString(b.event_name);
    const visitor_id=safeString(b.visitor_id).slice(0,120), session_key=safeString(b.session_id).slice(0,120);
    if(!allowed.includes(event_name)||!visitor_id||!session_key) return res.status(400).json({success:false,message:"Evento inválido."});
    const now=new Date().toISOString(), info=analyticsClientInfo(req);
    let rows=await supabaseRequest("site_sessions?session_id=eq."+encodeURIComponent(session_key)+"&select=id",{method:"GET"});
    let session=Array.isArray(rows)?rows[0]:null;
    if(!session){
      const created=await supabaseRequest("site_sessions",{method:"POST",body:JSON.stringify({visitor_id,session_id:session_key,first_seen_at:now,last_seen_at:now,landing_path:safeString(b.path).slice(0,500),referrer:safeString(b.referrer).slice(0,500)||null,utm_source:safeString(b.utm_source).slice(0,100)||null,utm_medium:safeString(b.utm_medium).slice(0,100)||null,utm_campaign:safeString(b.utm_campaign).slice(0,150)||null,...info})});
      session=Array.isArray(created)?created[0]:created;
    }else{
      await supabaseRequest("site_sessions?id=eq."+encodeURIComponent(session.id),{method:"PATCH",body:JSON.stringify({last_seen_at:now,...info})});
    }
    await supabaseRequest("site_events",{method:"POST",body:JSON.stringify({
      session_id:session.id,visitor_id,event_name,path:safeString(b.path).slice(0,500),product_id:safeString(b.product_id)||null,
      product_name:safeString(b.product_name).slice(0,160)||null,variant_id:safeString(b.variant_id)||null,
      quantity:Number.isFinite(Number(b.quantity))?Math.max(1,Math.min(100,Number(b.quantity))):null,
      value:Number.isFinite(Number(b.value))?Number(b.value):null,metadata:b.metadata&&typeof b.metadata==="object"?b.metadata:{}
    })});
    res.status(201).json({success:true});
  }catch(e){console.error("Analytics:",e);res.status(400).json({success:false,message:"Não foi possível registrar o evento."})}
});
app.post("/api/analytics/cart",checkoutRateLimit,async(req,res)=>{
  try{
    const b=req.body||{}, visitor_id=safeString(b.visitor_id).slice(0,120), session_key=safeString(b.session_id).slice(0,120);
    if(!visitor_id||!session_key) return res.status(400).json({success:false,message:"Identificadores ausentes."});
    const ses=await supabaseRequest("site_sessions?session_id=eq."+encodeURIComponent(session_key)+"&select=id",{method:"GET"});
    const session_id=Array.isArray(ses)?ses[0]?.id:null;
    const subtotal=Math.max(0,Number(b.subtotal||0)),shipping=Math.max(0,Number(b.shipping||0)),total=Math.max(0,Number(b.total||subtotal+shipping));
    const row={visitor_id,session_id,cart_key:session_key,customer_name:safeString(b.customer_name).slice(0,160)||null,customer_email:safeString(b.customer_email).slice(0,160)||null,customer_phone:safeString(b.customer_phone).slice(0,60)||null,items:Array.isArray(b.items)?b.items.slice(0,50):[],subtotal,shipping,total,status:"active",last_activity_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    const updated=await supabaseRequest("cart_snapshots?cart_key=eq."+encodeURIComponent(session_key),{method:"PATCH",body:JSON.stringify(row)});
    if(!Array.isArray(updated)||!updated.length) await supabaseRequest("cart_snapshots",{method:"POST",body:JSON.stringify(row)});
    res.status(201).json({success:true});
  }catch(e){console.error("Analytics cart:",e);res.status(400).json({success:false,message:"Não foi possível salvar o carrinho."})}
});
app.get("/api/admin/analytics",requireAdmin,async(req,res)=>{
  try{
    const days=Math.min(90,Math.max(1,Number(req.query.days||30))),since=new Date(Date.now()-days*86400000).toISOString();
    const [events,sessions,carts,orders,items]=await Promise.all([
      supabaseRequest("site_events?created_at=gte."+encodeURIComponent(since)+"&select=*&order=created_at.desc&limit=10000",{method:"GET"}),
      supabaseRequest("site_sessions?last_seen_at=gte."+encodeURIComponent(since)+"&select=*&order=last_seen_at.desc&limit=5000",{method:"GET"}),
      supabaseRequest("cart_snapshots?last_activity_at=gte."+encodeURIComponent(since)+"&select=*&order=last_activity_at.desc&limit=5000",{method:"GET"}),
      supabaseRequest("orders?created_at=gte."+encodeURIComponent(since)+"&select=id,order_nsu,customer_name,customer_email,subtotal,shipping,total,status,payment_method,created_at,paid_at,paid_amount",{method:"GET"}),
      supabaseRequest("order_items?created_at=gte."+encodeURIComponent(since)+"&select=order_id,product_id,product_name,sku,quantity,total_price,created_at&order=created_at.desc&limit=10000",{method:"GET"})
    ]);
    const good=["paid","processing","shipped","delivered"],paid=orders.filter(o=>good.includes(o.status)),paidIds=new Set(paid.map(o=>String(o.id)));
    const revenue=paid.reduce((s,o)=>s+Number(o.total||0),0), visitors=new Set(sessions.map(s=>s.visitor_id)).size, pageViews=events.filter(e=>e.event_name==="page_view").length;
    const addToCart=events.filter(e=>e.event_name==="add_to_cart").length,checkoutStarted=events.filter(e=>["begin_checkout","checkout_started"].includes(e.event_name)).length;
    const active=carts.filter(c=>c.status==="active"), converted=carts.filter(c=>c.status==="converted");
    const productMap={}, unitsSold={}; items.filter(i=>paidIds.has(String(i.order_id))).forEach(i=>{const key=i.product_name||i.product_id||"—";productMap[key]=(productMap[key]||0)+Number(i.total_price||0);unitsSold[key]=(unitsSold[key]||0)+Number(i.quantity||0)});
    const methods={};paid.forEach(o=>{const key=o.payment_method||"não informado";methods[key]=(methods[key]||0)+Number(o.total||0)});
    const series=[];for(let i=days-1;i>=0;i--){const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10),dayEvents=events.filter(e=>String(e.created_at).slice(0,10)===d),daySessions=sessions.filter(s=>String(s.last_seen_at).slice(0,10)===d),dayOrders=paid.filter(o=>String(o.paid_at||o.created_at).slice(0,10)===d);series.push({date:d,visitors:new Set(daySessions.map(s=>s.visitor_id)).size,pageViews:dayEvents.filter(e=>e.event_name==="page_view").length,purchases:dayOrders.length,revenue:dayOrders.reduce((s,o)=>s+Number(o.total||0),0)});}
    res.json({success:true,summary:{visitors, pageViews, sessions:sessions.length, addToCart, checkoutStarted, orders:orders.length, paidOrders:paid.length, grossRevenue:revenue, ticketAverage:paid.length?revenue/paid.length:0, conversionRate:visitors?paid.length/visitors*100:0, activeCarts:active.length, abandonedValue:active.reduce((s,c)=>s+Number(c.total||0),0), abandonmentRate:(active.length+converted.length)?active.length/(active.length+converted.length)*100:0, convertedCarts:converted.length},series,topProducts:Object.keys(productMap).map(k=>({key:k,revenue:productMap[k],units:unitsSold[k]})).sort((a,b)=>b.revenue-a.revenue).slice(0,10),paymentMethods:methods,recentOrders:orders.slice(0,12),recentCarts:carts.slice(0,20),generatedAt:new Date().toISOString()});
  }catch(e){console.error("Admin analytics:",e);res.status(500).json({success:false,message:"Não foi possível carregar o Dashboard."})}
});

const PRODUCT_IMAGE_BUCKET = "product-images";

const normalizedProductImageCache = new Map();

function isAllowedProductImageUrl(value) {
    try {
        const parsed = new URL(String(value || ""));
        const supabaseHost = new URL(SUPABASE_URL).host;
        return parsed.protocol === "https:" &&
            parsed.host === supabaseHost &&
            parsed.pathname.startsWith("/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/");
    } catch {
        return false;
    }
}

app.get("/api/product-image-normalized", imageNormalizeRateLimit, async (req, res) => {
    const sourceUrl = safeString(req.query?.url);
    if (!isAllowedProductImageUrl(sourceUrl)) {
        return res.status(400).json({ success: false, message: "Imagem inválida." });
    }

    const cached = normalizedProductImageCache.get(sourceUrl);
    if (cached) {
        res.setHeader("Content-Type", cached.contentType);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(cached.buffer);
    }

    try {
        const response = await fetch(sourceUrl);
        if (!response.ok) {
            return res.status(404).end();
        }

        const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
        if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
            return res.status(415).end();
        }

        const sourceBuffer = Buffer.from(await response.arrayBuffer());
        if (!sourceBuffer.length || sourceBuffer.length > 20 * 1024 * 1024) {
            return res.status(413).end();
        }

        const normalizedBuffer = await sharp(sourceBuffer)
            .trim({
                threshold: 18,
                margin: 20
            })
            .toBuffer();

        const result = {
            buffer: normalizedBuffer,
            contentType
        };

        normalizedProductImageCache.set(sourceUrl, result);
        if (normalizedProductImageCache.size > 250) {
            const oldestKey = normalizedProductImageCache.keys().next().value;
            normalizedProductImageCache.delete(oldestKey);
        }

        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(normalizedBuffer);
    } catch (error) {
        console.error("Product image normalization:", error);
        return res.redirect(sourceUrl);
    }
});



async function validateImageBuffer(buffer, declaredContentType) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error("Arquivo de imagem vazio.");
    }
    if (buffer.length > 20 * 1024 * 1024) {
        throw new Error("Cada imagem pode ter no máximo 20 MB.");
    }
    const metadata = await sharp(buffer).metadata();
    const detected = metadata?.format === "jpeg" ? "image/jpeg"
        : metadata?.format === "png" ? "image/png"
        : metadata?.format === "webp" ? "image/webp"
        : null;
    if (!detected || detected !== declaredContentType) {
        throw new Error("O conteúdo da imagem não corresponde ao formato informado.");
    }
    if (!Number.isFinite(metadata.width) || !Number.isFinite(metadata.height) ||
        metadata.width < 1 || metadata.height < 1 ||
        metadata.width > 20000 || metadata.height > 20000) {
        throw new Error("Dimensões de imagem inválidas.");
    }
    return metadata;
}

async function uploadProductImage({ productId, fileName, contentType, dataBase64 }) {
    if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(contentType)) throw new Error("Formato de imagem não permitido. Use JPG, PNG ou WebP.");
    const raw = String(dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    await validateImageBuffer(buffer, contentType);
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const safeName = safeString(fileName).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "imagem." + ext;
    const objectPath = productId + "/" + Date.now() + "-" + crypto.randomBytes(5).toString("hex") + "-" + safeName;
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + PRODUCT_IMAGE_BUCKET + "/" + encodeURIComponent(objectPath).replace(/%2F/g, "/"), {
        method: "POST",
        headers: { "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "apikey": SUPABASE_SERVICE_ROLE_KEY, "Content-Type": contentType, "x-upsert": "false", "cache-control": "31536000" },
        body: buffer
    });
    if (!response.ok) throw new Error("Upload da imagem falhou (" + response.status + ").");
    return SUPABASE_URL + "/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/" + objectPath;
}

async function uploadCarouselImage({fileName,contentType,dataBase64}) {
    if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(contentType)) throw new Error("Formato de imagem não permitido. Use JPG, PNG ou WebP.");
    const raw = String(dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    await validateImageBuffer(buffer, contentType);
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const safeName = safeString(fileName).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "carousel."+ext;
    const objectPath = "carousel/" + Date.now() + "-" + crypto.randomBytes(5).toString("hex") + "-" + safeName;
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + PRODUCT_IMAGE_BUCKET + "/" + encodeURIComponent(objectPath).replace(/%2F/g, "/"), {
        method: "POST",
        headers: { "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "apikey": SUPABASE_SERVICE_ROLE_KEY, "Content-Type": contentType, "x-upsert": "false", "cache-control": "31536000" },
        body: buffer
    });
    if (!response.ok) throw new Error("Upload da imagem do carrossel falhou (" + response.status + ").");
    return SUPABASE_URL + "/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/" + objectPath;
}
app.post("/api/admin/uploads/carousel-image", requireAdmin, async (req,res)=>{
  try{
    const url=await uploadCarouselImage({
      fileName:safeString(req.body?.file_name),
      contentType:safeString(req.body?.content_type).toLowerCase(),
      dataBase64:safeString(req.body?.data_base64)
    });
    return res.status(201).json({success:true,url});
  }catch(e){
    console.error("Admin carousel image upload:",e);
    return res.status(400).json({success:false,message:e.message||"Não foi possível enviar a imagem."});
  }
});

app.post("/api/admin/uploads/product-image", requireAdmin, async (req, res) => {
    try {
        const productId = safeString(req.body?.product_id);
        const fileName = safeString(req.body?.file_name);
        const contentType = safeString(req.body?.content_type).toLowerCase();
        const dataBase64 = safeString(req.body?.data_base64);
        if (!/^[0-9a-f-]{36}$/i.test(productId)) return res.status(400).json({ success: false, message: "Produto inválido." });
        const url = await uploadProductImage({ productId, fileName, contentType, dataBase64 });
        return res.status(201).json({ success: true, url });
    } catch (error) {
        console.error("Admin image upload:", error);
        return res.status(400).json({ success: false, message: error.message || "Não foi possível enviar a imagem." });
    }
});

function sanitizeProductPayload(b={}){return{name:safeString(b.name),sku:safeString(b.sku)||null,category:safeString(b.category)||"bolsas",price:Number(b.price||0),sale_price:b.sale_price===null||b.sale_price===""||b.sale_price===undefined?null:Number(b.sale_price),description:safeString(b.description),images:Array.isArray(b.images)?b.images:[],shipping_weight_kg:b.shipping_weight_kg===null||b.shipping_weight_kg===""||b.shipping_weight_kg===undefined?null:Number(b.shipping_weight_kg),shipping_height_cm:b.shipping_height_cm===null||b.shipping_height_cm===""||b.shipping_height_cm===undefined?null:Number(b.shipping_height_cm),shipping_width_cm:b.shipping_width_cm===null||b.shipping_width_cm===""||b.shipping_width_cm===undefined?null:Number(b.shipping_width_cm),shipping_length_cm:b.shipping_length_cm===null||b.shipping_length_cm===""||b.shipping_length_cm===undefined?null:Number(b.shipping_length_cm),is_new:Boolean(b.is_new),is_sale:Boolean(b.is_sale),active:b.active!==false}}
app.post("/api/admin/products",requireAdmin,async(req,res)=>{try{const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest("products",{method:"POST",body:JSON.stringify(p)});return res.status(201).json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products POST:",e);return res.status(500).json({success:false,message:e.message})}});
app.put("/api/admin/products/:id",requireAdmin,async(req,res)=>{try{const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest(`products?id=eq.${encodeURIComponent(req.params.id)}`,{method:"PATCH",body:JSON.stringify(p)});return res.json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products PUT:",e);return res.status(500).json({success:false,message:e.message})}});
app.delete("/api/admin/products/:id",requireAdmin,async(req,res)=>{
    try{
        const productId=safeString(req.params.id);
        if(!/^[0-9a-f-]{36}$/i.test(productId)) return res.status(400).json({success:false,message:"Produto inválido."});

        const orders=await supabaseRequest(
            "order_items?product_id=eq."+encodeURIComponent(productId)+"&select=id&limit=1"
        );
        if(Array.isArray(orders)&&orders.length){
            return res.status(409).json({
                success:false,
                message:"Este produto já está vinculado a um pedido. Para preservar o histórico da venda, use DESATIVAR em vez de excluir."
            });
        }

        await supabaseRequest(
            "product_variants?product_id=eq."+encodeURIComponent(productId),
            {method:"DELETE",headers:{"Prefer":"return=minimal"}}
        );
        const deleted=await supabaseRequest(
            "products?id=eq."+encodeURIComponent(productId),
            {method:"DELETE",headers:{"Prefer":"return=representation"}}
        );
        if(!Array.isArray(deleted)||!deleted[0]){
            return res.status(404).json({success:false,message:"Produto não encontrado."});
        }
        return res.json({success:true});
    }catch(e){
        console.error("Admin product DELETE:",e);
        return res.status(500).json({success:false,message:"Não foi possível excluir o produto."});
    }
});
app.put("/api/admin/products/:id/variants",requireAdmin,async(req,res)=>{
    try{
        const productId=safeString(req.params.id);
        const variants=Array.isArray(req.body?.variants)?req.body.variants:[];
        if(!/^[0-9a-f-]{36}$/i.test(productId)) return res.status(400).json({success:false,message:"Produto inválido."});
        if(variants.length>50) return res.status(400).json({success:false,message:"Quantidade de variações excede o limite."});

        const existing=await supabaseRequest(
            `product_variants?product_id=eq.${encodeURIComponent(productId)}&select=id,color,sku,stock,active`
        );
        const incomingIds=new Set(variants.map(v=>safeString(v.id)).filter(Boolean));

        for(const old of (existing||[])){
            if(!incomingIds.has(old.id)){
                if(Number(old.stock||0)>0){
                    return res.status(409).json({
                        success:false,
                        message:`A variação "${old.color}" possui estoque. Zere o estoque antes de removê-la.`
                    });
                }
                await supabaseRequest(
                    `product_variants?id=eq.${encodeURIComponent(old.id)}`,
                    {method:"DELETE",headers:{"Prefer":"return=minimal"}}
                );
            }
        }

        for(const v of variants){
            const color=safeString(v.color);
            const sku=safeString(v.sku)||null;
            const active=v.active!==false;
            const requestedStock=Number(v.stock);

            if(!color) continue;
            if(color.length>80 || (sku && sku.length>80) || !Number.isInteger(requestedStock) || requestedStock<0 || requestedStock>100000){
                return res.status(400).json({success:false,message:"Dados de variação ou estoque inválidos."});
            }

            if(v.id){
                const current=(existing||[]).find(x=>x.id===v.id);
                if(!current) return res.status(404).json({success:false,message:"Variação não encontrada."});

                await supabaseRequest(
                    `product_variants?id=eq.${encodeURIComponent(v.id)}`,
                    {
                        method:"PATCH",
                        body:JSON.stringify({color,sku,active})
                    }
                );

                const currentStock=Number(current.stock||0);
                const delta=requestedStock-currentStock;
                if(delta!==0){
                    await supabaseRequest("rpc/adjust_product_variant_stock",{
                        method:"POST",
                        body:JSON.stringify({
                            p_variant_id:v.id,
                            p_delta:delta,
                            p_movement_type:"adjustment",
                            p_reason:"Atualização de estoque pelo painel administrativo",
                            p_created_by:req.adminSession.email
                        })
                    });
                }
            }else{
                const created=await supabaseRequest("product_variants",{
                    method:"POST",
                    body:JSON.stringify({product_id:productId,color,sku,stock:0,active})
                });
                const createdVariant=Array.isArray(created)?created[0]:created;
                if(requestedStock>0){
                    await supabaseRequest("rpc/adjust_product_variant_stock",{
                        method:"POST",
                        body:JSON.stringify({
                            p_variant_id:createdVariant.id,
                            p_delta:requestedStock,
                            p_movement_type:"restock",
                            p_reason:"Estoque inicial pelo painel administrativo",
                            p_created_by:req.adminSession.email
                        })
                    });
                }
            }
        }

        return res.json({success:true});
    }catch(e){
        console.error("Admin variants PUT:",e);
        const msg=String(e.message||"");
        if(msg.includes("Estoque insuficiente")) return res.status(400).json({success:false,message:"Estoque insuficiente para este ajuste."});
        return res.status(500).json({success:false,message:"Não foi possível atualizar as variações."});
    }
});
app.get("/api/admin/orders",requireAdmin,async(req,res)=>{try{const d=await supabaseRequest("orders?select=*,order_items(*),payments(*)&order=created_at.desc");return res.json({success:true,orders:d||[]})}catch(e){console.error("Admin orders GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar os pedidos."})}});




app.patch("/api/admin/orders/:id/status",requireAdmin,async(req,res)=>{
    try{
        const id=encodeURIComponent(req.params.id);
        const status=safeString(req.body?.status).toLowerCase();
        const allowed=["pending","paid","processing","shipped","delivered"];
        if(!allowed.includes(status)) return res.status(400).json({success:false,message:"Status inválido."});
        const patch={status,updated_at:new Date().toISOString()};
        if(status==="processing") patch.processing_at=new Date().toISOString();
        if(status==="shipped"){
            patch.shipping_carrier=safeString(req.body?.shipping_carrier)||null;
            patch.tracking_code=safeString(req.body?.tracking_code)||null;
            patch.tracking_url=safeString(req.body?.tracking_url)||null;
            if(!patch.tracking_code) return res.status(400).json({success:false,message:"Informe o código de rastreio para marcar como enviado."});
            patch.shipped_at=new Date().toISOString();
        }
        if(status==="delivered") patch.delivered_at=new Date().toISOString();
        const d=await supabaseRequest(`orders?id=eq.${id}`,{method:"PATCH",body:JSON.stringify(patch)});
        if(!Array.isArray(d)||!d[0]) return res.status(404).json({success:false,message:"Pedido não encontrado."});

        let whatsapp = null;
        const savedOrder = d[0];
        if (status === "shipped" && savedOrder.tracking_code && !savedOrder.whatsapp_tracking_sent_at) {
            try {
                whatsapp = await sendWhatsAppTrackingNotification(savedOrder);
                await supabaseRequest(`orders?id=eq.${id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                        whatsapp_tracking_status: whatsapp.status,
                        whatsapp_tracking_sent_at: whatsapp.sent ? new Date().toISOString() : null,
                        whatsapp_tracking_message_id: whatsapp.message_id
                    })
                });
            } catch (whatsappError) {
                console.error("WhatsApp rastreio:", whatsappError);
                whatsapp = { sent: false, status: "error", message_id: null, error: whatsappError.message };
                await supabaseRequest(`orders?id=eq.${id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ whatsapp_tracking_status: "error" })
                });
            }
        }

        return res.json({success:true,order:{...savedOrder, ...(whatsapp ? {whatsapp_tracking_status:whatsapp.status, whatsapp_tracking_message_id:whatsapp.message_id}: {})},whatsapp});
    }catch(e){console.error("Admin order status PATCH:",e);return res.status(500).json({success:false,message:"Não foi possível atualizar o pedido."})}
});

app.post("/api/admin/orders/:id/tracking-whatsapp",requireAdmin,async(req,res)=>{
    try{
        const id=encodeURIComponent(req.params.id);
        const rows=await supabaseRequest(`orders?id=eq.${id}&select=*`,{method:"GET"});
        const order=Array.isArray(rows)?rows[0]:null;
        if(!order) return res.status(404).json({success:false,message:"Pedido não encontrado."});
        if(order.status!=="shipped" || !order.tracking_code) return res.status(400).json({success:false,message:"O pedido precisa estar como enviado e ter código de rastreio."});
        if(!order.customer_whatsapp && !order.customer_phone) return res.status(400).json({success:false,message:"O pedido não possui telefone para WhatsApp."});
        const result=await sendWhatsAppTrackingNotification(order);
        await supabaseRequest(`orders?id=eq.${id}`,{
            method:"PATCH",
            body:JSON.stringify({
                whatsapp_tracking_status: result.status,
                whatsapp_tracking_sent_at: result.sent ? new Date().toISOString() : null,
                whatsapp_tracking_message_id: result.message_id
            })
        });
        return res.json({success:true,whatsapp:result});
    }catch(e){
        console.error("Admin WhatsApp tracking:",e);
        await supabaseRequest(`orders?id=eq.${encodeURIComponent(req.params.id)}`,{method:"PATCH",body:JSON.stringify({whatsapp_tracking_status:"error"})}).catch(()=>{});
        return res.status(500).json({success:false,message:"Não foi possível enviar a atualização pelo WhatsApp.",error:process.env.NODE_ENV==="development"?e.message:undefined});
    }
});

app.post("/api/admin/orders/:id/tracking-email",requireAdmin,async(req,res)=>{
    try{
        const id=encodeURIComponent(req.params.id);
        const rows=await supabaseRequest(`orders?id=eq.${id}&select=*`,{method:"GET"});
        const order=Array.isArray(rows)?rows[0]:null;
        if(!order) return res.status(404).json({success:false,message:"Pedido não encontrado."});
        if(order.status==="pending") return res.status(400).json({success:false,message:"O pedido precisa ter um pagamento confirmado antes de enviar uma atualização por e-mail."});
        if(order.status==="shipped" && !order.tracking_code) return res.status(400).json({success:false,message:"Informe o código de rastreio antes de enviar o e-mail de envio."});

        const result=await sendOrderTrackingEmail(order);
        await supabaseRequest(`orders?id=eq.${id}`,{
            method:"PATCH",
            body:JSON.stringify({
                tracking_email_status: result.status,
                tracking_email_sent_at: result.sent ? new Date().toISOString() : null,
                tracking_email_message_id: result.message_id || null
            })
        });
        return res.json({success:true,email:result});
    }catch(e){
        console.error("Admin tracking email:",e);
        await supabaseRequest(`orders?id=eq.${encodeURIComponent(req.params.id)}`,{
            method:"PATCH",
            body:JSON.stringify({tracking_email_status:"error"})
        }).catch(()=>{});
        return res.status(500).json({success:false,message:"Não foi possível enviar a atualização por e-mail.",error:process.env.NODE_ENV==="development"?e.message:undefined});
    }
});

app.get("/api/admin/stock/movements",requireAdmin,async(req,res)=>{
    try{
        const d=await supabaseRequest("inventory_movements?select=*,product_variants(id,color,sku,product_id,products(name))&order=created_at.desc&limit=100");
        return res.json({success:true,movements:d||[]});
    }catch(e){console.error("Admin stock movements GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar o histórico de estoque."})}
});

app.post("/api/admin/stock/adjust",requireAdmin,async(req,res)=>{
    try{
        const variantId=safeString(req.body?.variant_id);
        const delta=Number(req.body?.delta);
        const type=safeString(req.body?.movement_type)||"adjustment";
        const reason=safeString(req.body?.reason);
        if(!variantId||!Number.isInteger(delta)||delta===0) return res.status(400).json({success:false,message:"Informe uma variação e uma quantidade inteira diferente de zero."});
        if(!["restock","adjustment","correction"].includes(type)) return res.status(400).json({success:false,message:"Tipo de movimentação inválido."});
        const result=await supabaseRequest("rpc/adjust_product_variant_stock",{
            method:"POST",
            body:JSON.stringify({p_variant_id:variantId,p_delta:delta,p_movement_type:type,p_reason:reason,p_created_by:req.adminSession.email})
        });
        return res.json({success:true,variant:Array.isArray(result)?result[0]:result});
    }catch(e){
        console.error("Admin stock adjustment POST:",e);
        const msg=String(e.message||"");
        if(msg.includes("Estoque insuficiente")) return res.status(400).json({success:false,message:"Estoque insuficiente para este ajuste."});
        return res.status(500).json({success:false,message:"Não foi possível ajustar o estoque."});
    }
});


/* =====================================================
   INSTAGRAM — FEED PROXY
   O frontend consulta este endpoint do próprio domínio.
   A credencial do Instagram permanece somente no Render.
===================================================== */
const INSTAGRAM_GRAPH_API_VERSION = safeString(process.env.INSTAGRAM_GRAPH_API_VERSION || "v23.0");
const INSTAGRAM_ACCESS_TOKEN = safeString(process.env.INSTAGRAM_ACCESS_TOKEN);
const INSTAGRAM_USER_ID = safeString(process.env.INSTAGRAM_USER_ID);
const INSTAGRAM_CACHE_TTL_MS = 10 * 60 * 1000;
let instagramFeedCache = { expiresAt: 0, data: null };

app.get("/api/instagram/feed", async (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    try {
        const now = Date.now();
        if (instagramFeedCache.data && instagramFeedCache.expiresAt > now) {
            return res.json(instagramFeedCache.data);
        }

        if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_USER_ID) {
            return res.status(503).json({
                success: false,
                configured: false,
                message: "Instagram não configurado no Render."
            });
        }

        const fields = [
            "id",
            "caption",
            "media_type",
            "media_url",
            "thumbnail_url",
            "permalink",
            "timestamp"
        ].join(",");

        const graphUrl = new URL(
            `https://graph.facebook.com/${INSTAGRAM_GRAPH_API_VERSION}/${encodeURIComponent(INSTAGRAM_USER_ID)}/media`
        );
        graphUrl.searchParams.set("fields", fields);
        graphUrl.searchParams.set("limit", "12");
        graphUrl.searchParams.set("access_token", INSTAGRAM_ACCESS_TOKEN);

        const response = await fetch(graphUrl, {
            headers: { "Accept": "application/json" }
        });

        const responseText = await response.text();
        let data = {};
        try { data = responseText ? JSON.parse(responseText) : {}; }
        catch { data = { raw: responseText }; }

        if (!response.ok) {
            console.error("Instagram Graph API:", response.status, data);
            return res.status(502).json({
                success: false,
                configured: true,
                message: "Não foi possível consultar o Instagram agora."
            });
        }

        const items = Array.isArray(data?.data)
            ? data.data
                .filter(item => item && (item.media_url || item.thumbnail_url))
                .map(item => ({
                    id: String(item.id || ""),
                    media_type: String(item.media_type || ""),
                    image_url: String(item.media_url || item.thumbnail_url || ""),
                    permalink: String(item.permalink || "https://www.instagram.com/oficialmonte_/"),
                    caption: String(item.caption || ""),
                    timestamp: item.timestamp || null
                }))
            : [];

        const payload = {
            success: true,
            configured: true,
            items
        };

        instagramFeedCache = {
            expiresAt: now + INSTAGRAM_CACHE_TTL_MS,
            data: payload
        };

        return res.json(payload);
    } catch (error) {
        console.error("Instagram feed:", error);
        return res.status(500).json({
            success: false,
            configured: Boolean(INSTAGRAM_ACCESS_TOKEN && INSTAGRAM_USER_ID),
            message: "Erro ao carregar o Instagram."
        });
    }
});


/* =====================================================
   ÁREA GERENCIAL
   Rota explícita para o painel. O Render executa o backend em /backend,
   enquanto admin.html permanece na raiz do repositório.
===================================================== */
app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "admin.html"));
});

app.get("/admin/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "admin.html"));
});

/* =====================================================
   ARQUIVOS DO SITE
===================================================== */

app.use(
    express.static(
        path.join(
            __dirname,
            ".."
        )
    )
);


/* =====================================================
   TESTE DO SERVIDOR
===================================================== */

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "..",
                "index.html"
            )
        );

    }
);


/* =====================================================
   MONTÊ → InfinitePay
   MEMÓRIA DOS PEDIDOS AGUARDANDO PAGAMENTO
===================================================== */

const pendingOrders = new Map();
const processedPayments = new Set();

/* =====================================================
   NORMALIZAR VALOR
===================================================== */

function normalizeMoney(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Number(number.toFixed(2));
}

/* =====================================================
   NORMALIZAR TEXTO
===================================================== */

function safeString(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value).trim();
}

/* =====================================================
   GUARDAR PEDIDO ANTES DO PAGAMENTO
===================================================== */

function savePendingOrder(order) {

    if (!order || !order.order_nsu) {
        throw new Error("Pedido sem order_nsu.");
    }

    pendingOrders.set(
        order.order_nsu,
        {
            ...order,
            created_at: Date.now(),
            payment_confirmed: false,}
    );

    console.log(
        "💾 Pedido salvo aguardando pagamento:",
        order.order_nsu
    );
}

/* =====================================================
   RECUPERAR PEDIDO
===================================================== */

function getPendingOrder(orderNsu) {

    if (!orderNsu) {
        return null;
    }

    return pendingOrders.get(orderNsu) || null;
}

/* =====================================================
   LIMPEZA DE PEDIDOS ANTIGOS
===================================================== */

function cleanupPendingOrders() {

    const expiration =
        1000 *
        60 *
        60 *
        24;

    const now = Date.now();

    for (
        const [orderNsu, order]
        of pendingOrders.entries()
    ) {

        if (
            order.created_at &&
            now - order.created_at > expiration
        ) {

            pendingOrders.delete(orderNsu);

            console.log(
                "🧹 Pedido pendente removido:",
                orderNsu
            );
        }
    }
}

setInterval(
    cleanupPendingOrders,
    1000 * 60 * 60
);

/* =====================================================
   CRIAR CHECKOUT
   COM PEDIDO SALVO ANTES DO PAGAMENTO
===================================================== */

app.post("/api/frete/cotacao", shippingQuoteRateLimit, async (req,res)=>{
    try{
        const toCep=safeString(req.body?.to_cep||req.body?.cep).replace(/\D/g,"");
        const items=Array.isArray(req.body?.items)?req.body.items:[];
        const city=normalizeCity(req.body?.city||"");
        const state=safeString(req.body?.state||"").toUpperCase();
        if(toCep.length!==8)return res.status(400).json({success:false,message:"CEP de destino inválido."});
        const local=localShippingOption(city,state);
        if(local)return res.json({success:true,source:"monte",options:[local]});
        const options=await calculateSuperfreteQuotes({toCep,items});
        if(!options.length)return res.status(422).json({success:false,message:"Nenhuma modalidade de frete disponível para este CEP."});
        return res.json({success:true,source:"superfrete",options});
    }catch(error){console.error("❌ Erro na cotação SuperFrete:",error);return res.status(502).json({success:false,message:error.message||"Não foi possível calcular o frete."});}
});

app.post("/api/newsletter", newsletterRateLimit, async (req, res) => {
    try {
        if (!RESEND_API_KEY) {
            return res.status(503).json({ success: false, message: "Newsletter não configurada." });
        }

        const email = safeString(req.body?.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, message: "Informe um e-mail válido." });
        }

        // Cadastra o contato diretamente na lista Geral da MONTÊ.
        const segmentId = "a58fa01c-4292-4ba7-ac63-7928f68567c6";
        const response = await fetch("https://api.resend.com/contacts", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + RESEND_API_KEY,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                email,
                unsubscribed: false,
                segment_ids: [segmentId]
            })
        });

        const responseText = await response.text();
        let data = {};
        try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }

        if (!response.ok && response.status !== 409) {
            throw new Error("Resend Contacts API " + response.status + ": " + JSON.stringify(data));
        }

        const alreadyRegistered = response.status === 409;

        // Envia confirmação de cadastro somente para um novo inscrito.
        if (!alreadyRegistered && RESEND_MARKETING_FROM_EMAIL) {
            const welcomeHtml =
                "<!doctype html><html><body style=\"margin:0;padding:0;background:#f4f2ef;color:#171717;font-family:Arial,Helvetica,sans-serif\">" +
                "<div style=\"max-width:640px;margin:0 auto;padding:34px 18px\">" +
                "<div style=\"background:#111;padding:28px 24px;text-align:center\"><div style=\"color:#fff;font-size:25px;letter-spacing:7px;font-weight:600\">MONTÊ</div><div style=\"color:#cfcac3;font-size:10px;letter-spacing:3px;margin-top:9px\">BOLSAS & ACESSÓRIOS</div></div>" +
                "<div style=\"background:#fff;padding:44px 38px 40px\">" +
                "<p style=\"margin:0 0 14px;color:#8a847d;font-size:10px;letter-spacing:2.5px\">CADASTRO CONFIRMADO</p>" +
                "<h1 style=\"margin:0 0 18px;font-size:30px;line-height:1.2;font-weight:500\">Bem-vinda à MONTÊ.</h1>" +
                "<p style=\"margin:0;color:#555;font-size:15px;line-height:1.8\">Seu cadastro foi realizado com sucesso. A partir de agora, você receberá novidades, lançamentos e conteúdos selecionados da MONTÊ.</p>" +
                "<div style=\"margin:30px 0;border-top:1px solid #e8e5e1;border-bottom:1px solid #e8e5e1;padding:22px 0\"><p style=\"margin:0;color:#777;font-size:13px;line-height:1.7\">Prepare-se para conhecer novas coleções, peças e histórias da marca antes de todo mundo.</p></div>" +
                "<div style=\"text-align:center;margin:30px 0 8px\"><a href=\"https://monte-site-itjk.onrender.com\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:15px 28px;font-size:11px;letter-spacing:2px\">VISITAR A MONTÊ</a></div>" +
                "</div><div style=\"padding:22px;text-align:center;color:#999;font-size:10px;line-height:1.6\">MONTÊ — Bolsas & acessórios<br>Você recebeu este e-mail porque se cadastrou para receber novidades da marca.</div>" +
                "</div></body></html>";

            const welcomeResponse = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + RESEND_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    from: RESEND_FROM_NAME + " <" + RESEND_MARKETING_FROM_EMAIL + ">",
                    to: [email],
                    subject: "MONTÊ — cadastro confirmado",
                    html: welcomeHtml
                })
            });

            const welcomeText = await welcomeResponse.text();
            let welcomeData = {};
            try { welcomeData = welcomeText ? JSON.parse(welcomeText) : {}; } catch { welcomeData = { raw: welcomeText }; }

            if (!welcomeResponse.ok) {
                console.error("Newsletter welcome email:", welcomeResponse.status, welcomeData);
            }
        }

        return res.json({
            success: true,
            status: alreadyRegistered ? "already_registered" : "subscribed",
            email_sent: !alreadyRegistered && Boolean(RESEND_MARKETING_FROM_EMAIL)
        });
    } catch (error) {
        console.error("Newsletter:", error);
        return res.status(500).json({ success: false, message: "Não foi possível concluir o cadastro agora." });
    }
});

app.post(
    "/api/criar-checkout",
    checkoutRateLimit,
    async (req, res) => {

        try {

            console.log(
                "🛒 Solicitação de checkout recebida."
            );

            const {
                items,
                customer,
                shipping_service_id: requestedShippingServiceId,
                payment_method: requestedPaymentMethod
            } = req.body || {};

            const paymentMethod = safeString(requestedPaymentMethod || "pix").toLowerCase();

            if (!["pix", "credit_card"].includes(paymentMethod)) {
                return res.status(400).json({
                    success: false,
                    message: "Forma de pagamento inválida."
                });
            }

            /* =================================================
               VALIDAÇÃO DO CARRINHO
            ================================================= */

            if (
                !Array.isArray(items) ||
                items.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Carrinho vazio."

                });

            }


            /* =================================================
               VALIDAÇÃO DO CLIENTE
            ================================================= */

            if (
                !customer ||
                !customer.name ||
                !customer.email ||
                !customer.phone ||
                !customer.cpf ||
                !customer.address ||
                !customer.address.cep ||
                !customer.address.street ||
                !customer.address.number ||
                !customer.address.neighborhood ||
                !customer.address.city ||
                !customer.address.state
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Preencha todos os dados do cliente e do endereço: CEP, rua, número, bairro, cidade e estado."

                });

            }


            const customerCpf = String(customer.cpf || "").replace(/\D/g, "");
            const customerEmail = safeString(customer.email).toLowerCase();
            const customerPhone = safeString(customer.phone);
            const customerWhatsapp = safeString(customer.whatsapp_phone).replace(/\D/g, "");
            const customerName = safeString(customer.name);
            const address = customer.address || {};

            if (
                customerName.length < 2 || customerName.length > 120 ||
                customerEmail.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) ||
                customerPhone.length < 8 || customerPhone.length > 30 ||
                customerCpf.length !== 11 ||
                customerWhatsapp.length > 30 ||
                safeString(address.cep).length > 12 ||
                safeString(address.street).length > 160 ||
                safeString(address.number).length > 30 ||
                safeString(address.complement).length > 120 ||
                safeString(address.neighborhood).length > 120 ||
                safeString(address.city).length > 100 ||
                safeString(address.state).length > 30
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Confira os dados informados no checkout."
                });
            }

            if (!isValidCpf(customerCpf)) {
                return res.status(400).json({
                    success: false,
                    message: "CPF inválido. Informe os 11 dígitos."
                });
            }

            /* =================================================
               NORMALIZA PRODUTOS
            ================================================= */

            if (items.length > 20) {
                return res.status(400).json({
                    success: false,
                    message: "O pedido excede o limite de itens permitido."
                });
            }

            const normalizedItems =
                items
                    .map(
                        (item) => {

                            const quantity =
                                Number(item.quantity);

                            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
                                return null;
                            }


                            const price =
                                Number(item.price);

                            const productId = safeString(item.id || item.product_id);
                            if (!productId || !/^[0-9a-f-]{36}$/i.test(productId)) {
                                return null;
                            }


                            const description =
                                String(
                                    item.description ||
                                    item.name ||
                                    "Produto MONTÊ"
                                );


                            const sku =
                                String(
                                    item.sku ||
                                    ""
                                ).trim();


                            /*
                               Produto normal
                            */

                            if (
                                !Number.isFinite(
                                    price
                                ) ||
                                price <= 0
                            ) {

                                return null;

                            }


                            if (
                                !Number.isFinite(
                                    quantity
                                ) ||
                                quantity <= 0
                            ) {

                                return null;

                            }


                            /*
                               Para o fluxo de venda,
                               produtos precisam ter SKU.
                            */

                            if (
                                !sku
                            ) {

                                console.warn(
                                    "⚠️ Produto sem SKU:",
                                    description
                                );

                            }


                            return {

                                id:
                                    productId,

                                name:
                                    item.name ||
                                    description,

                                description:
                                    description,

                                sku:
                                    sku,

                                variant_id:
                                    item.variant_id ||
                                    null,

                                variant_color:
                                    item.variant_color ||
                                    null,

                                variant_sku:
                                    item.variant_sku ||
                                    null,

                                quantity:
                                    quantity,

                                price:
                                    Number(
                                        price.toFixed(2)
                                    )

                            };

                        }
                    )
                    .filter(
                        Boolean
                    );


            /* =================================================
               RECALCULA PREÇOS NO SERVIDOR
               Nunca confia no preço salvo no navegador.
            ================================================= */
            for (const item of normalizedItems) {
                if (String(item.sku || "").toUpperCase() === "FRETE") continue;
                const productRows = await supabaseRequest(
                    "products?id=eq." + encodeURIComponent(item.id || item.product_id || "") +
                    "&active=eq.true&select=id,name,price,sale_price,is_sale"
                );
                const product = Array.isArray(productRows) ? productRows[0] : null;
                if (!product) {
                    return res.status(400).json({success:false,message:"Produto inválido ou indisponível."});
                }
                const serverPrice = product.is_sale && product.sale_price != null ? Number(product.sale_price) : Number(product.price);
                if (!Number.isFinite(serverPrice) || serverPrice <= 0) {
                    return res.status(400).json({success:false,message:"Produto sem preço válido."});
                }
                item.price = Number(serverPrice.toFixed(2));
                item.name = product.name || item.name;
                item.description = product.name || item.description;
            }

            /* =================================================
               CONFIRMA PRODUTOS VÁLIDOS
            ================================================= */

            if (
                normalizedItems.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Nenhum produto válido foi encontrado."

                });

            }


            /* =================================================
               FRETE
            ================================================= */

            // Frete: Fortaleza capital R$ 15,00.
            // O backend calcula novamente para não confiar no navegador.
            const productItems =
                normalizedItems.filter(
                    item =>
                        String(item.sku || "").toUpperCase() !== "FRETE"
                );

            const deliveryCity = normalizeCity(customer.address.city);
            const deliveryState = safeString(customer.address.state).toUpperCase();
            const localShipping = localShippingOption(deliveryCity, deliveryState);
            let shippingOption = null;

            if (localShipping) {
                shippingOption = localShipping;
            } else {
                const shippingServiceId = safeString(requestedShippingServiceId);
                if (!shippingServiceId) {
                    return res.status(400).json({
                        success: false,
                        message: "Selecione uma modalidade de frete."
                    });
                }

                const quotes = await calculateSuperfreteQuotes({
                    toCep: customer.address.cep,
                    items: productItems
                });

                shippingOption = quotes.find(option => option.id === shippingServiceId) || null;

                if (!shippingOption) {
                    return res.status(409).json({
                        success: false,
                        message: "A modalidade de frete selecionada não está mais disponível. Calcule o frete novamente."
                    });
                }
            }

            const shippingValue = Number(shippingOption.price.toFixed(2));


            /* =================================================
               VERIFICA SE SOBROU PRODUTO
            ================================================= */

            if (
                productItems.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Nenhum produto foi encontrado no pedido."

                });

            }

            /* =================================================
               VALIDA VARIAÇÕES E ESTOQUE NO SUPABASE
            ================================================= */
            for (const item of productItems) {
                const productId = item.id || item.product_id || null;
                if (!productId) {
                    return res.status(400).json({
                        success: false,
                        message: "Produto inválido no pedido."
                    });
                }
                item.id = productId;

                // Se o produto tiver apenas uma variação ativa em estoque,
                // ela é selecionada automaticamente. A cliente não precisa
                // escolher uma cor/variação quando não existe uma escolha real.
                let variant = null;

                if (item.variant_id) {
                    const variants = await supabaseRequest(
                        "product_variants?id=eq." + encodeURIComponent(item.variant_id) +
                        "&product_id=eq." + encodeURIComponent(item.id) +
                        "&active=eq.true&select=id,color,sku,stock",
                        { method: "GET" }
                    );

                    variant = Array.isArray(variants) ? variants[0] : null;
                } else {
                    const variants = await supabaseRequest(
                        "product_variants?product_id=eq." + encodeURIComponent(item.id) +
                        "&active=eq.true&stock=gt.0&select=id,color,sku,stock&order=created_at.asc",
                        { method: "GET" }
                    );

                    if (Array.isArray(variants) && variants.length === 1) {
                        variant = variants[0];
                        item.variant_id = variant.id;
                    }
                }

                if (!variant) {
                    return res.status(400).json({
                        success: false,
                        message: "A variação selecionada não está disponível."
                    });
                }

                if (Number(variant.stock || 0) < Number(item.quantity || 0)) {
                    return res.status(409).json({
                        success: false,
                        message: "Estoque insuficiente para " + item.description +
                            (item.variant_color ? " (" + item.variant_color + ")" : "") + "."
                    });
                }

                item.variant_color = variant.color;
                item.variant_sku = variant.sku || item.sku || null;
            }


            /* =================================================
               ORDER NSU
            ================================================= */

            const orderNsu = `MONTE-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

            const orderCodeRows = await supabaseRequest("rpc/next_monte_order_code", { method: "POST" });
            const orderCode = Array.isArray(orderCodeRows) ? orderCodeRows[0] : orderCodeRows;
            if (!orderCode || !/^\d{4}$/.test(String(orderCode))) {
                throw new Error("Não foi possível gerar o número de pedido da MONTÊ.");
            }


            /* =================================================
               SALVA O PEDIDO ANTES DO PAGAMENTO
            ================================================= */

            const pendingOrder = {

                order_nsu:
                    orderNsu,

                order_code:
                    String(orderCode),

                customer: {

                    name:
                        customerName,

                    email:
                        customerEmail,

                    phone:
                        customerPhone,

                    whatsapp_phone:
                        customerWhatsapp,

                    whatsapp_updates:
                        customer.whatsapp_updates === true,

                    cpf:
                        customerCpf,

                    address:
                        customer.address
                            ? {

                                cep:
                                    customer.address.cep ||
                                    "",

                                street:
                                    customer.address.street ||
                                    "",

                                neighborhood:
                                    customer.address.neighborhood ||
                                    "",

                                number:
                                    customer.address.number ||
                                    "",

                                complement:
                                    customer.address.complement ||
                                    "",

                                city:
                                    customer.address.city ||
                                    "",

                                state:
                                    customer.address.state ||
                                    ""

                            }
                            : null

                },

                items:
                    productItems,

                shipping: {
                    value: Number(shippingValue.toFixed(2)),
                    service_id: shippingOption.id,
                    service_name: shippingOption.name,
                    delivery_days: shippingOption.delivery_days || shippingOption.delivery_max_days || null
                },

                created_at:
                    Date.now(),

                payment_confirmed:
                    false,};


            const subtotal = Number(productItems.reduce(
                (sum, item) => sum + Number(item.price) * Number(item.quantity), 0
            ).toFixed(2));

            // O desconto de 5% do Pix incide somente sobre os produtos.
            // O frete permanece integral.
            const pixDiscount = paymentMethod === "pix"
                ? Number((subtotal * 0.05).toFixed(2))
                : 0;

            const checkoutProductSubtotal = Number(
                (subtotal - pixDiscount).toFixed(2)
            );

            const checkoutTotal = Number(
                (checkoutProductSubtotal + shippingValue).toFixed(2)
            );

            const savedOrders = await supabaseRequest("orders", {
                method: "POST",
                body: JSON.stringify({
                    order_nsu: orderNsu,
                    order_code: String(orderCode),
                    customer_name: pendingOrder.customer.name,
                    customer_email: pendingOrder.customer.email,
                    customer_phone: pendingOrder.customer.phone,
                    customer_whatsapp: pendingOrder.customer.whatsapp_phone || "",
                    customer_cpf: pendingOrder.customer.cpf,
                    customer_address: pendingOrder.customer.address,
                    subtotal: Number(subtotal.toFixed(2)),
                    shipping: Number(shippingValue.toFixed(2)),
                    shipping_service_id: shippingOption.id,
                    shipping_service_name: shippingOption.name,
                    shipping_delivery_days: shippingOption.delivery_days || shippingOption.delivery_max_days || null,
                    total: checkoutTotal,
                    status: "pending",
                    payment_method: paymentMethod,
                    whatsapp_tracking_opt_in: customer.whatsapp_updates === true,
                    whatsapp_tracking_status: customer.whatsapp_updates === true ? "pending" : "opted_out",
                    items: productItems
                })
            });

            const savedOrder = Array.isArray(savedOrders) ? savedOrders[0] : savedOrders;

            await supabaseRequest("order_items", {
                method: "POST",
                body: JSON.stringify(productItems.map(item => ({
                    order_id: savedOrder.id,
                    product_id: item.id || null,
                    variant_id: item.variant_id || null,
                    variant_color: item.variant_color || null,
                    sku: item.variant_sku || item.sku || null,
                    product_name: item.name,
                    quantity: item.quantity,
                    unit_price: item.price,
                    total_price: Number((item.price * item.quantity).toFixed(2))
                })))
            });

            savePendingOrder(
                pendingOrder
            );

            /* =================================================
               PIX DIRETO NO SITE MONTÊ
               Pix não passa pela InfinitePay. O QR Code e o
               Pix Copia e Cola são gerados aqui com o valor final
               (5% de desconto somente nos produtos + frete integral).
            ================================================= */
            if (paymentMethod === "pix") {
                const pixPayload = buildPixPayload(checkoutTotal, String(orderCode));

                console.log("🟢 Pix direto gerado no site:", orderNsu, checkoutTotal);

                return res.status(200).json({
                    success: true,
                    direct_pix: true,
                    pix_payload: pixPayload,
                    amount: checkoutTotal,
                    order_nsu: orderNsu,
                    order_code: String(orderCode),
                    status: "pending"
                });
            }

            /* =================================================
               INFINITEPAY SOMENTE PARA CARTÃO
            ================================================= */

            const infinitePayItems =
                productItems.map((item) => ({
                    quantity: item.quantity,
                    price: Math.round(item.price * 100),
                    description: item.description
                }));

            if (shippingValue > 0) {
                infinitePayItems.push({
                    quantity: 1,
                    price: Math.round(shippingValue * 100),
                    description: shippingOption.name
                });
            }

            /* =================================================
               PAYLOAD INFINITEPAY
            ================================================= */

            const payload = {

                handle:
                    INFINITEPAY_HANDLE,

                order_nsu:
                    orderNsu,

                redirect_url:
                    `${SITE_URL}/pagamento-sucesso`,

                webhook_url:
                    `${SITE_URL}/webhook-infinitepay`,

                items:
                    infinitePayItems,

                customer: {

                    name:
                        String(
                            customer.name
                        ),

                    email:
                        String(
                            customer.email
                        ),

                    phone_number:
                        String(
                            customer.phone
                        )

                }

            };


            /* =================================================
               ENDEREÇO PARA INFINITEPAY
            ================================================= */

            if (
                customer.address
            ) {

                payload.address = {

                    cep:
                        customer.address.cep ||
                        "",

                    street:
                        customer.address.street ||
                        "",

                    neighborhood:
                        customer.address.neighborhood ||
                        "",

                    number:
                        customer.address.number ||
                        "",

                    complement:
                        customer.address.complement ||
                        ""

                };

            }


            /* =================================================
               LOG
            ================================================= */

            console.log(
                "📦 Pedido salvo:",
                orderNsu
            );

            console.log(
                "💰 Valor do frete:",
                shippingValue
            );

            console.log(
                "🛍️ Quantidade de produtos:",
                productItems.length
            );

            console.log(
                "📤 Enviando checkout para InfinitePay..."
            );


            /* =================================================
               CHAMADA REAL DA INFINITEPAY
            ================================================= */

            const infinitePayStartedAt = Date.now();
            const response = await fetchWithTimeout(
                INFINITEPAY_API,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    },
                    body: JSON.stringify(payload)
                },
                15000
            );
            console.log("📥 InfinitePay respondeu em", Date.now() - infinitePayStartedAt, "ms");


            /* =================================================
               LÊ RESPOSTA
            ================================================= */

            const responseText =
                await response.text();


            let data;


            try {

                data =
                    JSON.parse(
                        responseText
                    );

            } catch {

                data = {

                    raw:
                        responseText

                };

            }


            /* =================================================
               ERRO INFINITEPAY
            ================================================= */

            if (
                !response.ok
            ) {

                /*
                   Se o checkout falhar, removemos o pedido
                   temporário para não deixar lixo na memória.
                */

                pendingOrders.delete(
                    orderNsu
                );


                console.error(
                    "❌ InfinitePay respondeu com erro."
                );

                console.error(
                    "Status:",
                    response.status
                );

                console.error(
                    "Resposta:",
                    data
                );


                return res.status(
                    response.status
                ).json({

                    success:
                        false,

                    message:
                        "A InfinitePay recusou a criação do checkout.",

                    error:
                        data

                });

            }


            /* =================================================
               VERIFICA URL
            ================================================= */

            if (
                !data ||
                !data.url
            ) {

                pendingOrders.delete(
                    orderNsu
                );


                console.error(
                    "❌ InfinitePay não retornou URL."
                );

                console.error(
                    data
                );


                return res.status(502).json({

                    success:
                        false,

                    message:
                        "A InfinitePay não retornou o link de pagamento.",

                    error:
                        data

                });

            }


            /* =================================================
               SUCESSO
            ================================================= */

            console.log(
                "✅ Checkout InfinitePay criado."
            );

            console.log(
                "🔑 Order NSU:",
                orderNsu
            );


            return res.status(200).json({

                success:
                    true,

                url:
                    data.url,

                order_nsu:
                    orderNsu

            });


        } catch (error) {

            console.error(
                "❌ ERRO INTERNO NO CHECKOUT:"
            );

            console.error(
                error
            );


            return res.status(500).json({

                success:
                    false,

                message:
                    "Erro interno ao criar checkout.",

                error:
                    process.env.NODE_ENV ===
                    "development"
                        ? error.message
                        : undefined

            });

        }

    }
);
/* =====================================================
   INFINITEPAY
   WEBHOOK DE PAGAMENTO
===================================================== */

async function verifyInfinitePayPayment({ orderNsu, transactionNsu, invoiceSlug, expectedAmount }) {
    const response = await fetch("https://api.checkout.infinitepay.io/payment_check", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({
            handle: INFINITEPAY_HANDLE,
            order_nsu: orderNsu,
            transaction_nsu: transactionNsu,
            slug: invoiceSlug
        })
    });

    const responseText = await response.text();
    let data;
    try {
        data = responseText ? JSON.parse(responseText) : {};
    } catch {
        data = { raw: responseText };
    }

    if (!response.ok) {
        throw new Error(`InfinitePay payment_check ${response.status}: ${JSON.stringify(data)}`);
    }

    if (data.success !== true || data.paid !== true) {
        return { verified: false, data };
    }

    const returnedAmount = Number(data.amount);
    const expectedCents = Math.round(Number(expectedAmount || 0) * 100);

    if (!Number.isFinite(returnedAmount) || returnedAmount !== expectedCents) {
        throw new Error(
            `Valor do pagamento divergente. Esperado: ${expectedCents} centavos; recebido: ${returnedAmount} centavos.`
        );
    }

    return { verified: true, data };
}

app.post(
    "/webhook-infinitepay",
    infinitePayWebhookRateLimit,
    async (req, res) => {
        try {
            const webhook = req.body || {};
            const orderNsu = safeString(webhook.order_nsu);
            const transactionNsu = safeString(webhook.transaction_nsu);
            const invoiceSlug = safeString(webhook.invoice_slug || webhook.slug);

            console.log("💳 Webhook da InfinitePay recebido:", orderNsu);

            if (!orderNsu || !transactionNsu || !invoiceSlug) {
                return res.status(400).json({
                    success: false,
                    message: "Webhook sem order_nsu, transaction_nsu ou invoice_slug."
                });
            }

            const persistedOrders = await supabaseRequest(
                `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}&select=*`,
                { method: "GET" }
            );
            const order = Array.isArray(persistedOrders) ? persistedOrders[0] : null;

            if (!order) {
                console.error("❌ Pedido não encontrado:", orderNsu);
                return res.status(400).json({
                    success: false,
                    message: "Pedido não encontrado."
                });
            }

            // Webhook repetido do mesmo pagamento: já está conciliado.
            if (
                order.status === "paid" &&
                order.transaction_nsu === transactionNsu &&
                order.stock_decremented === true
            ) {
                processedPayments.add(orderNsu);
                const confirmationEmail = await ensureOrderConfirmationEmail(order);
                const adminSaleEmail = await ensureAdminSaleNotificationEmail(order);
                const adminWhatsApp = await ensureWhatsAppAdminNewOrderNotification(order);
                return res.status(200).json({
                    success: true,
                    already_processed: true,
                    confirmation_email: confirmationEmail.status
                });
            }

            const status = safeString(
                webhook.status ||
                webhook.payment_status ||
                webhook.current_status ||
                webhook.transaction_status
            ).toLowerCase();

            const failedStatuses = [
                "failed", "failure", "cancelled", "canceled",
                "refused", "rejected", "denied", "expired"
            ];

            if (failedStatuses.includes(status)) {
                console.log("ℹ️ Pagamento não aprovado:", orderNsu, status);
                return res.status(200).json({
                    success: true,
                    paid: false,
                    message: "Pagamento não aprovado."
                });
            }

            // A InfinitePay recomenda consultar payment_check para confirmar
            // que o order_nsu/transaction_nsu/slug correspondem a um pagamento pago.
            const verification = await verifyInfinitePayPayment({
                orderNsu,
                transactionNsu,
                invoiceSlug,
                expectedAmount: order.total
            });

            if (!verification.verified) {
                console.warn("⏳ Pagamento ainda não confirmado:", orderNsu);
                return res.status(400).json({
                    success: false,
                    message: "Pagamento ainda não confirmado pela InfinitePay."
                });
            }

            const payment = verification.data;
            const paidAmount = Number(payment.paid_amount ?? webhook.paid_amount ?? 0);
            const resolvedPaymentMethod = payment.capture_method === "pix" ? "pix" : "credit_card";

            // Baixa atômica e idempotente. A função bloqueia o pedido e usa
            // stock_decremented para impedir duas baixas do mesmo pedido.
            const stockResult = await supabaseRequest("rpc/decrement_order_stock", {
                method: "POST",
                body: JSON.stringify({ p_order_id: order.id })
            });

            console.log("📦 Baixa de estoque:", stockResult);

            // Persiste o pagamento. Em caso de webhook simultâneo, a restrição
            // UNIQUE de transaction_nsu evita duplicidade.
            const existingPayments = await supabaseRequest(
                `payments?transaction_nsu=eq.${encodeURIComponent(transactionNsu)}&select=id`,
                { method: "GET" }
            );

            if (!Array.isArray(existingPayments) || !existingPayments[0]?.id) {
                try {
                    await supabaseRequest("payments", {
                        method: "POST",
                        body: JSON.stringify({
                            order_id: order.id,
                            order_nsu: orderNsu,
                            transaction_nsu: transactionNsu,
                            invoice_slug: invoiceSlug,
                            amount: Number(payment.amount || 0) / 100,
                            paid_amount: Number.isFinite(paidAmount)
                                ? paidAmount / 100
                                : null,
                            installments: payment.installments || webhook.installments || null,
                            capture_method: payment.capture_method || webhook.capture_method || null,
                            receipt_url: webhook.receipt_url || null,
                            status: "paid",
                            webhook_data: {
                                webhook,
                                payment_check: payment
                            }
                        })
                    });
                } catch (paymentError) {
                    // Se outro webhook inseriu o mesmo transaction_nsu em paralelo,
                    // a restrição UNIQUE torna a operação idempotente.
                    if (!String(paymentError.message || "").includes("409")) {
                        throw paymentError;
                    }
                }
            }

            await supabaseRequest(
                `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        status: "paid",
                        payment_method: resolvedPaymentMethod,
                        invoice_slug: invoiceSlug,
                        transaction_nsu: transactionNsu,
                        receipt_url: webhook.receipt_url || null,
                        installments: payment.installments || webhook.installments || null,
                        capture_method: payment.capture_method || webhook.capture_method || null,
                        paid_amount: Number.isFinite(paidAmount)
                            ? paidAmount / 100
                            : null,
                        paid_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                }
            );

            order.payment_method = resolvedPaymentMethod;

            const confirmationEmail = await ensureOrderConfirmationEmail({
                ...order,
                id: order.id,
                order_nsu: orderNsu,
                customer_name: order.customer_name,
                customer_email: order.customer_email,
                total: order.total,
                order_confirmation_email_sent_at: null
            });

            const adminSaleEmail = await ensureAdminSaleNotificationEmail({
                ...order, id: order.id, order_nsu: orderNsu, order_code: order.order_code,
                customer_name: order.customer_name, customer_email: order.customer_email,
                customer_phone: order.customer_phone, customer_whatsapp: order.customer_whatsapp,
                customer_address: order.customer_address, payment_method: order.payment_method,
                shipping: order.shipping, total: order.total, items: order.items,
                admin_sale_email_sent_at: order.admin_sale_email_sent_at
            });

            const adminWhatsApp = await ensureWhatsAppAdminNewOrderNotification({
                ...order,
                id: order.id,
                order_nsu: orderNsu,
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                customer_whatsapp: order.customer_whatsapp,
                customer_cpf: order.customer_cpf,
                customer_address: order.customer_address,
                payment_method: order.payment_method,
                total: order.total,
                items: order.items,
                whatsapp_admin_notification_sent_at: order.whatsapp_admin_notification_sent_at,
                whatsapp_admin_notification_message_id: order.whatsapp_admin_notification_message_id
            });

            processedPayments.add(orderNsu);

            console.log("✅ Pagamento confirmado, estoque baixado, notificações processadas e pedido conciliado:", orderNsu);

            return res.status(200).json({
                success: true,
                paid: true,
                order_nsu: orderNsu,
                confirmation_email: confirmationEmail.status,
                    admin_sale_email: adminSaleEmail.status,
                    whatsapp_admin_notification: adminWhatsApp.status
            });

        } catch (error) {
            console.error("❌ ERRO NO WEBHOOK DA INFINITEPAY:", error);

            return res.status(500).json({
                success: false,
                message: "Erro interno no processamento do pagamento."
            });
        }
    }
);

/* =====================================================
   MINHAS COMPRAS — CONSULTA SEGURA POR PEDIDO + E-MAIL
===================================================== */

app.get("/api/minhas-compras", orderStatusRateLimit, async (req, res) => {
    try {
        const orderNsu = normalizeOrderCode(req.query.order_nsu);
        const email = safeString(req.query.email).toLowerCase();

        if (!orderNsu || !email || orderNsu.length > 80 || email.length > 160) {
            return res.status(400).json({ success: false, message: "Informe o número do pedido e o e-mail usado na compra." });
        }

        const rows = await supabaseRequest(
            `orders?${/^\d{4}$/.test(orderNsu) ? "order_code=eq."+encodeURIComponent(orderNsu) : "order_nsu=eq."+encodeURIComponent(orderNsu)}&customer_email=eq.${encodeURIComponent(email)}&select=id,order_nsu,order_code,customer_name,customer_email,status,total,subtotal,shipping,shipping_carrier,tracking_code,tracking_url,shipping_service_name,created_at,paid_at,processing_at,shipped_at,delivered_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)`,
            { method: "GET" }
        );

        const order = Array.isArray(rows) ? rows[0] : null;
        if (!order) {
            return res.status(404).json({ success: false, message: "Não encontramos um pedido com esses dados." });
        }

        return res.json({
            success: true,
            order: {
                order_nsu: order.order_nsu,
                order_code: formatOrderCode(order.order_code || order.order_nsu),
                customer_name: order.customer_name,
                status: order.status,
                subtotal: Number(order.subtotal || 0),
                shipping: Number(order.shipping || 0),
                total: Number(order.total || 0),
                shipping_carrier: order.shipping_carrier || null,
                tracking_code: order.tracking_code || null,
                tracking_url: order.tracking_url || null,
                shipping_service_name: order.shipping_service_name || null,
                created_at: order.created_at,
                paid_at: order.paid_at,
                processing_at: order.processing_at,
                shipped_at: order.shipped_at,
                delivered_at: order.delivered_at,
                items: (order.order_items || []).map(item => ({
                    product_name: item.product_name,
                    variant_color: item.variant_color,
                    sku: item.sku,
                    quantity: Number(item.quantity || 0),
                    unit_price: Number(item.unit_price || 0),
                    total_price: Number(item.total_price || 0)
                }))
            }
        });
    } catch (error) {
        console.error("❌ Minhas compras:", error);
        return res.status(500).json({ success: false, message: "Não foi possível consultar o pedido." });
    }
});

/* =====================================================
   STATUS DO PEDIDO PARA A PÁGINA DE SUCESSO
===================================================== */
app.get("/api/pedido-confirmacao", orderStatusRateLimit, async (req, res) => {
    try {
        const orderNsu = safeString(req.query.order_nsu);
        if (!orderNsu) return res.status(400).json({ success: false, message: "Pedido não informado." });

        const rows = await supabaseRequest(
            "orders?order_nsu=eq." + encodeURIComponent(orderNsu) +
            "&select=id,order_nsu,order_code,customer_name,status,total,subtotal,shipping,payment_method,created_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)",
            { method: "GET" }
        );
        const order = Array.isArray(rows) ? rows[0] : null;
        if (!order) return res.status(404).json({ success: false, message: "Pedido não encontrado." });

        return res.json({
            success: true,
            order: {
                order_nsu: order.order_nsu,
                order_code: formatOrderCode(order.order_code || order.order_nsu),
                customer_name: order.customer_name,
                status: order.status,
                payment_method: order.payment_method,
                subtotal: Number(order.subtotal || 0),
                shipping: Number(order.shipping || 0),
                total: Number(order.total || 0),
                created_at: order.created_at,
                pix_payload: order.payment_method === "pix" ? buildPixPayload(Number(order.total || 0), String(order.order_code || order.order_nsu)) : null,
                items: (order.order_items || []).map(item => ({
                    product_name: item.product_name,
                    variant_color: item.variant_color,
                    sku: item.sku,
                    quantity: Number(item.quantity || 0),
                    unit_price: Number(item.unit_price || 0),
                    total_price: Number(item.total_price || 0)
                }))
            }
        });
    } catch (error) {
        console.error("❌ Erro na confirmação do pedido:", error);
        return res.status(500).json({ success: false, message: "Não foi possível carregar o pedido." });
    }
});

app.get("/api/pedido-status", orderStatusRateLimit, async (req, res) => {
    try {
        const orderNsu = safeString(req.query.order_nsu);
        const transactionNsu = safeString(req.query.transaction_nsu);

        if (!orderNsu || !transactionNsu) {
            return res.status(400).json({
                success: false,
                message: "Identificadores do pedido não informados."
            });
        }

        const rows = await supabaseRequest(
            `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}&transaction_nsu=eq.${encodeURIComponent(transactionNsu)}&select=id,order_nsu,order_code,status,total,shipping,receipt_url,created_at,paid_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)`,
            { method: "GET" }
        );

        const order = Array.isArray(rows) ? rows[0] : null;

        if (!order || order.status !== "paid") {
            return res.status(404).json({
                success: false,
                message: "Pedido pago não encontrado."
            });
        }

        return res.json({
            success: true,
            order: {
                order_nsu: order.order_nsu,
                order_code: formatOrderCode(order.order_code || order.order_nsu),
                status: order.status,
                total: Number(order.total || 0),
                shipping: Number(order.shipping || 0),
                receipt_url: order.receipt_url || null,
                created_at: order.created_at,
                paid_at: order.paid_at,
                items: (order.order_items || []).map(item => ({
                    product_name: item.product_name,
                    variant_color: item.variant_color,
                    sku: item.sku,
                    quantity: Number(item.quantity || 0),
                    unit_price: Number(item.unit_price || 0),
                    total_price: Number(item.total_price || 0)
                }))
            }
        });
    } catch (error) {
        console.error("❌ Erro ao consultar pedido:", error);
        return res.status(500).json({
            success: false,
            message: "Não foi possível consultar o pedido."
        });
    }
});

/* =====================================================
   PÁGINA DE SUCESSO
===================================================== */
app.get(
    "/pagamento-sucesso",
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                "..",
                "pagamento-sucesso.html"
            )
        );
    }
);


/* =====================================================
   INICIAR SERVIDOR
===================================================== */

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 Backend MONTÊ rodando na porta ${PORT}`
        );

        console.log(
            `💳 InfinitePay configurada para: ${INFINITEPAY_HANDLE}`
        );
}
);