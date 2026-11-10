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

    // O que é o número: { phone } (celular no formato que a Mobizon pede: 55 + DDD + 9 dígitos,
    // "5585991234567") ou { reason } (por que fica de fora). Aceita com ou sem +55, com ou sem o 0
    // da operadora/DDD, com espaços, traços e parênteses.
    // Celular salvo no formato antigo, sem o 9 (DDD + 8 dígitos começando com 6 a 9), ganha o 9
    // (fixed: true): todo celular do Brasil passou a ter o 9 na frente; fixo começa com 2 a 5.
    function classifyPhone(value) {
        const raw = String(value == null ? "" : value).trim();
        let digits = raw.replace(/\D/g, "");
        if (raw.startsWith("+") && !digits.startsWith("55")) return { reason: "número de fora do Brasil" };
        let trunk = false; // tinha o 0 da operadora na frente
        if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);
        else if ((digits.length === 11 || digits.length === 12) && digits.startsWith("0")) { digits = digits.slice(1); trunk = true; }
        if (digits.length === 8 || digits.length === 9) return { reason: "sem DDD" };
        if (digits.length !== 10 && digits.length !== 11) return { reason: "formato não reconhecido" };
        if (!/^[1-9]{2}/.test(digits)) return { reason: "DDD inválido" };
        const local = digits.slice(2);
        if (digits.length === 10) {
            if (/^[2-5]/.test(local)) return { reason: "telefone fixo, não recebe SMS" };
            // Com o 0 na frente, "0 + 10 dígitos" também pode ser um DDD digitado errado: não adivinha.
            if (/^[6-9]/.test(local)) return trunk ? { reason: "celular no formato antigo, sem o 9: confira e digite com o 9" } : { phone: "55" + digits.slice(0, 2) + "9" + local, fixed: true };
            return { reason: "formato não reconhecido" };
        }
        if (local[0] !== "9") return { reason: "não é celular" };
        return { phone: "55" + digits };
    }

    // Como o número aparece no painel quando fica de fora ou é corrigido: "(85) 8899-1234".
    function displayNumber(value) {
        const raw = String(value == null ? "" : value).trim();
        let d = raw.replace(/\D/g, "");
        if (raw.startsWith("+") && !d.startsWith("55")) return raw;
        if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
        else if ((d.length === 11 || d.length === 12) && d.startsWith("0")) d = d.slice(1);
        if (d.length === 10) return "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
        if (d.length === 11) return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
        if (d.length === 9) return d.slice(0, 5) + "-" + d.slice(5);
        return raw;
    }

    // Celular brasileiro no formato da Mobizon, ou "" quando não é celular.
    function brazilMobile(value) {
        return classifyPhone(value).phone || "";
    }

    // Números de celular de uma lista colada ou de um arquivo (CSV do Google Contatos, vCard,
    // uma lista por linha...). Sem repetir. invalid: quantos ficaram de fora; rejected: quais e
    // por quê; fixed: celulares antigos que ganharam o 9.
    // Separadores que nunca ficam dentro de um número: linha, vírgula, ponto e vírgula, dois-pontos
    // (o Google junta vários telefones com " ::: "), barra vertical, tabulação e barra.
    function extractPhones(text) {
        const phones = [], rejected = [], fixed = [];
        const seenRejected = new Set();
        let invalid = 0;
        const check = candidate => {
            const digits = candidate.replace(/\D/g, "");
            // Mais de 13 dígitos: dois números separados só por espaço.
            if (digits.length > 13) return candidate.split(/\s+/).forEach(check);
            if (digits.length < 9) return; // CEP, número da casa, data...
            const result = classifyPhone(candidate);
            if (!result.phone) {
                if (seenRejected.has(digits)) return;
                seenRejected.add(digits);
                invalid += 1;
                if (rejected.length < 50) rejected.push({ number: displayNumber(candidate), reason: result.reason });
                return;
            }
            if (phones.includes(result.phone)) return;
            phones.push(result.phone);
            if (result.fixed && fixed.length < 50) fixed.push({ from: displayNumber(candidate), to: result.phone });
        };
        // vCard (iPhone): a foto vem em base64, na linha PHOTO e nas seguintes que começam com espaço.
        const plain = String(text == null ? "" : text).replace(/^PHOTO[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/gim, "");
        for (const chunk of plain.split(/[\r\n,;:|\t\/]+/)) {
            (chunk.match(/\+?\d[\d ().-]*\d/g) || []).forEach(check);
        }
        return { phones, invalid, rejected, fixed };
    }

    // "5585991234567" → "(85) 99123-4567".
    function formatPhone(phone) {
        const d = String(phone || "").replace(/^55/, "");
        return d.length === 11 ? "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7) : String(phone || "");
    }

    const api = { MAX_SEGMENTS, smsSegments, nonGsmCharacters, toGsmText, classifyPhone, brazilMobile, extractPhones, formatPhone };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.SmsText = api;
})(typeof self !== "undefined" ? self : this);
