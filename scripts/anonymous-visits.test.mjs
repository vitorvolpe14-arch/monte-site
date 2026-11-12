// Testes da contagem anônima de visitas (backend/anonymous-visits.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require("../backend/anonymous-visits.js");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const INSTAGRAM_APP = IPHONE + " Instagram 330.0.0.0 (iPhone15,2; iOS 17_5; pt_BR)";
const OWN = "oficialmontee.com.br";

test("origem pelo utm_source do link, com os apelidos comuns", () => {
    assert.equal(A.sourceOf({ utm: "IG", ownHost: OWN }), "instagram");
    assert.equal(A.sourceOf({ utm: "instagram_bio", ownHost: OWN }), "instagram");
    assert.equal(A.sourceOf({ utm: "sms", ref: "google.com" }), "sms", "o utm vale mais que o link de origem");
    assert.equal(A.sourceOf({ utm: "black-friday" }), "campanha", "utm desconhecido vira campanha, sem guardar o texto");
});

test("origem pelo domínio de onde a visita veio", () => {
    assert.equal(A.sourceOf({ ref: "l.instagram.com", ownHost: OWN }), "instagram");
    assert.equal(A.sourceOf({ ref: "www.google.com.br", ownHost: OWN }), "google");
    assert.equal(A.sourceOf({ ref: "lm.facebook.com" }), "facebook");
    assert.equal(A.sourceOf({ ref: "wa.me" }), "whatsapp");
    assert.equal(A.sourceOf({ ref: "duckduckgo.com" }), "buscador");
    assert.equal(A.sourceOf({ ref: "blog-da-amiga.com.br" }), "outros", "outro site vira só 'outros', sem guardar o domínio");
});

test("link da própria loja ou sem origem: navegador do app ou direto", () => {
    assert.equal(A.sourceOf({ ref: "www.oficialmontee.com.br", ownHost: OWN, ua: IPHONE }), "direto");
    assert.equal(A.sourceOf({ ref: "", ua: INSTAGRAM_APP }), "instagram");
    assert.equal(A.sourceOf({ ref: "", ua: IPHONE + " [FBAN/FBIOS;FBAV/470.0]" }), "facebook");
    assert.equal(A.sourceOf({ ref: "javascript:alert(1)", ua: MAC }), "direto", "origem inválida é ignorada");
});

test("celular ou computador; robôs e o guardião não contam", () => {
    assert.equal(A.deviceOf(IPHONE), "mobile");
    assert.equal(A.deviceOf(MAC), "desktop");
    for (const ua of ["", "monte-guardian/1.0", "Googlebot/2.1", "Mozilla/5.0 HeadlessChrome/120", "facebookexternalhit/1.1", "WhatsApp/2.23.20 i", "curl/8.4"]) assert.equal(A.isBot(ua), true, ua);
    assert.equal(A.isBot(IPHONE), false);
});

test("'Não rastrear' e Global Privacy Control: a visita não é contada", () => {
    assert.equal(A.optedOut({ "sec-gpc": "1" }), true);
    assert.equal(A.optedOut({ dnt: "1" }), true);
    assert.equal(A.optedOut({}), false);
    assert.equal(A.anonymousHits({ event: "visit", ua: IPHONE, headers: { "sec-gpc": "1" } }), null);
});

test("o dia é o de Fortaleza (UTC-3)", () => {
    assert.equal(A.storeDay(new Date("2026-11-13T02:30:00Z")), "2026-11-12");
    assert.equal(A.storeDay(new Date("2026-11-13T03:00:00Z")), "2026-11-13");
});

test("entrada no site soma visita e página vista; o resto só o próprio aviso, sem origem", () => {
    const now = new Date("2026-11-12T15:00:00Z");
    assert.deepEqual(A.anonymousHits({ event: "visit", ref: "l.instagram.com", ua: IPHONE, headers: {}, ownHost: OWN }, now), [
        { day: "2026-11-12", event: "visit", source: "instagram", device: "mobile" },
        { day: "2026-11-12", event: "page_view", source: "-", device: "mobile" }
    ]);
    assert.deepEqual(A.anonymousHits({ event: "cart", ref: "l.instagram.com", ua: MAC, headers: {} }, now), [{ day: "2026-11-12", event: "cart", source: "-", device: "desktop" }]);
    assert.equal(A.anonymousHits({ event: "purchase", ua: MAC, headers: {} }, now), null, "aviso desconhecido não conta");
});

test("nada do que é guardado identifica a visitante", () => {
    const hits = A.anonymousHits({ event: "visit", ref: "blog-da-amiga.com.br", utm: "", ua: IPHONE, headers: { "x-forwarded-for": "200.1.2.3" }, ownHost: OWN });
    for (const hit of hits) {
        assert.deepEqual(Object.keys(hit).sort(), ["day", "device", "event", "source"]);
        assert.ok(A.SOURCE_CODES.includes(hit.source) || hit.source === "-");
        assert.doesNotMatch(JSON.stringify(hit), /200\.1\.2\.3|iPhone|blog-da-amiga/);
    }
});
