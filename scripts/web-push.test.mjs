// Testes das notificações do painel no celular (backend/web-push.js), sem chamar a Apple nem o Google.
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const crypto = require("crypto");
const webPush = require("../backend/web-push.js");
const { b64url, fromB64url, encryptPayload, generateVapidKeys, vapidAuthorization, isAllowedPushEndpoint,
    cleanSubscription, cleanTopics, sendWebPush, salePushMessage, pendingPushMessage, securityPushMessage, PUSH_TOPICS } = webPush;

const subtle = crypto.webcrypto.subtle;

// Par de chaves P-256 a partir da chave privada (d) e da pública sem compressão (0x04 || x || y).
async function keyPair(privateB64, publicB64) {
    const pub = fromB64url(publicB64);
    const jwk = { kty: "EC", crv: "P-256", x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), d: privateB64, ext: true };
    const privateKey = await subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const publicKey = await subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
    return { privateKey, publicKey };
}

// Exemplo da RFC 8291 (seção 5): mesma mensagem, mesmas chaves e mesmo salt → mesmo resultado.
test("criptografia aes128gcm igual ao exemplo da RFC 8291", async () => {
    const localKeys = await keyPair("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const body = await encryptPayload("When I grow up, I want to be a watermelon",
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        "BTBZMqHH6r4Tts7J_aSIgg",
        { salt: fromB64url("DGv6ra1nlYgDCS1FRnbzlw"), localKeys });
    assert.equal(b64url(body),
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

// Decifra como o celular faz, só com o crypto do Node (outro caminho, para conferir).
function decryptLikePhone(body, uaEcdh, authSecret) {
    const salt = body.subarray(0, 16);
    const idLength = body[20];
    const asPublic = body.subarray(21, 21 + idLength);
    const ciphertext = body.subarray(21 + idLength);
    const ecdhSecret = uaEcdh.computeSecret(asPublic);
    const uaPublic = uaEcdh.getPublicKey();
    const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
    const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
    assert.equal(plain[plain.length - 1], 2, "falta o delimitador do último registro");
    return plain.subarray(0, plain.length - 1).toString("utf8");
}

test("o celular decifra a mensagem (acentos e emoji inclusos)", async () => {
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const message = JSON.stringify({ title: "Venda nova · R$ 1.389,90", body: "MONTÊ-1042 · Bolsa Positano ✨" });
    const body = Buffer.from(await encryptPayload(message, b64url(ua.getPublicKey()), b64url(auth)));
    assert.equal(body.readUInt32BE(16), 4096);
    assert.equal(decryptLikePhone(body, ua, auth), message);
    // Cada envio usa salt e chave nova: o mesmo texto nunca sai igual.
    const again = Buffer.from(await encryptPayload(message, b64url(ua.getPublicKey()), b64url(auth)));
    assert.notDeepEqual(again, body);
});

test("VAPID: token assinado para o servidor de notificações, com a chave pública da loja", async () => {
    const keys = await generateVapidKeys();
    assert.equal(fromB64url(keys.publicKey).length, 65);
    assert.deepEqual(Object.keys(keys.privateJwk).sort(), ["crv", "d", "kty", "x", "y"]);
    const now = 1_800_000_000;
    const header = await vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMH/abc", keys, "https://oficialmontee.com.br", now);
    const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, keys.publicKey);
    const [h, c, s] = token.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(c, "base64url"));
    assert.equal(claims.aud, "https://web.push.apple.com");
    assert.equal(claims.sub, "https://oficialmontee.com.br");
    assert.ok(claims.exp > now && claims.exp <= now + 24 * 3600, "exp até 24 horas");
    const publicKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: keys.privateJwk.x, y: keys.privateJwk.y }, format: "jwk" });
    const valid = crypto.verify("sha256", Buffer.from(h + "." + c), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    assert.ok(valid, "assinatura ES256 inválida");
});

test("só servidores de notificação conhecidos, sempre em https", () => {
    for (const url of [
        "https://web.push.apple.com/QGuQyavXutnMH-HCcDqT9Vyd",
        "https://fcm.googleapis.com/fcm/send/abc:def",
        "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
        "https://wns2-by3p.notify.windows.com/w/?token=abc"
    ]) assert.ok(isAllowedPushEndpoint(url), url);
    for (const url of [
        "http://web.push.apple.com/abc",
        "https://web.push.apple.com.evil.com/abc",
        "https://evilpush.apple.com.br/abc",
        "https://user:senha@web.push.apple.com/abc",
        "https://web.push.apple.com:8443/abc",
        "https://localhost/abc",
        "https://127.0.0.1/abc",
        "https://oficialmontee.com.br/api/admin/orders",
        "javascript:alert(1)",
        "",
        "https://fcm.googleapis.com/" + "a".repeat(2000)
    ]) assert.ok(!isAllowedPushEndpoint(url), url);
});

test("assinatura do aparelho: confere as chaves antes de guardar", () => {
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const good = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: b64url(ua.getPublicKey()), auth: b64url(crypto.randomBytes(16)) } };
    assert.deepEqual(cleanSubscription(good), { endpoint: good.endpoint, p256dh: good.keys.p256dh, auth: good.keys.auth });
    assert.equal(cleanSubscription({ ...good, endpoint: "https://evil.example/abc" }), null);
    assert.equal(cleanSubscription({ ...good, keys: { ...good.keys, auth: b64url(crypto.randomBytes(8)) } }), null);
    assert.equal(cleanSubscription({ ...good, keys: { ...good.keys, p256dh: b64url(Buffer.concat([Buffer.from([5]), crypto.randomBytes(64)])) } }), null);
    assert.equal(cleanSubscription({ ...good, keys: { ...good.keys, p256dh: b64url(ua.getPublicKey().subarray(0, 33)) } }), null);
    assert.equal(cleanSubscription(null), null);
    assert.deepEqual(cleanTopics(["sales", "security", "sales", "outro", 3]), ["sales", "security"]);
    assert.deepEqual(cleanTopics("sales"), PUSH_TOPICS);
});

function fakeFetch(status, text = "") {
    const calls = [];
    const fn = async (url, options) => { calls.push({ url, options }); return { ok: status >= 200 && status < 300, status, text: async () => text }; };
    fn.calls = calls;
    return fn;
}

test("envio: cabeçalhos do Web Push e aparelho que saiu (410) é marcado para apagar", async () => {
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const subscription = { endpoint: "https://web.push.apple.com/abc", p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) };
    const vapidKeys = await generateVapidKeys();

    const ok = fakeFetch(201);
    const result = await sendWebPush(subscription, { title: "Teste" }, { vapidKeys, subject: "https://oficialmontee.com.br", fetchImpl: ok });
    assert.deepEqual(result, { ok: true, status: 201, gone: false, error: "" });
    const { url, options } = ok.calls[0];
    assert.equal(url, subscription.endpoint);
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Content-Encoding"], "aes128gcm");
    assert.equal(options.headers["Content-Type"], "application/octet-stream");
    assert.equal(options.headers.TTL, String(24 * 3600));
    assert.equal(options.headers.Urgency, "high");
    assert.match(options.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(decryptLikePhone(Buffer.from(options.body), ua, auth), JSON.stringify({ title: "Teste" }));

    const gone = await sendWebPush(subscription, { title: "x" }, { vapidKeys, subject: "https://oficialmontee.com.br", fetchImpl: fakeFetch(410, "Unregistered") });
    assert.deepEqual(gone, { ok: false, status: 410, gone: true, error: "Unregistered" });
    const bad = await sendWebPush(subscription, { title: "x" }, { vapidKeys, subject: "https://oficialmontee.com.br", fetchImpl: fakeFetch(403, '{"reason":"BadJwtToken"}') });
    assert.deepEqual(bad, { ok: false, status: 403, gone: false, error: '{"reason":"BadJwtToken"}' });

    const never = fakeFetch(201);
    const blocked = await sendWebPush({ ...subscription, endpoint: "https://evil.example/abc" }, { title: "x" }, { vapidKeys, subject: "https://oficialmontee.com.br", fetchImpl: never });
    assert.equal(blocked.gone, true);
    assert.equal(never.calls.length, 0, "não pode chamar endereço fora da lista");
});

test("mensagem de venda nova: valor, pedido, cliente, peças; abre o pedido no painel", () => {
    const order = {
        id: 1042, total: 1389.9, customer_name: "Maria Clara Souza",
        items: [{ name: "Bolsa Positano", color: "Caramelo", quantity: 1 }, { name: "Charm Urso", quantity: 2 }]
    };
    const sale = salePushMessage(order, { code: "MONTÊ-1042", toShip: 3 });
    assert.equal(sale.title, "Venda nova · R$ 1.389,90");
    assert.equal(sale.body, "MONTÊ-1042 · Maria Clara Souza\nBolsa Positano (Caramelo), 2x Charm Urso");
    assert.equal(sale.url, "/admin#pedido=1042");
    assert.equal(sale.tag, "pedido-1042");
    assert.equal(sale.badge, 3);

    const presale = salePushMessage({ ...order, approval_status: "pending" }, { code: "MONTÊ-1042" });
    assert.equal(presale.title, "Pré-venda: aceite ou recuse · R$ 1.389,90");
    assert.ok(!("badge" in presale));
    const pixCard = salePushMessage({ ...order, pix_paid_by_card: true }, { code: "MONTÊ-1042" });
    assert.match(pixCard.body, /^Atenção: desconto do Pix pago no cartão\./);
    const gift = salePushMessage({ ...order, items: [{ name: "Bolsa", quantity: 1 }, { name: "Nécessaire", quantity: 1, gift: true, price: 0 }] }, { code: "MONTÊ-1" });
    assert.match(gift.body, /Nécessaire \(presente\)/);

    const long = salePushMessage({ ...order, items: Array.from({ length: 40 }, (_, i) => ({ name: "Bolsa número " + i, quantity: 1 })) }, { code: "MONTÊ-1042" });
    assert.ok(long.body.length <= 180, "corpo longo demais: " + long.body.length);
    assert.ok(Buffer.byteLength(JSON.stringify(long)) < 3000, "a mensagem cifrada precisa caber em 4 KB");
});

test("mensagem de pagamento pendente abre o WhatsApp da cliente; a de segurança abre o painel", () => {
    const pending = pendingPushMessage({ id: 77, name: "Ana", code: "MONTÊ-0077", total: 459, whatsappUrl: "https://wa.me/5585999999999?text=Oi" });
    assert.equal(pending.title, "Pagamento pendente há 30 min");
    assert.equal(pending.body, "Ana não concluiu o pedido MONTÊ-0077 (R$ 459,00). Toque para chamar no WhatsApp.");
    assert.equal(pending.url, "https://wa.me/5585999999999?text=Oi");
    assert.equal(pending.fallbackUrl, "/admin#pedido=77");
    assert.equal(pending.tag, "pendente-77");
    const security = securityPushMessage("Muitas tentativas de login no painel", "O login foi bloqueado por 15 minutos.");
    assert.deepEqual(security, { title: "Segurança: Muitas tentativas de login no painel", body: "O login foi bloqueado por 15 minutos.", url: "/admin", tag: "seguranca" });
});
