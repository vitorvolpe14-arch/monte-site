// SMS do painel (aba SMS): quantos SMS uma mensagem gasta e quais números de celular há numa
// lista colada. Roda no navegador (painel) e no Node (servidor e testes).
//
// Um SMS tem 160 caracteres no alfabeto do celular (GSM 7 bits). Com qualquer letra fora dele
// (ê, ã, õ, ç minúsculo, emoji, aspas curvas...), a mensagem inteira passa a 70 caracteres
// por SMS. Mensagem maior vira várias partes: 153 caracteres cada (67 sem o alfabeto do
// celular), e cada parte é cobrada como um SMS.
(function (root) {
    "use strict";

    const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
        "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
    // Estes valem dois caracteres (o celular usa um sinal de escape antes).
    const GSM_EXTENDED = "^{}\\[~]|€\f";
    const BASIC = new Set(Array.from(GSM_BASIC));
    const EXTENDED = new Set(Array.from(GSM_EXTENDED));
    const MAX_SEGMENTS = 4;

    // Quantos SMS a mensagem gasta. length: caracteres como a operadora conta.
    function smsSegments(text) {
        const value = String(text == null ? "" : text);
        let septets = 0, gsm = true;
        for (const char of value) {
            if (BASIC.has(char)) septets += 1;
            else if (EXTENDED.has(char)) septets += 2;
            else { gsm = false; break; }
        }
        if (gsm) {
            const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
            const limit = segments <= 1 ? 160 : segments * 153;
            return { encoding: "gsm", length: septets, segments, perSegment: segments <= 1 ? 160 : 153, remaining: limit - septets };
        }
        // Fora do alfabeto do celular a conta é por unidade UTF-16 (um emoji ocupa duas).
        const units = value.length;
        const segments = units <= 70 ? 1 : Math.ceil(units / 67);
        const limit = segments <= 1 ? 70 : segments * 67;
        return { encoding: "unicode", length: units, segments, perSegment: segments <= 1 ? 70 : 67, remaining: limit - units };
    }

    // Letras fora do alfabeto do celular, sem repetir (para mostrar o que encarece a mensagem).
    function nonGsmCharacters(text) {
        const found = [];
        for (const char of String(text == null ? "" : text)) {
            if (!BASIC.has(char) && !EXTENDED.has(char) && !found.includes(char)) found.push(char);
        }
        return found;
    }

    // Troca o que encarece o SMS por equivalentes do alfabeto do celular: acentos saem
    // (ê → e, ç → c), aspas curvas viram retas, travessão vira hífen, reticências viram "...".
    // O que continuar fora (emoji, por exemplo) é retirado.
    function toGsmText(text) {
        const replaced = String(text == null ? "" : text)
            .replace(/[‘’‚′]/g, "'")
            .replace(/[“”„″]/g, "\"")
            .replace(/[–—−]/g, "-")
            .replace(/…/g, "...")
            .replace(/[   ]/g, " ");
        let out = "";
        for (const char of replaced) {
            if (BASIC.has(char) || EXTENDED.has(char)) { out += char; continue; }
            const plain = char.normalize("NFD").replace(/[̀-ͯ]/g, "");
            if (plain && Array.from(plain).every(c => BASIC.has(c) || EXTENDED.has(c))) out += plain;
        }
        return out;
    }

    // Celular brasileiro no formato que a Mobizon pede: 55 + DDD + 9 dígitos ("5585991234567").
    // Aceita com ou sem +55, com ou sem o 0 da operadora/DDD, com espaços, traços e parênteses.
    // Devolve "" quando não é celular (fixo, número incompleto, DDD inválido).
    function brazilMobile(value) {
        let digits = String(value == null ? "" : value).replace(/\D/g, "");
        if (digits.length === 13 && digits.startsWith("55")) digits = digits.slice(2);
        else if (digits.length === 12 && digits.startsWith("0")) digits = digits.slice(1);
        if (!/^[1-9]{2}9\d{8}$/.test(digits)) return "";
        return "55" + digits;
    }

    // Números de celular de uma lista colada ou de um arquivo (CSV do Google Contatos, vCard,
    // uma lista por linha...). Sem repetir; inválidos contam à parte.
    // Separadores que nunca ficam dentro de um número: linha, vírgula, ponto e vírgula, dois-pontos
    // (o Google junta vários telefones com " ::: "), barra vertical, tabulação e barra.
    function extractPhones(text) {
        const phones = [];
        let invalid = 0;
        const check = candidate => {
            const digits = candidate.replace(/\D/g, "");
            // Mais de 13 dígitos: dois números separados só por espaço.
            if (digits.length > 13) return candidate.split(/\s+/).forEach(check);
            if (digits.length < 9) return; // CEP, número da casa, data...
            const phone = brazilMobile(digits);
            if (!phone) { invalid += 1; return; }
            if (!phones.includes(phone)) phones.push(phone);
        };
        for (const chunk of String(text == null ? "" : text).split(/[\r\n,;:|\t\/]+/)) {
            (chunk.match(/\+?\d[\d ().-]*\d/g) || []).forEach(check);
        }
        return { phones, invalid };
    }

    // "5585991234567" → "(85) 99123-4567".
    function formatPhone(phone) {
        const d = String(phone || "").replace(/^55/, "");
        return d.length === 11 ? "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7) : String(phone || "");
    }

    const api = { MAX_SEGMENTS, smsSegments, nonGsmCharacters, toGsmText, brazilMobile, extractPhones, formatPhone };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.SmsText = api;
})(typeof self !== "undefined" ? self : this);
