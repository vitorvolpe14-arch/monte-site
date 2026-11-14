// Lembrete da sacola por e-mail: quem digitou o e-mail no checkout e não terminou a compra
// recebe um e-mail, uma vez, com as peças e o botão para voltar à sacola. Vale para todas as
// clientes, com ou sem a permissão de cookies. Base legal: legítimo interesse (LGPD art. 7º, IX,
// e art. 10), com o mínimo de dados, aviso no checkout, a opção "Não quero" e o link para não
// receber mais no próprio e-mail (veja docs/teste-legitimo-interesse-lembrete-sacola.md e a
// Política de Privacidade).
//
// - Sem cookies: o código da sacola (cart_key) fica só na memória da página. Com a permissão de
//   estatísticas, a sacola também guarda o código de visitante, como antes.
// - Sem as estatísticas, a sacola só é guardada se houver um e-mail válido: sem ele, não há
//   lembrete e, portanto, nada a guardar.
// - Só nome e e-mail. O WhatsApp não é guardado para o lembrete.
// - O nome e o e-mail saem depois de 30 dias (CART_CONTACT_RETENTION_MS); a sacola guardada só
//   para o lembrete sai inteira nesse prazo.
// - Quem pede para não receber mais fica numa lista com só um código do e-mail (sha-256).

const crypto = require("crypto");

const CART_CONTACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CART_REMINDER_OPTOUT_PREFIX = "cart_reminder_optout:";
const STORE_WHATSAPP = "(85) 99216-3305";

// Celular com DDD e 9 dígitos (aceita o +55 na frente). Devolve só os 11 dígitos, ou "" se não for celular.
function brazilMobileDigits(value) {
    let digits = String(value ?? "").replace(/\D/g, "");
    if (digits.length > 11 && digits.startsWith("55")) digits = digits.slice(2);
    return /^[1-9]{2}9\d{8}$/.test(digits) ? digits : "";
}

function formatBrazilMobile(digits) {
    return "(" + digits.slice(0, 2) + ") " + digits.slice(2, 7) + "-" + digits.slice(7);
}

const text = (value, max) => (typeof value === "string" ? value : value == null ? "" : String(value)).trim().slice(0, max);

// E-mail que pode receber o lembrete (minúsculo, sem espaços), ou "".
function reminderEmail(value) {
    const email = (typeof value === "string" ? value : "").trim().toLowerCase();
    return email.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : "";
}

function cartReminderEmailHash(email) {
    const clean = reminderEmail(email);
    return clean ? crypto.createHash("sha256").update(clean).digest("hex") : "";
}

// Chave da lista de quem pediu para não receber o lembrete (kv_store): só o código do e-mail.
function cartReminderOptOutKey(email) {
    const hash = cartReminderEmailHash(email);
    return hash ? CART_REMINDER_OPTOUT_PREFIX + hash : "";
}

// O que fazer com a sacola que o site mandou:
// - "save": guardar (contact traz nome e e-mail, ou tudo vazio);
// - "forget": apagar o contato daquela sacola (e a sacola inteira, se ela não tem código de visitante);
// - "invalid": sem o código da sacola.
// A versão antiga do site (ainda em cache em alguns aparelhos) manda só session_id: vira a chave.
function cartSnapshotPlan(body) {
    const b = body && typeof body === "object" ? body : {};
    const cartKey = text(b.cart_key, 120) || text(b.session_id, 120);
    if (!cartKey) return { action: "invalid" };
    if (b.forget_contact === true) return { action: "forget", cartKey };
    const visitorId = text(b.visitor_id, 120) || null;
    const email = reminderEmail(b.customer_email);
    if (!visitorId && !email) return { action: "forget", cartKey };
    return {
        action: "save",
        cartKey,
        visitorId,
        analyticsSession: visitorId ? text(b.session_id, 120) : "",
        contact: {
            customer_name: email ? text(b.customer_name, 160) || null : null,
            customer_email: email || null,
            customer_phone: null
        }
    };
}

// Texto do e-mail para a cliente (o servidor monta o HTML com as peças e os links).
function abandonedCartEmail({ firstName }) {
    return {
        subject: "Sua sacola na MONTÊ ficou guardada",
        eyebrow: "SUA SACOLA",
        title: "Oi" + (firstName ? ", " + firstName : "") + "! Sua sacola ficou guardada",
        paragraphs: [
            "Você não terminou a compra, então guardamos as peças para você. É só tocar no botão para voltar à sacola.",
            "Ficou alguma dúvida sobre tamanho, frete ou pagamento? Fale com a gente pelo WhatsApp " + STORE_WHATSAPP + "."
        ],
        buttonText: "VOLTAR PARA A SACOLA",
        footnote: "Você recebeu este e-mail porque começou uma compra no site da MONTÊ. É o único lembrete desta sacola.",
        optOutText: "Não quero receber lembretes da sacola"
    };
}

module.exports = {
    CART_CONTACT_RETENTION_MS, CART_REMINDER_OPTOUT_PREFIX,
    brazilMobileDigits, formatBrazilMobile, reminderEmail, cartReminderEmailHash, cartReminderOptOutKey,
    cartSnapshotPlan, abandonedCartEmail
};
