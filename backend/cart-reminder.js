// Lembrete da sacola: a loja é avisada para chamar no WhatsApp quem digitou o celular no
// checkout e não terminou a compra. Vale para todas as clientes, com ou sem a permissão de
// cookies. Base legal: legítimo interesse (LGPD art. 7º, IX, e art. 10), com o mínimo de dados,
// aviso no checkout e a opção "Não quero" (veja docs/teste-legitimo-interesse-lembrete-sacola.md
// e a Política de Privacidade).
//
// - Sem cookies: o código da sacola (cart_key) fica só na memória da página. Com a permissão de
//   estatísticas, a sacola também guarda o código de visitante, como antes.
// - Sem as estatísticas, a sacola só é guardada se houver um celular válido: sem ele, não há
//   lembrete e, portanto, nada a guardar.
// - Só nome e celular. O e-mail não é guardado, porque o contato é pelo WhatsApp.
// - O nome e o celular saem depois de 30 dias (CART_CONTACT_RETENTION_MS); a sacola guardada só
//   para o lembrete sai inteira nesse prazo.

const CART_CONTACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CART_FOLLOWUP_OPT_OUT = "Se preferir não receber esse tipo de mensagem, é só me avisar.";

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

// O que fazer com a sacola que o site mandou:
// - "save": guardar (contact traz nome e celular, ou tudo vazio);
// - "forget": apagar o contato daquela sacola (e a sacola inteira, se ela não tem código de visitante);
// - "invalid": sem o código da sacola.
// A versão antiga do site (ainda em cache em alguns aparelhos) manda só session_id: vira a chave.
function cartSnapshotPlan(body) {
    const b = body && typeof body === "object" ? body : {};
    const cartKey = text(b.cart_key, 120) || text(b.session_id, 120);
    if (!cartKey) return { action: "invalid" };
    if (b.forget_contact === true) return { action: "forget", cartKey };
    const visitorId = text(b.visitor_id, 120) || null;
    const mobile = brazilMobileDigits(b.customer_phone);
    if (!visitorId && !mobile) return { action: "forget", cartKey };
    return {
        action: "save",
        cartKey,
        visitorId,
        analyticsSession: visitorId ? text(b.session_id, 120) : "",
        contact: {
            customer_name: mobile ? text(b.customer_name, 160) || null : null,
            customer_phone: mobile ? formatBrazilMobile(mobile) : null,
            customer_email: null
        }
    };
}

// Mensagem que a loja manda para a cliente (abre pronta no WhatsApp da loja, dá para editar).
// shortMessage: sem o link, quando o endereço do WhatsApp ficaria comprido demais.
function abandonedCartMessages({ firstName, pieces, cartUrl }) {
    const greeting = "Oi" + (firstName ? ", " + firstName : "") + "! Aqui é da MONTÊ. Vi que você deixou " +
        pieces + " na sacola. Ficou alguma dúvida? Posso te ajudar a finalizar.";
    return {
        message: greeting + " Sua sacola está aqui: " + cartUrl + " " + CART_FOLLOWUP_OPT_OUT,
        shortMessage: greeting + " " + CART_FOLLOWUP_OPT_OUT
    };
}

module.exports = { CART_CONTACT_RETENTION_MS, CART_FOLLOWUP_OPT_OUT, brazilMobileDigits, formatBrazilMobile, cartSnapshotPlan, abandonedCartMessages };
