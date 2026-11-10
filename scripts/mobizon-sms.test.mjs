// Testes do cliente da Mobizon (backend/mobizon-sms.js), sem chamar a Mobizon de verdade.
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MobizonError, createMobizonClient, messageStatus, webhookSignature, validWebhookSignature } = require("../backend/mobizon-sms.js");
const crypto = require("crypto");

function fakeFetch(reply) {
    const calls = [];
    const fn = async (url, options) => {
        calls.push({ url, options, body: new URLSearchParams(options.body) });
        const value = typeof reply === "function" ? reply(calls.at(-1)) : reply;
        return { status: 200, text: async () => (typeof value === "string" ? value : JSON.stringify(value)) };
    };
    fn.calls = calls;
    return fn;
}

test("a chave vai no corpo, nunca no endereço", async () => {
    const fetchImpl = fakeFetch({ code: 0, data: { balance: "12.5000", currency: "BRL" }, message: "" });
    const client = createMobizonClient({ apiKey: "segredo", fetchImpl });
    assert.deepEqual(await client.balance(), { amount: 12.5, currency: "BRL" });
    const call = fetchImpl.calls[0];
    assert.equal(call.url, "https://api.mobizon.com.br/service/user/getownbalance?output=json&api=v1");
    assert.equal(call.options.method, "POST");
    assert.equal(call.body.get("apiKey"), "segredo");
    assert.ok(!call.url.includes("segredo"));
});

test("envio: número e texto no corpo; devolve o id da mensagem", async () => {
    const fetchImpl = fakeFetch({ code: 0, data: { campaignId: "1759377", status: 1, messageId: "12111324" }, message: "" });
    const client = createMobizonClient({ apiKey: "k", fetchImpl });
    const sent = await client.send({ recipient: "5585991234567", text: "MONTE: oi" });
    assert.deepEqual(sent, { providerId: "12111324", providerStatus: "1", providerCampaignId: "1759377" });
    assert.equal(fetchImpl.calls[0].body.get("recipient"), "5585991234567");
    assert.equal(fetchImpl.calls[0].body.get("text"), "MONTE: oi");
});

test("situação de entrega: ids como lista e situações em português", async () => {
    const fetchImpl = fakeFetch({ code: 0, data: [{ id: "1", status: "DELIVRD", segNum: "1" }, { id: "2", status: "REJECTD", segNum: "1" }, { id: "3", status: "ACCEPTD" }], message: "" });
    const client = createMobizonClient({ apiKey: "k", fetchImpl });
    const list = await client.status(["1", "2", "3"]);
    assert.deepEqual(fetchImpl.calls[0].body.getAll("ids[0]"), ["1"]);
    assert.deepEqual(fetchImpl.calls[0].body.getAll("ids[2]"), ["3"]);
    assert.deepEqual(list.map(x => x.status), ["delivered", "failed", "sent"]);
    assert.match(list[1].error, /Recusado pela operadora/);
    assert.equal(list[0].error, null);
});

test("chave errada: erro em português e não é erro do número", async () => {
    const client = createMobizonClient({ apiKey: "k", fetchImpl: fakeFetch({ code: 8, data: [], message: "Ошибка авторизации API" }) });
    await assert.rejects(client.balance(), error => {
        assert.ok(error instanceof MobizonError);
        assert.equal(error.code, 8);
        assert.equal(error.recipientError, false);
        assert.match(error.message, /chave da API/);
        return true;
    });
});

test("número recusado: code 1 com o campo recipient", async () => {
    const client = createMobizonClient({ apiKey: "k", fetchImpl: fakeFetch({ code: 1, data: { recipient: "Неверный номер" }, message: "" }) });
    await assert.rejects(client.send({ recipient: "5585991234567", text: "x" }), error => error.recipientError === true);
});

test("sem chave não chama a Mobizon", async () => {
    const fetchImpl = fakeFetch({ code: 0, data: {} });
    await assert.rejects(createMobizonClient({ apiKey: "", fetchImpl }).balance(), error => error.code === 8);
    assert.equal(fetchImpl.calls.length, 0);
});

test("resposta fora do formato e falha de rede viram code 0", async () => {
    await assert.rejects(createMobizonClient({ apiKey: "k", fetchImpl: fakeFetch("<html>erro</html>") }).balance(), error => error.code === 0);
    const broken = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(createMobizonClient({ apiKey: "k", fetchImpl: broken }).balance(), error => error.code === 0);
});

test("situações desconhecidas contam como enviadas (ainda sem confirmação)", () => {
    assert.equal(messageStatus("NEW"), "sent");
    assert.equal(messageStatus("PDLIVRD"), "sent");
    assert.equal(messageStatus(""), "sent");
    assert.equal(messageStatus("expired"), "failed");
});

test("contar cliques: a Mobizon encurta o link e devolve a campanha do SMS", async () => {
    const fetchImpl = fakeFetch({ code: 0, data: { campaignId: 555, status: 2, messageId: 777 }, message: "" });
    const client = createMobizonClient({ apiKey: "k", fetchImpl });
    const sent = await client.send({ recipient: "5585991234567", text: "MONTE: https://oficialmontee.com.br", shortenLinks: true });
    assert.deepEqual(sent, { providerId: "777", providerStatus: "2", providerCampaignId: "555" });
    assert.equal(fetchImpl.calls[0].body.get("params[shortenLinks]"), "1");
    // Sem contar cliques, o link vai como está.
    await client.send({ recipient: "5585991234567", text: "x" });
    assert.equal(fetchImpl.calls[1].body.get("params[shortenLinks]"), null);
});

test("cliques de uma campanha: soma dos links curtos", async () => {
    const fetchImpl = fakeFetch({ code: 0, data: [{ id: 1, shortLink: "https://mbz.li/a", clickCnt: 2, redirectCnt: 2 }, { id: 2, clickCnt: "1" }], message: "" });
    const client = createMobizonClient({ apiKey: "k", fetchImpl });
    assert.equal(await client.campaignClicks("555"), 3);
    assert.match(fetchImpl.calls[0].url, /\/service\/campaign\/getlinks\?/);
    assert.equal(fetchImpl.calls[0].body.get("campaignId"), "555");
});

test("assinatura do webhook: sha1 de eventId|attempt|eventCreateTs|chave", () => {
    const event = { eventId: 26, attempt: 1, eventCreateTs: "2026-01-15 11:42:28", data: { messageId: 169275418, status: "DELIVRD" } };
    const expected = crypto.createHash("sha1").update("26|1|2026-01-15 11:42:28|segredo").digest("hex");
    assert.equal(webhookSignature(event, "segredo"), expected);
    assert.equal(validWebhookSignature({ ...event, sign: expected }, "segredo"), true);
    assert.equal(validWebhookSignature({ ...event, sign: expected.toUpperCase() }, "segredo"), true);
    assert.equal(validWebhookSignature({ ...event, sign: expected }, "outra"), false);
    assert.equal(validWebhookSignature({ ...event, attempt: 2, sign: expected }, "segredo"), false);
    assert.equal(validWebhookSignature({ ...event, sign: "nada" }, "segredo"), false);
    assert.equal(validWebhookSignature({ ...event }, "segredo"), false);
    // Sem chave configurada, nenhum aviso vale.
    assert.equal(validWebhookSignature({ ...event, sign: webhookSignature(event, "") }, ""), false);
});
