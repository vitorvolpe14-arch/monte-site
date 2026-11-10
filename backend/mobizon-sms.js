// SMS pela Mobizon (aba SMS do painel): saldo, envio e situação de entrega.
//
// A API (https://api.mobizon.com.br/service/<módulo>/<método>) responde sempre
// { code, data, message }; code 0 é sucesso. A chave vai no corpo (apiKey), nunca no
// endereço, para não aparecer nos registros. As mensagens de erro da Mobizon vêm em russo:
// o painel mostra a explicação em português pelo código.

const MOBIZON_API = "https://api.mobizon.com.br";

const ERROR_MESSAGES = {
    1: "A Mobizon recusou os dados enviados.",
    2: "Registro não encontrado na Mobizon.",
    8: "A chave da API da Mobizon não foi aceita. Confira a chave em Configurações da API, na Mobizon.",
    9: "A chave da API da Mobizon não tem permissão para isso.",
    12: "A Mobizon recusou um dos dados enviados.",
    13: "Esta conta da Mobizon responde em outro endereço de API.",
    14: "A conta da Mobizon está bloqueada. Fale com o suporte da Mobizon.",
    15: "A Mobizon não concluiu a operação.",
    30: "Muitos envios seguidos. Aguarde um minuto e continue.",
    999: "A Mobizon não concluiu a operação."
};

// Erros da conta (chave, bloqueio, saldo, limite): o envio para e os números voltam para a fila.
// Erro só do número (code 1 com o campo "recipient"): aquele SMS falhou e o envio segue.
class MobizonError extends Error {
    constructor(code, message, data) {
        super(ERROR_MESSAGES[code] || message || "A Mobizon não respondeu como esperado.");
        this.code = code;
        this.detail = message || "";
        this.data = data;
        this.recipientError = code === 1 && data && typeof data === "object" && !Array.isArray(data) && "recipient" in data;
    }
}

// Situação da Mobizon → situação no painel. Finais: DELIVRD (entregue) e as de falha.
const PROVIDER_STATUS = {
    NEW: "sent", ENQUEUD: "sent", ACCEPTD: "sent", PDLIVRD: "sent",
    DELIVRD: "delivered",
    UNDELIV: "failed", REJECTD: "failed", EXPIRED: "failed", DELETED: "failed"
};
const FAILURE_LABELS = {
    UNDELIV: "Não entregue (celular desligado ou fora de área por muito tempo)",
    REJECTD: "Recusado pela operadora (número inválido ou texto bloqueado)",
    EXPIRED: "Não entregue em 3 dias",
    DELETED: "Removido pela Mobizon antes do envio"
};
function messageStatus(providerStatus) {
    return PROVIDER_STATUS[String(providerStatus || "").toUpperCase()] || "sent";
}
function failureLabel(providerStatus) {
    return FAILURE_LABELS[String(providerStatus || "").toUpperCase()] || null;
}

function createMobizonClient({ apiKey, fetchImpl = fetch, baseUrl = MOBIZON_API, timeoutMs = 15000 } = {}) {
    async function call(module, method, params = {}) {
        if (!apiKey) throw new MobizonError(8, "missing api key");
        const body = new URLSearchParams();
        body.set("apiKey", apiKey);
        const add = (key, value) => {
            if (value === undefined || value === null) return;
            if (Array.isArray(value)) value.forEach((item, i) => add(key + "[" + i + "]", item));
            else if (typeof value === "object") Object.entries(value).forEach(([k, v]) => add(key + "[" + k + "]", v));
            else body.set(key, String(value));
        };
        Object.entries(params).forEach(([key, value]) => add(key, value));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response, text;
        try {
            response = await fetchImpl(baseUrl + "/service/" + module + "/" + method + "?output=json&api=v1", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
                body: body.toString(),
                signal: controller.signal
            });
            text = await response.text();
        } catch (error) {
            throw new MobizonError(0, error?.name === "AbortError" ? "A Mobizon demorou para responder." : "Não foi possível falar com a Mobizon.");
        } finally {
            clearTimeout(timer);
        }
        let data;
        try { data = JSON.parse(text); } catch { throw new MobizonError(0, "A Mobizon respondeu fora do formato (HTTP " + response.status + ")."); }
        const code = Number(data?.code);
        if (code !== 0) throw new MobizonError(Number.isFinite(code) ? code : 0, safeText(data?.message), data?.data);
        return data.data;
    }

    return {
        // { amount: 12.5, currency: "BRL" }
        async balance() {
            const data = await call("user", "getownbalance");
            return { amount: Number(data?.balance) || 0, currency: String(data?.currency || "BRL") };
        },
        // { providerId, providerStatus } do SMS aceito pela Mobizon.
        async send({ recipient, text }) {
            const data = await call("message", "sendsmsmessage", { recipient, text });
            return { providerId: data?.messageId != null ? String(data.messageId) : null, providerStatus: data?.status != null ? String(data.status) : null };
        },
        // [{ providerId, providerStatus, status, error }] de até 100 SMS.
        async status(ids) {
            const list = (Array.isArray(ids) ? ids : []).filter(Boolean).slice(0, 100).map(String);
            if (!list.length) return [];
            const data = await call("message", "getsmsstatus", { ids: list });
            return (Array.isArray(data) ? data : []).map(item => {
                const providerStatus = String(item?.status || "").toUpperCase();
                return { providerId: String(item?.id ?? ""), providerStatus, status: messageStatus(providerStatus), error: failureLabel(providerStatus) };
            }).filter(item => item.providerId);
        }
    };
}

function safeText(value) {
    return typeof value === "string" ? value.slice(0, 300) : "";
}

module.exports = { MOBIZON_API, MobizonError, createMobizonClient, messageStatus, failureLabel };
