// Contagem anônima de visitas — vale para todas as visitantes, com ou sem a permissão de cookies.
// Base legal: legítimo interesse (LGPD art. 7º, IX), com o mínimo de dados (veja
// docs/teste-legitimo-interesse-contagem-anonima.md e a Política de Privacidade).
//
// O site manda só o tipo do aviso e, na entrada no site, o domínio de onde a visita veio
// (ou o utm_source do link). Nada fica guardado no aparelho e não há código de identificação.
// O servidor lê o navegador e o IP só na hora (celular ou computador, robôs e o limite de
// pedidos) e não guarda nenhum dos dois: soma 1 no total do dia (backend/sql/visitas-anonimas.sql).
//
// Avisos: visit = entrada no site (conta também como página vista), page_view = outra página
// ou recarregar, cart = a visita pôs uma peça na sacola, checkout = começou o checkout
// (os dois últimos, no máximo uma vez por página aberta).

const HIT_EVENTS = ["visit", "page_view", "cart", "checkout"];
const SOURCE_CODES = ["instagram", "facebook", "google", "whatsapp", "sms", "tiktok", "email", "youtube", "pinterest", "x", "buscador", "outros", "campanha", "direto"];

// utm_source dos links da loja (anúncios, bio, SMS...): sinônimos comuns de cada canal.
const UTM_ALIASES = [
    [/^(ig|insta|instagram)/, "instagram"],
    [/^(fb|facebook|meta|messenger)/, "facebook"],
    [/^(google|gads|adwords|youtube_ads)/, "google"],
    [/^(wa|zap|whats|whatsapp)/, "whatsapp"],
    [/^sms/, "sms"],
    [/^(tt|tiktok)/, "tiktok"],
    [/^(email|e-mail|mail|newsletter|resend)/, "email"],
    [/^(yt|youtube)/, "youtube"],
    [/^(pin|pinterest)/, "pinterest"],
    [/^(x|twitter)$/, "x"]
];
const HOST_RULES = [
    [/(^|\.)instagram\.com$/, "instagram"],
    [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, "facebook"],
    [/(^|\.)google(\.[a-z]{2,3}){1,2}$/, "google"],
    [/(^|\.)(whatsapp\.com|whatsapp\.net|wa\.me)$/, "whatsapp"],
    [/(^|\.)tiktok\.com$/, "tiktok"],
    [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
    [/(^|\.)pinterest(\.[a-z]{2,3}){1,2}$/, "pinterest"],
    [/(^|\.)(t\.co|twitter\.com|x\.com)$/, "x"],
    [/(^|\.)(bing\.com|duckduckgo\.com|yahoo\.com|search\.yahoo\.com|ecosia\.org|search\.brave\.com)$/, "buscador"]
];
// Sem link de origem: os navegadores de dentro dos apps se apresentam pelo nome.
const IN_APP = [
    [/Instagram/, "instagram"],
    [/FBAN|FBAV|FB_IAB|FBIOS/, "facebook"],
    [/musical_ly|BytedanceWebview|TikTok/i, "tiktok"]
];
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|pingdom|uptime|monitor|preview|python|curl|wget|node-fetch|axios|okhttp|go-http|java\/|monte-guardian|facebookexternalhit|whatsapp\//i;

function cleanHost(value) {
    const host = String(value || "").trim().toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9.-]{1,253}$/.test(host) && host.includes(".") ? host : "";
}

function sourceOf({ ref, utm, ua, ownHost }) {
    const tag = String(utm || "").trim().toLowerCase().slice(0, 40);
    if (tag) {
        for (const [pattern, code] of UTM_ALIASES) if (pattern.test(tag)) return code;
        return "campanha";
    }
    const host = cleanHost(ref), own = cleanHost(ownHost);
    if (host && (!own || (host !== own && !host.endsWith("." + own)))) {
        for (const [pattern, code] of HOST_RULES) if (pattern.test(host)) return code;
        return "outros";
    }
    const agent = String(ua || "");
    for (const [pattern, code] of IN_APP) if (pattern.test(agent)) return code;
    return "direto";
}

function deviceOf(ua) {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(String(ua || "")) ? "mobile" : "desktop";
}

function isBot(ua) {
    const agent = String(ua || "");
    return !agent || BOT_UA.test(agent);
}

// "Não rastrear" e Global Privacy Control do navegador: a visita não é contada.
function optedOut(headers = {}) {
    return String(headers["sec-gpc"] || "").trim() === "1" || String(headers.dnt || "").trim() === "1";
}

// O dia da loja (Fortaleza, sem horário de verão), no formato do banco: AAAA-MM-DD.
const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" });
function storeDay(date = new Date()) {
    return DAY_FORMAT.format(date);
}

// O que somar para um aviso do site; null = não conta (aviso inválido, robô ou "não rastrear").
// Só a entrada no site guarda a origem; os outros avisos ficam com a origem "-".
function anonymousHits({ event, ref, utm, ua, headers, ownHost }, now = new Date()) {
    const name = String(event || "");
    if (!HIT_EVENTS.includes(name) || isBot(ua) || optedOut(headers)) return null;
    const day = storeDay(now), device = deviceOf(ua);
    if (name === "visit") {
        const source = sourceOf({ ref, utm, ua, ownHost });
        return [{ day, event: "visit", source, device }, { day, event: "page_view", source: "-", device }];
    }
    return [{ day, event: name, source: "-", device }];
}

// Junta os totais anônimos de cada dia à série do Analytics (base: um item por dia, com date) e soma o
// período desde o dia em que a contagem começou (since). Os pedidos pagos contam nos mesmos dias, para a
// conversão comparar o que é comparável. Sem a contagem (since vazio), anonymous fica null.
function anonymousSeries(base, rows, since) {
    const hits = (Array.isArray(rows) ? rows : []).map(h => ({ day: String(h.day).slice(0, 10), event: h.event, source: h.source, device: h.device, hits: Number(h.hits) || 0 }));
    const byDay = new Map();
    hits.forEach(h => { if (!byDay.has(h.day)) byDay.set(h.day, []); byDay.get(h.day).push(h); });
    const sum = (list, event) => (list || []).reduce((n, h) => n + (h.event === event ? h.hits : 0), 0);
    const series = base.map(d => {
        const list = byDay.get(d.date);
        return { ...d, anon: !!since && d.date >= since, visits: sum(list, "visit"), anonPageViews: sum(list, "page_view"), cart: sum(list, "cart"), checkout: sum(list, "checkout") };
    });
    if (!since || !series.length) return { series, anonymous: null };
    const from = since > series[0].date ? since : series[0].date, win = series.filter(d => d.date >= from);
    const total = key => win.reduce((n, d) => n + (Number(d[key]) || 0), 0);
    const sources = {}, devices = { mobile: 0, desktop: 0 };
    hits.filter(h => h.event === "visit" && h.day >= from && h.day <= series[series.length - 1].date).forEach(h => {
        sources[h.source] = (sources[h.source] || 0) + h.hits;
        if (devices[h.device] != null) devices[h.device] += h.hits;
    });
    return {
        series,
        anonymous: {
            since, from, to: series[series.length - 1].date,
            visits: total("visits"), pageViews: total("anonPageViews"), cart: total("cart"), checkout: total("checkout"), paidOrders: total("purchases"),
            sources: Object.entries(sources).map(([source, visits]) => ({ source, visits })).sort((a, b) => b.visits - a.visits),
            devices
        }
    };
}

module.exports = { HIT_EVENTS, SOURCE_CODES, sourceOf, deviceOf, isBot, optedOut, storeDay, anonymousHits, anonymousSeries, cleanHost };
