// Testes da contagem de SMS e da leitura de listas de celulares (sms-text.js).
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../sms-text.js");

test("mensagem sem acento: 160 caracteres num SMS", () => {
    const text = "MONTE: Oi! Chegaram pecas novas na loja. Confira: oficialmontee.com.br - Para nao receber mais, fale no WhatsApp (85) 99216-3305";
    const info = S.smsSegments(text);
    assert.equal(info.encoding, "gsm");
    assert.equal(info.length, text.length);
    assert.equal(info.segments, 1);
    assert.equal(S.smsSegments("a".repeat(160)).segments, 1);
    assert.equal(S.smsSegments("a".repeat(161)).segments, 2);
    assert.equal(S.smsSegments("a".repeat(306)).segments, 2);
    assert.equal(S.smsSegments("a".repeat(307)).segments, 3);
});

test("o Ê de MONTÊ passa a mensagem para 70 caracteres por SMS", () => {
    const info = S.smsSegments("MONTÊ: " + "a".repeat(70));
    assert.equal(info.encoding, "unicode");
    assert.equal(info.segments, 2);
    assert.equal(S.smsSegments("MONTÊ " + "a".repeat(64)).segments, 1);
    assert.deepEqual(S.nonGsmCharacters("MONTÊ: peças à vista"), ["Ê", "ç"]);
});

test("é, à e Ç são do alfabeto do celular; € e colchetes valem 2", () => {
    assert.equal(S.smsSegments("Café à vista, AÇÃO").encoding, "unicode"); // Ã não é
    assert.equal(S.smsSegments("Café à vista, AÇO").encoding, "gsm");
    assert.equal(S.smsSegments("€").length, 2);
    assert.equal(S.smsSegments("[oi]").length, 6);
});

test("emoji ocupa duas posições e encarece a mensagem", () => {
    const info = S.smsSegments("Oi 😍");
    assert.equal(info.encoding, "unicode");
    assert.equal(info.length, 5);
});

test("tirar acentos deixa a mensagem no alfabeto do celular", () => {
    const out = S.toGsmText("MONTÊ — “promoção” de peças… até amanhã 😍");
    assert.equal(out, "MONTE - \"promocao\" de pecas... até amanha "); // é é do alfabeto do celular
    assert.equal(S.smsSegments(out).encoding, "gsm");
    // O que já é do alfabeto continua igual.
    assert.equal(S.toGsmText("Café à vista"), "Café à vista");
});

test("vazio não gasta SMS", () => {
    assert.equal(S.smsSegments("").segments, 0);
});

test("celular com e sem +55, com 0 na frente e formatado", () => {
    assert.equal(S.brazilMobile("+55 (85) 99123-4567"), "5585991234567");
    assert.equal(S.brazilMobile("85991234567"), "5585991234567");
    assert.equal(S.brazilMobile("085991234567"), "5585991234567");
    assert.equal(S.brazilMobile("5585991234567"), "5585991234567");
    assert.equal(S.brazilMobile("(85) 3333-4444"), "");   // fixo
    assert.equal(S.brazilMobile("99123-4567"), "");        // sem DDD
    assert.equal(S.brazilMobile("(01) 99123-4567"), "");   // DDD inválido
    assert.equal(S.formatPhone("5585991234567"), "(85) 99123-4567");
});

test("lista colada: um por linha, separados por vírgula, sem repetir", () => {
    const { phones, invalid } = S.extractPhones("85 99123-4567\n(85) 99123-4567, +55 11 98765-4321;\n85 3333-4444\n99123-4567");
    assert.deepEqual(phones, ["5585991234567", "5511987654321"]);
    assert.equal(invalid, 2);
});

test("CSV do Google Contatos: vários telefones com ':::' e o CEP não conta", () => {
    const csv = [
        "First Name,Last Name,Phone 1 - Label,Phone 1 - Value,Address 1 - Postal Code",
        "Ana,Souza,Mobile,+55 85 99123-4567 ::: +55 85 3333-4444,60000-000",
        "Bia,,Mobile,(85) 98888-7777,"
    ].join("\n");
    const { phones, invalid } = S.extractPhones(csv);
    assert.deepEqual(phones, ["5585991234567", "5585988887777"]);
    assert.equal(invalid, 1); // o fixo
});

test("vCard", () => {
    const vcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Ana\nTEL;TYPE=CELL:+55 85 99123-4567\nEND:VCARD";
    assert.deepEqual(S.extractPhones(vcf).phones, ["5585991234567"]);
});

test("dois números separados só por espaço", () => {
    assert.deepEqual(S.extractPhones("85991234567 11987654321").phones, ["5585991234567", "5511987654321"]);
});

test("vCard do iPhone com foto: a foto (base64) não vira número", () => {
    const photo = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/" +
        "\n 85991234567123456789aB3c4D5e6F7g8H9i0J\n 11987654321998877665544Zz";
    const vcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Ana\nitem1.TEL;type=CELL;type=VOICE;type=pref:+55 85 98111-0001\nPHOTO;ENCODING=b;TYPE=JPEG:" + photo + "\nEND:VCARD";
    assert.deepEqual(S.extractPhones(vcf), { phones: ["5585981110001"], invalid: 0, rejected: [], fixed: [] });
});

test("por que o número ficou de fora", () => {
    const reason = v => S.classifyPhone(v).reason;
    assert.equal(reason("(85) 3261-1234"), "telefone fixo, não recebe SMS");
    assert.equal(reason("+55 85 3261-1234"), "telefone fixo, não recebe SMS");
    assert.equal(reason("99123-4567"), "sem DDD");
    assert.equal(reason("+1 415 555 0100"), "número de fora do Brasil");
    assert.equal(reason("+351 912 345 678"), "número de fora do Brasil");
    assert.equal(reason("(85) 88123-4567"), "não é celular");
    assert.match(reason("085 8899-1234"), /formato antigo/);
    assert.equal(S.classifyPhone("(85) 99123-4567").reason, undefined);
});

test("celular antigo sem o 9 ganha o 9 (fixo continua de fora)", () => {
    assert.deepEqual(S.classifyPhone("(85) 8899-1234"), { phone: "5585988991234", fixed: true });
    assert.deepEqual(S.classifyPhone("+55 85 7766-5544"), { phone: "5585977665544", fixed: true });
    const r = S.extractPhones("(85) 8899-1234\n(85) 3261-1234\n(85) 98899-1234\n99123-4567");
    assert.deepEqual(r.phones, ["5585988991234"]);
    assert.deepEqual(r.fixed, [{ from: "(85) 8899-1234", to: "5585988991234" }]);
    assert.deepEqual(r.rejected, [{ number: "(85) 3261-1234", reason: "telefone fixo, não recebe SMS" }, { number: "99123-4567", reason: "sem DDD" }]);
    assert.equal(r.invalid, 2);
});

test("o mesmo número recusado conta uma vez", () => {
    const r = S.extractPhones("(85) 3261-1234\n85 3261 1234");
    assert.equal(r.invalid, 1);
    assert.equal(r.rejected.length, 1);
});
