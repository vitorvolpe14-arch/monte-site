// Notificações do painel no celular (Web Push): venda nova, pagamento pendente e alerta de segurança.
//
// O painel instalado como app (iPhone com iOS 16.4 ou mais novo, Android, computador) assina as
// notificações no admin-push.js e o servidor guarda a assinatura em admin_push_subscriptions.
// Para avisar, o servidor manda a mensagem cifrada ao servidor de notificações do aparelho
// (Apple, Google, Mozilla ou Microsoft), que entrega no celular.
//
// Sem biblioteca: só a Web Crypto, que existe igual no Cloudflare Workers e no Node.
// - VAPID (RFC 8292): a loja se identifica com um token ES256 assinado pela chave dela.
// - Mensagem cifrada (RFC 8291, aes128gcm): só o aparelho que assinou consegue ler.
// As chaves VAPID são criadas na primeira vez e ficam no kv_store (veja server.js).

const subtle = (globalThis.crypto && globalThis.crypto.subtle) || require("crypto").webcrypto.subtle;
const randomBytes = n => {
    const bytes = new Uint8Array(n);
    ((globalThis.crypto && globalThis.crypto.getRandomValues) ? globalThis.crypto : require("crypto").webcrypto).getRandomValues(bytes);
    return bytes;
};

const PUSH_TOPICS = ["sales", "pending", "security"];
const RECORD_SIZE = 4096;
const VAPID_EXPIRES_SECONDS = 12 * 60 * 60;
const MAX_ENDPOINT_LENGTH = 1000;
const MAX_BODY_LENGTH = 180;

// Servidores de notificação dos navegadores. Só para eles o servidor manda alguma coisa:
// um endereço qualquer gravado como "assinatura" não vira chamada para dentro da rede.
const PUSH_HOSTS = new Set(["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com", ".push.services.mozilla.com"];

const utf8 = text => new TextEncoder().encode(String(text));
const b64url = bytes => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = text => new Uint8Array(Buffer.from(String(text || "").replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const isB64url = text => typeof text === "string" && /^[A-Za-z0-9_-]+$/.test(text);

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

function isAllowedPushEndpoint(value) {
    if (typeof value !== "string" || !value || value.length > MAX_ENDPOINT_LENGTH) return false;
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

// Assinatura que o navegador entrega (PushSubscription.toJSON()): endereço e as duas chaves.
function cleanSubscription(input) {
    const endpoint = input && input.endpoint;
    const keys = (input && input.keys) || {};
    if (!isAllowedPushEndpoint(endpoint) || !isB64url(keys.p256dh) || !isB64url(keys.auth)) return null;
    const p256dh = fromB64url(keys.p256dh);
    if (p256dh.length !== 65 || p256dh[0] !== 4 || fromB64url(keys.auth).length !== 16) return null;
    return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

function cleanTopics(value) {
    if (!Array.isArray(value)) return PUSH_TOPICS.slice();
    return PUSH_TOPICS.filter(topic => value.includes(topic));
}

async function hkdf(salt, ikm, info, length) {
    const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// RFC 8291: chave nova a cada mensagem, segredo combinado com a chave do aparelho (ECDH) e o
// "auth" dele; a mensagem vai num registro só, com o delimitador 0x02 no fim.
// salt e localKeys só são passados nos testes (exemplo da RFC).
async function encryptPayload(payload, p256dh, authSecret, { salt = randomBytes(16), localKeys } = {}) {
    const plaintext = typeof payload === "string" ? utf8(payload) : payload;
    const uaPublic = fromB64url(p256dh);
    const auth = fromB64url(authSecret);
    const local = localKeys || await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const asPublic = new Uint8Array(await subtle.exportKey("raw", local.publicKey));
    const uaKey = await subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
    const ikm = await hkdf(auth, ecdhSecret, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
    const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
    const aesKey = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(plaintext, new Uint8Array([2]))));
    const header = new Uint8Array(21);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(16, RECORD_SIZE);
    header[20] = asPublic.length;
    return concat(header, asPublic, ciphertext);
}

async function generateVapidKeys() {
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = b64url(new Uint8Array(await subtle.exportKey("raw", pair.publicKey)));
    const { kty, crv, x, y, d } = await subtle.exportKey("jwk", pair.privateKey);
    return { publicKey, privateJwk: { kty, crv, x, y, d } };
}

// Cabeçalho Authorization: "vapid t=<token>, k=<chave pública>". O token vale para o servidor de
// notificações do aparelho (aud), por 12 horas, e diz quem manda (sub: o endereço da loja).
async function vapidAuthorization(endpoint, vapidKeys, subject, nowSeconds = Math.floor(Date.now() / 1000)) {
    const header = b64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64url(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + VAPID_EXPIRES_SECONDS, sub: subject })));
    const key = await subtle.importKey("jwk", { ...vapidKeys.privateJwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const signature = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(header + "." + claims)));
    return "vapid t=" + header + "." + claims + "." + b64url(signature) + ", k=" + vapidKeys.publicKey;
}

// Manda uma mensagem a um aparelho. gone: o aparelho saiu (desinstalou, desativou) e a
// assinatura pode ser apagada. Nunca lança erro: devolve o que aconteceu.
async function sendWebPush(subscription, message, { vapidKeys, subject, ttl = 24 * 60 * 60, urgency = "high", fetchImpl = (...args) => fetch(...args) } = {}) {
    if (!isAllowedPushEndpoint(subscription && subscription.endpoint)) return { ok: false, status: 0, gone: true, error: "endereço não permitido" };
    let body;
    try {
        body = await encryptPayload(JSON.stringify(message), subscription.p256dh, subscription.auth);
    } catch (error) {
        return { ok: false, status: 0, gone: true, error: "chaves do aparelho inválidas" };
    }
    try {
        const response = await fetchImpl(subscription.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Encoding": "aes128gcm",
                "TTL": String(ttl),
                "Urgency": urgency,
                "Authorization": await vapidAuthorization(subscription.endpoint, vapidKeys, subject)
            },
            body,
            ...(typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(10000) } : {})
        });
        const text = response.ok ? "" : String(await response.text().catch(() => "")).slice(0, 200);
        return { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410, error: text };
    } catch (error) {
        return { ok: false, status: 0, gone: false, error: String((error && error.message) || error).slice(0, 200) };
    }
}

/* ---------- Textos das notificações ---------- */
function money(value) {
    return "R$ " + Number(value || 0).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function clip(text, max = MAX_BODY_LENGTH) {
    const clean = String(text || "").trim();
    return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}
function piecesLine(items) {
    return (Array.isArray(items) ? items : []).map(item => {
        const name = String(item.name || item.product_name || "Peça").trim();
        const color = String(item.variant_color || item.color || "").trim();
        const qty = Math.max(1, Number(item.quantity || 1));
        return (qty > 1 ? qty + "x " : "") + name + (color ? " (" + color + ")" : "") + (item.gift === true ? " (presente)" : "");
    }).join(", ");
}
const orderUrl = id => "/admin#pedido=" + encodeURIComponent(String(id));

// Pagamento confirmado. toShip: pedidos para separar e enviar (número no ícone do app).
function salePushMessage(order, { code, toShip } = {}) {
    const presale = order.approval_status === "pending";
    const head = (order.pix_paid_by_card ? "Atenção: desconto do Pix pago no cartão. " : "") +
        [code, String(order.customer_name || "").trim()].filter(Boolean).join(" · ");
    const pieces = piecesLine(order.items);
    const message = {
        title: (presale ? "Pré-venda: aceite ou recuse · " : "Venda nova · ") + money(order.total),
        body: clip(head + (pieces ? "\n" + pieces : "")),
        url: orderUrl(order.id),
        tag: "pedido-" + order.id
    };
    if (Number.isFinite(toShip)) message.badge = toShip;
    return message;
}

// Pedido sem pagamento há 30 minutos: o toque abre a conversa com a cliente no WhatsApp,
// com a mensagem pronta (o mesmo link do e-mail para a loja).
function pendingPushMessage({ id, name, code, total, whatsappUrl }) {
    return {
        title: "Pagamento pendente há 30 min",
        body: clip((name || "Cliente") + " não concluiu o pedido " + code + " (" + money(total) + "). Toque para chamar no WhatsApp."),
        url: /^https:\/\/wa\.me\//.test(String(whatsappUrl || "")) ? whatsappUrl : orderUrl(id),
        fallbackUrl: orderUrl(id),
        tag: "pendente-" + id
    };
}

function securityPushMessage(subject, message) {
    return { title: clip("Segurança: " + subject, 80), body: clip(message), url: "/admin", tag: "seguranca" };
}

module.exports = {
    PUSH_TOPICS, b64url, fromB64url, isAllowedPushEndpoint, cleanSubscription, cleanTopics,
    encryptPayload, generateVapidKeys, vapidAuthorization, sendWebPush,
    salePushMessage, pendingPushMessage, securityPushMessage
};
