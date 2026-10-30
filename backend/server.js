// MONTÊ backend — alterações de frontend acompanham este serviço.
// Fluxo de confirmação: somente pedidos pagos podem exibir compra concluída.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const cors = require("cors");

// Este servidor roda no Render (Node) e no Cloudflare Workers (nodejs_compat).
// No Workers não há arquivos do projeto no disco nem timers fora de uma requisição:
// as páginas saem dos assets do Worker e as tarefas periódicas viram Cron Triggers
// (veja backend/worker.js e wrangler.jsonc).
const IS_WORKERS = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
if (!IS_WORKERS) require("dotenv").config();
// Pasta dos arquivos do site. No Workers não existe __dirname: lá as páginas vêm dos assets.
const SITE_DIR = IS_WORKERS ? "/" : path.join(__dirname, "..");

// No Workers, o backend/worker.mjs entrega aqui o binding ASSETS dos arquivos do site.
let siteAssets = null;
function setSiteAssets(assets) { siteAssets = assets; }

// No Workers, o que continua depois da resposta precisa do waitUntil (senão é cancelado).
// O backend/worker.mjs entrega essa função aqui; no Node a tarefa só segue rodando.
let backgroundRunner = null;
function setBackgroundRunner(fn) { backgroundRunner = typeof fn === "function" ? fn : null; }
function runInBackground(promise) {
    const task = Promise.resolve(promise).catch(error => console.error("Tarefa em segundo plano:", error?.message || error));
    if (backgroundRunner) {
        try { backgroundRunner(task); } catch (error) { console.warn("waitUntil indisponível:", error.message); }
    }
    return task;
}

// Plano gratuito do Cloudflare Workers: cada execução (uma requisição ou um minuto do
// cron) faz no máximo 50 chamadas externas (Olist, Supabase, e-mail...). As rotinas
// longas contam as próprias chamadas e param antes do limite; o resto fica para a próxima.
const WORKER_CALL_LIMIT = 50;
function createCallBudget(limit) {
    return {
        left: Math.max(0, Math.floor(limit)),
        has(n = 1) { return this.left >= n; },
        use(n = 1) {
            if (this.left < n) {
                const error = new Error("CALL_BUDGET_EXHAUSTED");
                error.budget = true;
                throw error;
            }
            this.left -= n;
        }
    };
}
function spend(budget, n = 1) { if (budget) budget.use(n); }

// Texto de uma página do site (para montar a página inicial com o catálogo dentro).
async function readSitePage(file) {
    if (!IS_WORKERS) return require("fs").promises.readFile(path.join(SITE_DIR, file), "utf8");
    const response = await siteAssets.fetch(new Request("https://assets.local/" + file));
    if (!response.ok) throw new Error("Página não encontrada: " + file);
    return response.text();
}

// Páginas com endereço sem ".html" (/, /admin, /pagamento-sucesso).
async function sendSitePage(res, file) {
    if (!IS_WORKERS) return res.sendFile(path.join(SITE_DIR, file));
    try {
        const response = await siteAssets.fetch(new Request("https://assets.local/" + file));
        if (!response.ok) return res.status(404).send("Não encontrado.");
        res.setHeader("Cache-Control", "no-cache");
        return res.status(200).type("html").send(await response.text());
    } catch (error) {
        console.error("Página do site:", file, error);
        return res.status(500).send("Não foi possível carregar a página.");
    }
}

const app = express();

// Cabeçalhos de segurança, origem (CORS) e leitura do corpo valem para TODAS as rotas, inclusive
// as registradas logo abaixo (Olist e pagamento): por isso entram aqui, antes de qualquer rota.
// As funções ficam definidas mais abaixo, na seção MIDDLEWARES.
app.use((req, res, next) => securityHeaders(req, res, next));
app.use((req, res, next) => corsGate(req, res, next));
app.use("/api/admin/uploads", (req, res, next) => requireAdmin(req, res, next), (req, res, next) => uploadJsonParser(req, res, next));
app.use((req, res, next) => jsonParser(req, res, next));
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

/* =====================================================
   CONFIGURAÇÕES
   Fluxo atual: MONTÊ → InfinitePay → Supabase → painel admin.
===================================================== */

const SITE_URL =
    process.env.SITE_URL ||
    "https://monte-site-itjk.onrender.com";

// Endereço público da loja, usado no que o Google e as clientes veem
// (sitemap, robots, links de produto e dos e-mails). SITE_URL continua
// sendo usado pelas integrações (InfinitePay e Olist), que estão
// cadastradas com o endereço do Render.
const PUBLIC_SITE_URL = safeString(process.env.PUBLIC_SITE_URL || "https://oficialmontee.com.br").replace(/\/$/, "");

const INFINITEPAY_API =
    "https://api.checkout.infinitepay.io/links";

const INFINITEPAY_HANDLE =
    process.env.INFINITEPAY_HANDLE ||
    "monte-64839705-0z9";

// Quando o pagamento não abre: aviso curto, e "payment_unavailable" faz o site mostrar, junto do
// botão de finalizar, o atalho para concluir a compra pelo WhatsApp. O motivo técnico fica no log.
const CHECKOUT_FAILED_MESSAGE = "O pagamento não abriu. Tente novamente.";

/* =====================================================
   OLIST ERP — integração somente de pedidos
   Olist NÃO sincroniza catálogo nem estoque do MONTÊ.
===================================================== */
const OLIST_API_BASE = safeString(process.env.OLIST_API_BASE || "https://api.tiny.com.br/public-api/v3").replace(/\/$/, "");
const OLIST_TOKEN = safeString(process.env.OLIST_TOKEN);
const OLIST_CLIENT_ID = safeString(process.env.OLIST_CLIENT_ID);
const OLIST_CLIENT_SECRET = safeString(process.env.OLIST_CLIENT_SECRET);
const OLIST_REFRESH_TOKEN = safeString(process.env.OLIST_REFRESH_TOKEN);
const OLIST_REDIRECT_URI = safeString(process.env.OLIST_REDIRECT_URI || (SITE_URL.replace(/\/$/, "") + "/api/olist/callback"));
const OLIST_OAUTH_AUTH_URL = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth";
const OLIST_OAUTH_TOKEN_URL = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token";
// "false" desliga toda chamada à Olist neste servidor (pedidos, catálogo e renovação do
// acesso). Usado no Worker de teste enquanto o Render ainda atende a loja: o refresh
// token da Olist muda a cada renovação, e dois servidores renovando se atrapalham.
const OLIST_SYNC_ENABLED = safeString(process.env.OLIST_SYNC_ENABLED || "true").toLowerCase() !== "false";

let olistAccessToken = OLIST_TOKEN || null;
let olistAccessTokenExpiresAt = OLIST_TOKEN ? Number.MAX_SAFE_INTEGER : 0;
let olistRefreshToken = null;

async function loadPersistedOlistRefreshToken(force = false) {
    if (olistRefreshToken && !force) return olistRefreshToken;
    if (!SUPABASE_SERVICE_ROLE_KEY) return OLIST_REFRESH_TOKEN || null;

    try {
        const rows = await supabaseRequest(
            "kv_store_48db9b7e?key=eq.olist_oauth_tokens&select=value&limit=1",
            {method:"GET"}
        );
        const value = rows?.[0]?.value || {};
        const token = safeString(value.refresh_token);
        // Outra instância (o Worker roda em várias) pode já ter renovado: reaproveita o acesso dela.
        const accessExpiresAt = Number(value.access_expires_at) || 0;
        if (safeString(value.access_token) && accessExpiresAt - 60000 > Date.now()) {
            olistAccessToken = safeString(value.access_token);
            olistAccessTokenExpiresAt = accessExpiresAt;
        }
        if (token) {
            olistRefreshToken = token;
            return token;
        }
        olistRefreshToken = OLIST_REFRESH_TOKEN || null;
        return olistRefreshToken;
    } catch (error) {
        console.warn("Olist refresh token persistido indisponível:", error.message);
        return null;
    }
}

async function persistOlistRefreshToken(refreshToken, access = null) {
    const token = safeString(refreshToken);
    if (!token || !SUPABASE_SERVICE_ROLE_KEY) return;

    try {
        await supabaseRequest(
            "kv_store_48db9b7e?on_conflict=key",
            {
                method:"POST",
                headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},
                body:JSON.stringify({
                    key:"olist_oauth_tokens",
                    value:{
                        refresh_token:token,
                        ...(access ? {access_token:access.token, access_expires_at:access.expiresAt} : {}),
                        updated_at:new Date().toISOString()
                    }
                })
            }
        );
    } catch (error) {
        console.error("Olist refresh token não pôde ser persistido:", error.message);
    }
}

async function getOlistAccessToken(retried = false, forceRefresh = false) {
    if (!OLIST_SYNC_ENABLED) throw new Error("OLIST_SYNC_DISABLED");
    if (!forceRefresh && olistAccessToken && Date.now() < olistAccessTokenExpiresAt - 60000) {
        return olistAccessToken;
    }

    // Sempre relê o Supabase antes de renovar: o refresh token muda a cada renovação
    // e outra instância pode ter renovado (e guardado um acesso válido) há pouco.
    await loadPersistedOlistRefreshToken(true);
    if (!forceRefresh && olistAccessToken && Date.now() < olistAccessTokenExpiresAt - 60000) {
        return olistAccessToken;
    }

    if (!OLIST_CLIENT_ID || !OLIST_CLIENT_SECRET || !olistRefreshToken) {
        throw new Error("OLIST_AUTH_REQUIRED");
    }

    const response = await fetch("https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token", {
        method: "POST",
        headers: {"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"},
        body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: OLIST_CLIENT_ID,
            client_secret: OLIST_CLIENT_SECRET,
            refresh_token: olistRefreshToken
        })
    });
    const textResponse = await response.text();
    let data = {};
    try { data = textResponse ? JSON.parse(textResponse) : {}; } catch { data = {raw:textResponse}; }
    if ((!response.ok || !data.access_token) && !retried) {
        // Pode ter perdido a corrida para outra instância: relê o token guardado e tenta de novo.
        olistAccessToken = null;
        olistAccessTokenExpiresAt = 0;
        return getOlistAccessToken(true, false);
    }
    if (!response.ok || !data.access_token) {
        console.error("Olist OAuth: renovação recusada", {
            status: response.status,
            error: safeString(data.error) || null,
            description: safeString(data.error_description || data.message) || null
        });
        throw new Error("OLIST_AUTH_REFRESH_FAILED");
    }
    olistAccessToken = data.access_token;
    olistRefreshToken = data.refresh_token || olistRefreshToken;
    olistAccessTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    await persistOlistRefreshToken(olistRefreshToken, {token:olistAccessToken, expiresAt:olistAccessTokenExpiresAt});
    return olistAccessToken;
}

async function olistRequest(endpoint, options = {}, allowRefresh = true) {
    const token = await getOlistAccessToken();
    let response = await fetchWithTimeout(OLIST_API_BASE + endpoint, {
        ...options,
        headers: {
            "Accept":"application/json",
            "Content-Type":"application/json",
            "Authorization":"Bearer " + token,
            ...(options.headers || {})
        }
    }, 15000);

    // Token recusado (ex.: OLIST_TOKEN fixo já expirado). Após um reinício o
    // refresh token do OAuth só existe no Supabase, então ele é carregado aqui
    // antes de desistir da renovação.
    if (response.status === 401 && allowRefresh && OLIST_CLIENT_ID && OLIST_CLIENT_SECRET) {
        if (!olistRefreshToken) await loadPersistedOlistRefreshToken();
        if (olistRefreshToken) {
            olistAccessToken = null;
            olistAccessTokenExpiresAt = 0;
            await getOlistAccessToken();
            return olistRequest(endpoint, options, false);
        }
    }

    const textResponse = await response.text();
    let data = {};
    try { data = textResponse ? JSON.parse(textResponse) : {}; } catch { data = {raw:textResponse}; }
    if (!response.ok) {
        // Preserve o corpo completo devolvido pela Olist. A API V3 normalmente
        // informa em mensagem/detalhes qual campo do payload está inválido.
        const errorDetails = data && typeof data === "object" ? data : {raw: textResponse};
        const error = new Error(
            "Olist API " + response.status +
            (Object.keys(errorDetails).length ? ": " + JSON.stringify(errorDetails) : "")
        );
        error.status = response.status;
        error.data = errorDetails;
        error.body = textResponse;
        error.endpoint = endpoint;

        console.error("🔴 Olist API error:", {
            status: response.status,
            endpoint,
            response: errorDetails
        });

        throw error;
    }
    return data;
}

function olistItemsFromResponse(data) {
    return Array.isArray(data?.itens) ? data.itens : (Array.isArray(data) ? data : []);
}

// Garante o acesso à Olist antes de um lote. Renovar usa até 3 chamadas
// (Supabase, Olist e Supabase de novo); com o acesso em memória, nenhuma.
async function ensureOlistAccess(budget) {
    if (olistAccessToken && Date.now() < olistAccessTokenExpiresAt - 60000) return;
    spend(budget, 3);
    await getOlistAccessToken();
}

async function findOlistProductBySku(sku) {
    const code = safeString(sku);
    if (!code) throw new Error("OLIST_SKU_MISSING");
    const data = await olistRequest("/produtos?codigo=" + encodeURIComponent(code) + "&limit=20");
    const items = olistItemsFromResponse(data);
    const exact = items.find(p => safeString(p.sku || p.codigo) === code);
    if (!exact?.id) throw new Error("OLIST_PRODUCT_NOT_FOUND:" + code);
    return exact;
}

function formatCpfCnpj(digits) {
    if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    return digits;
}

function findContactWithCpf(contacts, cpf) {
    return contacts.find(c => safeString(c?.cpfCnpj).replace(/\D/g, "") === cpf) || null;
}

// A Olist guarda o CPF formatado ("621.068.433-56"); a busca só com
// números não encontra o contato. Tenta os dois formatos.
async function findOlistContactIdByCpf(cpf) {
    for (const term of [...new Set([formatCpfCnpj(cpf), cpf])]) {
        const contacts = olistItemsFromResponse(
            await olistRequest("/contatos?cpfCnpj=" + encodeURIComponent(term) + "&limit=20")
        );
        const match = findContactWithCpf(contacts, cpf);
        if (match?.id) return match.id;
        // Se a listagem não trouxer o CPF, um único resultado do filtro é o contato.
        if (contacts.length === 1 && contacts[0]?.id && !safeString(contacts[0].cpfCnpj)) return contacts[0].id;
    }
    return null;
}

async function findOrCreateOlistContact(order) {
    const cpf = safeString(order.customer_cpf).replace(/\D/g, "");
    if (cpf) {
        const existingId = await findOlistContactIdByCpf(cpf);
        if (existingId) return existingId;
    }

    const address = order.customer_address && typeof order.customer_address === "object" ? order.customer_address : {};
    const payload = {
        nome: safeString(order.customer_name) || "Cliente MONTÊ",
        tipoPessoa: cpf.length === 11 ? "F" : "J",
        cpfCnpj: cpf || null,
        celular: safeString(order.customer_whatsapp || order.customer_phone) || null,
        telefone: safeString(order.customer_phone) || null,
        email: safeString(order.customer_email) || null,
        endereco: {
            endereco: safeString(address.street) || null,
            numero: safeString(address.number) || null,
            complemento: safeString(address.complement) || null,
            bairro: safeString(address.neighborhood) || null,
            municipio: safeString(address.city) || null,
            cep: safeString(address.cep).replace(/\D/g, "") || null,
            uf: safeString(address.state) || null,
            pais: "Brasil"
        },
        situacao: "B"
    };

    let created;
    try {
        created = await olistRequest("/contatos", {method:"POST", body:JSON.stringify(payload)});
    } catch (error) {
        // O contato já existe, mas o filtro por CPF não o encontrou:
        // procura pelo nome e confirma pelo CPF antes de reaproveitar.
        if (cpf && error.status === 400 && /j[aá] existe/i.test(String(error.body || error.message))) {
            const byName = olistItemsFromResponse(
                await olistRequest("/contatos?nome=" + encodeURIComponent(payload.nome) + "&limit=100")
            );
            const match = findContactWithCpf(byName, cpf);
            if (match?.id) return match.id;
        }
        throw error;
    }
    if (!created?.id) throw new Error("OLIST_CONTACT_CREATE_FAILED");
    return created.id;
}

// As formas de recebimento mudam pouco: guardamos a lista por 1 hora para
// não gastar o limite de requisições da Olist a cada pedido.
let olistReceiptFormsCache = {expiresAt:0, items:[]};

async function findOlistPaymentIds(paymentMethod) {
    const wanted = safeString(paymentMethod).toLowerCase();
    const terms = wanted === "pix"
        ? ["pix"]
        : ["cartão de crédito", "cartao de credito", "cartão", "cartao"];

    if (Date.now() > olistReceiptFormsCache.expiresAt) {
        const recebimentos = await olistRequest("/formas-recebimento?limit=100");
        olistReceiptFormsCache = {expiresAt:Date.now() + 60 * 60 * 1000, items:olistItemsFromResponse(recebimentos)};
    }

    for (const term of terms) {
        const hit = olistReceiptFormsCache.items.find(x => safeString(x.nome).toLowerCase().includes(term));
        if (hit?.id) return {formaRecebimentoId:Number(hit.id)};
    }
    return {formaRecebimentoId:null};
}

function olistAddressFromOrder(order) {
    const a = order.customer_address && typeof order.customer_address === "object" ? order.customer_address : {};
    return {
        endereco: safeString(a.street) || null,
        enderecoNro: safeString(a.number) || null,
        complemento: safeString(a.complement) || null,
        bairro: safeString(a.neighborhood) || null,
        municipio: safeString(a.city) || null,
        cep: safeString(a.cep).replace(/\D/g, "") || null,
        uf: safeString(a.state) || null,
        fone: safeString(order.customer_phone || order.customer_whatsapp) || null,
        nomeDestinatario: safeString(order.customer_name) || null,
        cpfCnpj: safeString(order.customer_cpf).replace(/\D/g, "") || null,
        tipoPessoa: "F"
    };
}

// Preço unitário com o desconto do Pix, em centavos. É o mesmo valor cobrado pela
// InfinitePay no checkout. O percentual vem do painel (aba Promoções); pedidos antigos,
// sem o valor cobrado guardado no item, usam os 5% da época.
function pixDiscountedUnitCents(price, percent = 5) {
    return Math.round(Math.round(Number(price || 0) * 100) * (100 - percent) / 100);
}

async function createOrGetOlistOrder(order) {
    const ecommerceNumber = safeString(order.order_nsu);
    if (!ecommerceNumber) throw new Error("OLIST_ORDER_NUMBER_MISSING");

    // Só reaproveita um pedido da Olist se ele for realmente desta venda;
    // nunca o primeiro resultado da busca às cegas.
    const existingResponse = await olistRequest("/pedidos?numeroPedidoEcommerce=" + encodeURIComponent(ecommerceNumber) + "&limit=20");
    const existing = olistItemsFromResponse(existingResponse).find(o =>
        safeString(o?.ecommerce?.numeroPedidoEcommerce ?? o?.numeroPedidoEcommerce) === ecommerceNumber
    );
    if (existing?.id) {
        return {id:Number(existing.id), numeroPedido:existing.numeroPedido || null, created:false};
    }

    const isPix = safeString(order.payment_method).toLowerCase() === "pix";

    const rawItems = Array.isArray(order.items) ? order.items : [];
    const productCache = new Map();
    const orderItems = [];

    for (const item of rawItems) {
        const sku = safeString(item.variant_sku || item.sku);
        if (!sku) throw new Error("OLIST_SKU_MISSING_FOR_ORDER_ITEM:" + safeString(item.name || item.description || item.id));
        let product = productCache.get(sku);
        if (!product) {
            product = await findOlistProductBySku(sku);
            productCache.set(sku, product);
        }
        // No Pix a cliente pagou 5% a menos nos produtos; a Olist recebe o valor real.
        // Com cupom, o item guarda o que foi cobrado (charged_units), já com o Pix.
        const lines = Array.isArray(item.charged_units) && item.charged_units.length
            ? item.charged_units.map(line => ({quantidade: Number(line.quantity), valorUnitario: Number(line.unit_cents) / 100}))
            : [{
                quantidade: Math.max(1, Number(item.quantity || 1)),
                valorUnitario: isPix ? pixDiscountedUnitCents(item.price) / 100 : Number(item.price || 0)
            }];
        const color = safeString(item.variant_color || item.color);
        const info = [color ? "Cor: " + color : "", isGiftItem(item) ? "Presente: " + safeString(item.promotion_name || "promoção") : ""].filter(Boolean).join(" | ");
        for (const line of lines) {
            orderItems.push({
                produto: {id:Number(product.id), tipo:"P"},
                quantidade: line.quantidade,
                valorUnitario: line.valorUnitario,
                infoAdicional: info || null,
                gift: isGiftItem(item)
            });
        }
    }

    if (!orderItems.length) throw new Error("OLIST_ORDER_WITHOUT_ITEMS");
    const giftLines = orderItems.filter(line => line.gift);
    orderItems.forEach(line => delete line.gift);

    const contactId = await findOrCreateOlistContact(order);
    const paymentIds = await findOlistPaymentIds(order.payment_method);

    // Número que a cliente e o painel mostram (ex.: MONTÊ-0007).
    const monteCode = formatOrderCode(order.order_code || ecommerceNumber);
    const shippingName = safeString(order.shipping_service_name);

    const payload = {
        idContato: Number(contactId),
        situacao: 3,
        data: new Date().toISOString().slice(0,10),
        numeroOrdemCompra: monteCode,
        valorFrete: Number(order.shipping || 0),
        observacoesInternas: "Pedido " + monteCode +
            " | Pagamento: " + (isPix ? "Pix" : "Cartão de crédito") + " (pago na InfinitePay)" +
            (order.coupon_code ? " | Cupom " + safeString(order.coupon_code) + " (-R$ " + Number(order.coupon_discount || 0).toFixed(2).replace(".", ",") + ")" : "") +
            (shippingName ? " | Frete: " + shippingName : "") +
            " | InfinitePay " + safeString(order.transaction_nsu) +
            " | Ref. " + ecommerceNumber,
        ecommerce: {numeroPedidoEcommerce:ecommerceNumber},
        enderecoEntrega: olistAddressFromOrder(order),
        itens: orderItems
    };

    // O "meio de pagamento" da Olist não é a lista de /formas-pagamento
    // (a Olist recusava com "Meio de pagamento não encontrado"); enviamos só
    // a forma de recebimento. A forma de pagamento também vai na observação.
    if (paymentIds.formaRecebimentoId) {
        payload.pagamento = {formaRecebimento:{id:paymentIds.formaRecebimentoId}};
    }

    let created;
    try {
        created = await olistRequest("/pedidos", {method:"POST", body:JSON.stringify(payload)});
    } catch (error) {
        // Campos opcionais (pagamento e nº da ordem de compra): se a Olist
        // recusar só eles, cria o pedido sem esses campos em vez de travar.
        const optional = campo => campo.startsWith("pagamento") || campo === "numeroOrdemCompra";
        const onlyOptionalProblem = error.status === 400 &&
            Array.isArray(error.data?.detalhes) && error.data.detalhes.length &&
            error.data.detalhes.every(d => optional(safeString(d?.campo)));
        // Presente da promoção (valor zero) recusado: o pedido vai sem ele e o presente fica
        // escrito na observação, para a loja lançar à parte.
        if (!onlyOptionalProblem && error.status === 400 && giftLines.length) {
            console.warn("Olist recusou o pedido com o presente; enviando sem ele:", ecommerceNumber);
            payload.itens = orderItems.filter(line => !giftLines.includes(line));
            payload.observacoesInternas += " | PRESENTE (lançar à parte): " +
                orderGiftItems(order).map(item => safeString(item.name) + (item.variant_color ? " " + safeString(item.variant_color) : "") + (item.variant_sku ? " SKU " + safeString(item.variant_sku) : "")).join(", ");
            created = await olistRequest("/pedidos", {method:"POST", body:JSON.stringify(payload)});
            if (!created?.id) throw new Error("OLIST_ORDER_CREATE_FAILED");
            return {id:Number(created.id), numeroPedido:created.numeroPedido || null, created:true};
        }
        if (!onlyOptionalProblem) throw error;
        const rejected = error.data.detalhes.map(d => safeString(d.campo));
        console.warn("Olist recusou campos opcionais; criando o pedido sem eles:", ecommerceNumber, rejected.join(", "));
        if (rejected.some(campo => campo.startsWith("pagamento"))) delete payload.pagamento;
        if (rejected.includes("numeroOrdemCompra")) delete payload.numeroOrdemCompra;
        created = await olistRequest("/pedidos", {method:"POST", body:JSON.stringify(payload)});
    }
    if (!created?.id) throw new Error("OLIST_ORDER_CREATE_FAILED");

    return {id:Number(created.id), numeroPedido:created.numeroPedido || null, created:true};
}

/* =====================================================
   OLIST — SINCRONIZAÇÃO SOMENTE DE PEDIDOS
   Nunca cria produtos, nunca importa catálogo e nunca
   altera o estoque do MONTÊ a partir da Olist.
===================================================== */

async function syncPaidOrderToOlist(order) {
    if (!OLIST_SYNC_ENABLED) throw new Error("OLIST_SYNC_DISABLED");
    if (!order) throw new Error("OLIST_ORDER_MISSING");
    if (safeString(order.status).toLowerCase() !== "paid") {
        throw new Error("OLIST_ORDER_NOT_PAID");
    }

    let result;
    if (order.olist_order_id) {
        result = {id:Number(order.olist_order_id), created:false};
    } else {
        result = await createOrGetOlistOrder(order);
    }

    await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
        method:"PATCH",
        body:JSON.stringify({
            olist_order_id:result.id,
            olist_sync_status:"completed",
            olist_sync_error:null,
            olist_synced_at:new Date().toISOString()
        })
    });

    return {...result, catalogSynced:false, stockSynced:false};
}

const olistSyncLocks = new Set();
// Espera entre tentativas automáticas de um pedido que falhou, para não
// repetir a cada minuto e esgotar o limite de requisições da Olist. No Workers a
// memória não dura entre execuções, então a espera fica gravada no pedido (updated_at).
const olistRetryAfter = new Map();
const OLIST_RETRY_DELAY_MS = 10 * 60 * 1000;
const OLIST_RATE_LIMIT_DELAY_MS = 2 * 60 * 1000;

async function processPendingOlistOrder(order) {
    if (!OLIST_SYNC_ENABLED) return {skipped:true};
    if (!order?.id || olistSyncLocks.has(String(order.id))) return {skipped:true};
    if (safeString(order.status).toLowerCase() !== "paid") return {skipped:true};
    // Pedido de pré-venda ainda não aceito (ou recusado) pela loja: não vai para a Olist.
    if (order.approval_status && order.approval_status !== "accepted") return {skipped:true};

    olistSyncLocks.add(String(order.id));
    try {
        console.log("🔄 Olist — processando pedido pago:", order.order_nsu || order.id);

        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
            method:"PATCH",
            body:JSON.stringify({
                olist_sync_status:"processing",
                olist_sync_error:null,
                updated_at:new Date().toISOString()
            })
        });

        await syncPaidOrderToOlist(order);

        olistRetryAfter.delete(String(order.id));
        console.log("🟢 Olist — pedido sincronizado:", order.order_nsu || order.id);
        return {ok:true};
    } catch (error) {
        const message = String(error?.message || error);
        const rateLimited = error?.status === 429;
        const delay = rateLimited ? OLIST_RATE_LIMIT_DELAY_MS : OLIST_RETRY_DELAY_MS;
        olistRetryAfter.set(String(order.id), Date.now() + delay);
        console.error("🔴 Olist — falha no pedido", order.order_nsu || order.id, message);

        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
            method:"PATCH",
            body:JSON.stringify({
                olist_sync_status:"error",
                olist_sync_error:message,
                // A próxima tentativa automática vem quando updated_at passar de 10 minutos.
                updated_at:new Date(Date.now() - OLIST_RETRY_DELAY_MS + delay).toISOString()
            })
        }).catch(() => {});
        return {ok:false, rateLimited};
    } finally {
        olistSyncLocks.delete(String(order.id));
    }
}

// Um pedido por execução: cada um usa umas 15 chamadas externas (Olist e Supabase).
// Devolve quantas chamadas usou, para o lote de estoque do mesmo minuto usar o resto.
async function runPendingOlistSync() {
    let calls = 0;
    if (!OLIST_SYNC_ENABLED) return {calls};
    // Após um reinício, o refresh token obtido via OAuth existe apenas no Supabase.
    if (!OLIST_TOKEN && OLIST_CLIENT_ID && OLIST_CLIENT_SECRET && !olistRefreshToken) {
        calls++;
        await loadPersistedOlistRefreshToken();
    }
    if (!OLIST_TOKEN && !(OLIST_CLIENT_ID && OLIST_CLIENT_SECRET && (OLIST_REFRESH_TOKEN || olistRefreshToken))) {
        return {calls};
    }

    try {
        calls++;
        const rows = await supabaseRequest(
            "orders?status=eq.paid&and=(or(olist_sync_status.is.null,olist_sync_status.neq.completed),or(approval_status.is.null,approval_status.eq.accepted))&select=*&order=paid_at.asc&limit=10",
            {method:"GET"}
        );

        // Nunca tentados entram na hora; os que falharam ou travaram, depois da espera.
        const retryBefore = Date.now() - OLIST_RETRY_DELAY_MS;
        const order = (Array.isArray(rows) ? rows : []).find(o =>
            (olistRetryAfter.get(String(o.id)) || 0) <= Date.now() &&
            (!o.olist_sync_status || !o.updated_at || Date.parse(o.updated_at) < retryBefore)
        );
        if (!order) return {calls};
        calls += 16 + (Array.isArray(order.items) ? order.items.length : 0);
        await processPendingOlistOrder(order);
    } catch (error) {
        console.error("🔴 Olist — erro no worker automático:", error.message || error);
    }
    return {calls};
}

app.get("/api/olist/config-check", requireAdmin, (req, res) => {
    return res.json({
        configured: Boolean(OLIST_CLIENT_ID && OLIST_CLIENT_SECRET),
        client_id_suffix: safeString(OLIST_CLIENT_ID).slice(-6) || null,
        redirect_uri: OLIST_REDIRECT_URI,
        oauth_token_url: OLIST_OAUTH_TOKEN_URL
    });
});

// Conexão com a Olist (OAuth). O "state" leva o hash de um código aleatório guardado num
// cookie só deste navegador; na volta, a sessão do painel, o cookie e o state precisam bater,
// e o código vale uma vez só. Assim um link de volta vazado não serve para ligar outra conta.
const OLIST_OAUTH_COOKIE = "monte_olist_oauth";
const sha256Hex = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const htmlText = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);

app.get("/api/olist/auth", async (req, res) => {
    // Só quem está logado no painel pode trocar a conta Olist que recebe os pedidos.
    if (safeString(req.headers["sec-fetch-site"]).toLowerCase() === "cross-site" || !(await currentAdminSession(req).catch(() => null))) {
        return res.status(401).send("<p>Entre no painel da MONTÊ (<a href=\"/admin\">/admin</a>) e use o botão <strong>Reconectar Olist</strong> na aba Estoque.</p>");
    }
    if (!OLIST_CLIENT_ID || !OLIST_CLIENT_SECRET) {
        return res.status(503).send("Olist OAuth não está configurado no servidor.");
    }
    // Estado assinado (vale 10 minutos): funciona mesmo se a volta da Olist cair em outra instância.
    const nonce = crypto.randomBytes(24).toString("base64url");
    res.setHeader("Set-Cookie", OLIST_OAUTH_COOKIE + "=" + nonce + "; Path=/api/olist/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600");
    const state = createSignedToken({purpose:"olist-oauth", nh: sha256Hex(nonce)}, 10 * 60 * 1000);
    const params = new URLSearchParams({
        client_id: OLIST_CLIENT_ID,
        redirect_uri: OLIST_REDIRECT_URI,
        response_type: "code",
        scope: "openid",
        state
    });
    return res.redirect(OLIST_OAUTH_AUTH_URL + "?" + params.toString());
});

app.get("/api/olist/callback", async (req, res) => {
    const state = safeString(req.query.state);
    const code = safeString(req.query.code);
    const oauthError = safeString(req.query.error);
    const statePayload = verifySignedToken(state);
    const expiresAt = statePayload?.purpose === "olist-oauth" ? statePayload.exp : 0;
    const nonce = parseCookies(req)[OLIST_OAUTH_COOKIE] || "";
    // O código do cookie vale uma vez só: sai já na primeira volta.
    res.setHeader("Set-Cookie", OLIST_OAUTH_COOKIE + "=; Path=/api/olist/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    res.type("html");

    if (oauthError) return res.status(400).send("Autorização Olist não concluída.");
    if (!state || !expiresAt || expiresAt < Date.now()) return res.status(400).send("Solicitação de autorização expirada.");
    if (!nonce || !statePayload.nh || statePayload.nh !== sha256Hex(nonce)) {
        return res.status(400).send("Autorização não iniciada neste navegador. Volte ao painel e clique em RECONECTAR OLIST de novo.");
    }
    if (!(await currentAdminSession(req).catch(() => null))) {
        return res.status(401).send("Entre no painel da MONTÊ e clique em RECONECTAR OLIST de novo.");
    }
    if (!code) return res.status(400).send("Código de autorização ausente.");

    try {
        const response = await fetch(OLIST_OAUTH_TOKEN_URL, {
            method: "POST",
            headers: {"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"},
            body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: OLIST_CLIENT_ID,
                client_secret: OLIST_CLIENT_SECRET,
                code,
                redirect_uri: OLIST_REDIRECT_URI
            })
        });
        const responseText = await response.text();
        let data = {};
        try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }

        if (!response.ok || !data.access_token || !data.refresh_token) {
            const oauthCode = safeString(data.error);
            const oauthDescription = safeString(data.error_description || data.message);
            console.error("Olist OAuth callback: token exchange failed", {
                status: response.status,
                error: oauthCode || null,
                description: oauthDescription || null,
                clientIdSuffix: safeString(OLIST_CLIENT_ID).slice(-6),
                redirectUri: OLIST_REDIRECT_URI
            });

            if (response.status === 401 && (oauthCode === "invalid_client" || !oauthCode)) {
                return res.status(502).send(
                    "A Olist rejeitou as credenciais do aplicativo (HTTP 401). " +
                    "O Client Secret configurado no Render precisa ser o último Client Secret gerado no aplicativo MONTÊ E-commerce. " +
                    "Após gerar novas chaves na Olist, a chave antiga é invalidada. " +
                    (oauthDescription ? "Detalhe: " + htmlText(oauthDescription) : "")
                );
            }

            return res.status(502).send(
                "Falha OAuth da Olist (HTTP " + response.status + "). " +
                (oauthCode ? htmlText(oauthCode) + ". " : "") +
                htmlText(oauthDescription || "A Olist não retornou um token OAuth válido.")
            );
        }
        olistAccessToken = data.access_token;
        olistRefreshToken = data.refresh_token;
        olistAccessTokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
        await persistOlistRefreshToken(olistRefreshToken);
        await olistRequest("/formas-pagamento?limit=1", {method:"GET"});

        // A sincronização de catálogo Olist está desativada: somente pedidos
        // pagos são enviados à Olist (ver runPendingOlistSync).
        return res.send("<h2>Olist autorizado com sucesso.</h2><p>A conexão OAuth foi validada. Os pedidos pagos serão sincronizados automaticamente.</p>");
    } catch (error) {
        console.error("Olist OAuth callback:", error.message);
        return res.status(502).send("A autorização foi recebida, mas a validação da API falhou.");
    }
});

app.get("/api/olist/health", requireAdmin, async (req,res) => {
    try {
        if (!OLIST_TOKEN && !(OLIST_CLIENT_ID && (olistRefreshToken || OLIST_REFRESH_TOKEN))) {
            return res.status(503).json({success:false,configured:false,message:"Credenciais Olist não configuradas."});
        }
        const data = await olistRequest("/formas-pagamento?limit=1");
        return res.json({success:true,configured:true,reachable:true,payment_forms:Array.isArray(data?.itens)?data.itens.length:null});
    } catch (error) {
        console.error("Olist health:", error);
        return res.status(502).json({success:false,configured:true,reachable:false,message:/OLIST_AUTH/.test(String(error.message))?"A conexão com a Olist expirou. Clique em RECONECTAR OLIST.":"Olist indisponível no momento."});
    }
});


// OLIST CATALOG — preview and manual synchronization.
// Preview is read-only against both Olist and MONTÊ.
// Catálogo Olist desativado: MONTÊ não importa, cria ou atualiza produtos via Olist.
// OLIST — reprocessa uma venda já paga no MONTÊ.
// Não cria cobrança nem altera o pagamento. A operação é idempotente:
// se o pedido já tiver sido criado na Olist, reutiliza o olist_order_id salvo.
app.post("/api/admin/olist/sync-paid-order", requireAdmin, async (req, res) => {
    try {
        const orderNsu = safeString(req.body?.order_nsu);
        const orderId = safeString(req.body?.order_id);

        if (!orderNsu && !orderId) {
            return res.status(400).json({
                success:false,
                message:"Informe order_nsu ou order_id da venda já paga."
            });
        }

        const filter = orderId
            ? "id=eq." + encodeURIComponent(orderId)
            : "order_nsu=eq." + encodeURIComponent(orderNsu);

        const rows = await supabaseRequest(
            "orders?" + filter + "&select=*,order_items(*)&limit=1",
            {method:"GET"}
        );
        const order = Array.isArray(rows) ? rows[0] : null;

        if (!order) {
            return res.status(404).json({
                success:false,
                message:"Venda não encontrada no MONTÊ."
            });
        }

        if (safeString(order.status).toLowerCase() !== "paid") {
            return res.status(409).json({
                success:false,
                message:"A venda encontrada não está marcada como paga.",
                status:order.status || null
            });
        }

        if (order.approval_status && order.approval_status !== "accepted") {
            return res.status(409).json({
                success:false,
                message:"Pedido de pré-venda: aceite o pedido antes de enviar para a Olist."
            });
        }

        try {
            const result = await syncPaidOrderToOlist({
                ...order,
                payment_method: order.payment_method || "credit_card"
            });

            return res.json({
                success:true,
                paid:true,
                charged_again:false,
                order_nsu:order.order_nsu,
                olist_sync:result
            });
        } catch (error) {
            const details = error?.data || null;
            const message = String(error?.message || error || "Falha na sincronização Olist.");

            console.error("🔴 Olist sync manual da venda paga:", {
                order_nsu: order.order_nsu,
                order_id: order.id,
                status: error?.status || null,
                endpoint: error?.endpoint || null,
                message,
                details
            });

            await supabaseRequest(
                "orders?id=eq." + encodeURIComponent(order.id),
                {
                    method:"PATCH",
                    body:JSON.stringify({
                        olist_sync_status:"error",
                        olist_sync_error:message
                    })
                }
            ).catch(()=>{});

            return res.status(502).json({
                success:false,
                paid:true,
                charged_again:false,
                order_nsu:order.order_nsu,
                olist_status:error?.status || null,
                message: adminErrorMessage(error, "A Olist recusou o pedido. Veja o detalhe no pedido, em Olist.")
            });
        }
    } catch (error) {
        console.error("Olist sync-paid-order:", error);
        return res.status(500).json({
            success:false,
            message:"Não foi possível processar a sincronização da venda paga."
        });
    }
});



// Sem espaços nem "/" no fim: o endereço é emendado com "/rest/v1/...", "/storage/v1/...".
const SUPABASE_URL = String(process.env.SUPABASE_URL || "https://uvrhougaurupvkxmezwy.supabase.co").trim().replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPERFRETE_API_URL = process.env.SUPERFRETE_API_URL || "https://api.superfrete.com";
const SUPERFRETE_TOKEN = process.env.SUPERFRETE_TOKEN;
const SUPERFRETE_ORIGIN_CEP = String(process.env.SUPERFRETE_ORIGIN_CEP || "60183680").replace(/\D/g, "");
const SUPERFRETE_USER_AGENT = process.env.SUPERFRETE_USER_AGENT || "MONTÊ/1.0 (vitorvolpe14@gmail.com)";
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v23.0";
const WHATSAPP_PHONE_NUMBER_ID = safeString(process.env.WHATSAPP_PHONE_NUMBER_ID);
const WHATSAPP_ACCESS_TOKEN = safeString(process.env.WHATSAPP_ACCESS_TOKEN);
const WHATSAPP_TEMPLATE_NAME = safeString(process.env.WHATSAPP_TEMPLATE_NAME || "monte_rastreio");
const WHATSAPP_TEMPLATE_LANGUAGE = safeString(process.env.WHATSAPP_TEMPLATE_LANGUAGE || "pt_BR");
const WHATSAPP_ADMIN_PHONE = safeString(process.env.WHATSAPP_ADMIN_PHONE);
const WHATSAPP_ADMIN_TEMPLATE_NAME = safeString(process.env.WHATSAPP_ADMIN_TEMPLATE_NAME || "monte_nova_venda");
const WHATSAPP_ADMIN_TEMPLATE_LANGUAGE = safeString(process.env.WHATSAPP_ADMIN_TEMPLATE_LANGUAGE || "pt_BR");

const RESEND_API_KEY = safeString(process.env.RESEND_API_KEY);
const RESEND_FROM_EMAIL = safeString(process.env.RESEND_FROM_EMAIL || "contato@oficialmontee.com.br");
const RESEND_MARKETING_FROM_EMAIL = safeString(process.env.RESEND_MARKETING_FROM_EMAIL || "mkt@oficialmontee.com.br");
const RESEND_FROM_NAME = safeString(process.env.RESEND_FROM_NAME || "MONTÊ");
const ORDER_NOTIFICATION_EMAILS = safeString(process.env.ORDER_NOTIFICATION_EMAILS);
async function sendWhatsAppTrackingNotification(order) {
    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
        return { sent: false, status: "not_configured", message_id: null };
    }

    let phone = String(order.customer_whatsapp || order.customer_phone || "").replace(/\D/g, "");
    // Meta expects the country code. Accept both 5585... and local 85... formats.
    if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
    const trackingCode = safeString(order.tracking_code);
    const trackingUrl = safeString(order.tracking_url);
    if (phone.length < 10 || !trackingCode) {
        return { sent: false, status: "invalid_recipient_or_tracking", message_id: null };
    }

    const firstName = safeString(order.customer_name).split(/\s+/)[0] || "cliente";
    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const apiUrl = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            type: "template",
            template: {
                name: WHATSAPP_TEMPLATE_NAME,
                language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
                components: [
                    {
                        type: "body",
                        parameters: [
                            { type: "text", text: firstName },
                            { type: "text", text: orderCode },
                            { type: "text", text: trackingCode },
                            { type: "text", text: trackingUrl || "Acompanhe pelo site da MONTÊ." }
                        ]
                    }
                ]
            }
        })
    });

    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }

    if (!response.ok) {
        throw new Error(`WhatsApp API ${response.status}: ${JSON.stringify(data)}`);
    }

    const messageId = data?.messages?.[0]?.id || null;
    return { sent: true, status: "sent", message_id: messageId };
}

function formatWhatsAppCurrency(value) {
    return "R$ " + Number(value || 0).toFixed(2).replace(".", ",");
}

function formatWhatsAppPaymentMethod(method) {
    const value = safeString(method).toLowerCase();
    if (value === "pix") return "Pix";
    if (value === "credit_card" || value === "card") return "Cartão de crédito";
    return value || "Não informado";
}

function formatWhatsAppAddress(address) {
    if (!address || typeof address !== "object") return "Não informado";
    const parts = [
        address.street,
        address.number ? "nº " + address.number : "",
        address.complement,
        address.neighborhood,
        address.city,
        address.state,
        address.cep ? "CEP " + address.cep : ""
    ].filter(Boolean);
    return parts.join(", ") || "Não informado";
}

async function sendWhatsAppAdminNewOrderNotification(order) {
    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN || !WHATSAPP_ADMIN_PHONE) {
        return { sent: false, status: "not_configured", message_id: null };
    }
    if (!order || order.whatsapp_admin_notification_sent_at) {
        return { sent: false, status: "already_sent", message_id: order?.whatsapp_admin_notification_message_id || null };
    }

    let phone = WHATSAPP_ADMIN_PHONE.replace(/\D/g, "");
    if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
    if (phone.length < 12) return { sent: false, status: "invalid_admin_phone", message_id: null };

    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const customerName = safeString(order.customer_name) || "Não informado";
    const customerPhone = safeString(order.customer_phone || order.customer_whatsapp) || "Não informado";
    const cpf = safeString(order.customer_cpf) || "Não informado";
    const products = Array.isArray(order.items) && order.items.length
        ? order.items.map(item => {
            const variant = safeString(item.variant_color || item.color);
            const name = safeString(item.name || item.product_name || item.description) || "Produto";
            const qty = Math.max(1, Number(item.quantity || 1));
            const unit = Number(item.price ?? item.unit_price ?? 0);
            return qty + "x " + name + (variant ? " (" + variant + ")" : "") + " — " + (isGiftItem(item) ? "PRESENTE" : formatWhatsAppCurrency(unit));
        }).join("\n")
        : "Consultar itens no painel administrativo.";
    const customerData = "Tel.: " + customerPhone + "\nCPF: " + cpf + "\nEndereço: " + formatWhatsAppAddress(order.customer_address);
    const apiUrl = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + WHATSAPP_ACCESS_TOKEN,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            type: "template",
            template: {
                name: WHATSAPP_ADMIN_TEMPLATE_NAME,
                language: { code: WHATSAPP_ADMIN_TEMPLATE_LANGUAGE },
                components: [{
                    type: "body",
                    parameters: [
                        { type: "text", text: orderCode },
                        { type: "text", text: customerName },
                        { type: "text", text: products },
                        { type: "text", text: formatWhatsAppPaymentMethod(order.payment_method) },
                        { type: "text", text: formatWhatsAppCurrency(order.total) },
                        { type: "text", text: customerData }
                    ]
                }]
            }
        })
    });

    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }
    if (!response.ok) {
        throw new Error("WhatsApp API " + response.status + ": " + JSON.stringify(data));
    }
    return {
        sent: true,
        status: "sent",
        message_id: data?.messages?.[0]?.id || null
    };
}

function formatOrderCode(value) {
    const raw = safeString(value);
    if (/^\d{4,8}$/.test(raw)) return "MONTÊ-" + raw;
    if (/^MONTÊ-\d{4,8}$/i.test(raw)) return "MONTÊ-" + raw.replace(/^MONTÊ-/i, "");
    return raw;
}

function normalizeOrderCode(value) {
    const raw = safeString(value).trim();
    // Como a cliente digita o número: "0057", "57", "#0057", "MONTÊ-0057", "MONTÊ 0057", "Pedido 0057".
    const match = raw.match(/^(?:pedido\s*)?(?:MONT[EÊ]\s*-?\s*)?(?:n[ºo°.]?\s*)?#?\s*(\d{1,8})$/i);
    return match ? match[1].padStart(4, "0") : raw;
}

function escapeEmailHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(new RegExp(String.fromCharCode(39), "g"), "&#039;");
}

async function sendOrderConfirmationEmail(order) {
    if (!order?.customer_email || !order?.order_nsu) return { sent: false, status: "invalid_recipient" };
    if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { sent: false, status: "not_configured" };
    const email = safeString(order.customer_email).toLowerCase();
    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const customerName = safeString(order.customer_name).split(/\s+/)[0] || "cliente";
    const total = Number(order.total || 0);
    const purchasesUrl = PUBLIC_SITE_URL + "/minhas-compras.html?order_nsu=" + encodeURIComponent(orderCode);
    const gifts = orderGiftItems(order).map(item => safeString(item.name) + (item.variant_color ? " (" + safeString(item.variant_color) + ")" : "")).join(", ");
    const giftTerms = [...new Set(orderGiftItems(order).map(item => safeString(item.promotion_terms)).filter(Boolean))].join(" ");
    const html = "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
      "<div style=\"max-width:620px;margin:0 auto;padding:40px 20px;\"><div style=\"background:#111;color:#fff;text-align:center;padding:24px 20px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
      "<div style=\"background:#fff;padding:38px 30px;\"><p style=\"margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#777;\">COMPRA CONFIRMADA</p>" +
      "<h1 style=\"margin:0 0 18px;font-size:28px;font-weight:500;\">Obrigada pela sua compra, " + escapeEmailHtml(customerName) + ".</h1>" +
      "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Seu pagamento foi confirmado e seu pedido já está registrado na MONTÊ.</p>" +
      "<div style=\"margin:28px 0;padding:20px;background:#f7f5f2;\"><p style=\"margin:0 0 8px;font-size:11px;letter-spacing:1.5px;color:#777;\">NÚMERO DO PEDIDO</p><strong style=\"font-size:20px;\">" + escapeEmailHtml(orderCode) + "</strong><p style=\"margin:14px 0 0;font-size:14px;color:#555;\">Total: <strong>R$ " + total.toFixed(2).replace(".", ",") + "</strong></p></div>" +
      (orderHasPresale(order) ? "<p style=\"font-size:15px;line-height:1.7;color:#555;\"><strong>Pré-venda:</strong> seu pedido tem peça em produção, com estoque limitado. A entrega é em " + PRESALE_MIN_BUSINESS_DAYS + " dias úteis. A MONTÊ confirma o seu pedido em breve; se não for possível atender, o valor pago é devolvido integralmente.</p>" : "") +
      (gifts ? "<p style=\"font-size:15px;line-height:1.7;color:#555;\"><strong>Seu presente:</strong> " + escapeEmailHtml(gifts) + " vai junto no pedido." + (giftTerms ? " " + escapeEmailHtml(giftTerms) : "") + "</p>" : "") +
      "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Acompanhe o status do seu pedido e novas atualizações pela área <strong>Minhas Compras</strong>.</p>" +
      "<div style=\"text-align:center;margin:30px 0;\"><a href=\"" + purchasesUrl + "\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:15px 26px;font-size:13px;letter-spacing:1.5px;\">ACESSAR MINHAS COMPRAS</a></div></div>" +
      "<p style=\"text-align:center;font-size:11px;color:#999;margin:20px 0;\">MONTÊ — Bolsas e acessórios</p></div></body></html>";
    const text = "Compra confirmada na MONTÊ\n\nPedido: " + orderCode + "\nTotal: R$ " + total.toFixed(2).replace(".", ",") +
        (orderHasPresale(order) ? "\n\nPré-venda: a entrega é em " + PRESALE_MIN_BUSINESS_DAYS + " dias úteis." : "") +
        (gifts ? "\n\nSeu presente: " + gifts + " vai junto no pedido." + (giftTerms ? " " + giftTerms : "") : "") +
        "\n\nAcesse: " + purchasesUrl;
    const idempotencyKey = "monte-order-confirmation-" + String(order.order_nsu);
    const response = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{"Authorization":"Bearer "+RESEND_API_KEY,"Content-Type":"application/json","Accept":"application/json","Idempotency-Key":idempotencyKey},
        body:JSON.stringify({
            from:RESEND_FROM_NAME+" <"+RESEND_FROM_EMAIL+">",
            to:[email],
            subject:"MONTÊ — Pedido "+orderCode+" confirmado",
            text, html,
            tags:[{name:"type",value:"order_confirmation"},{name:"order_nsu",value:String(order.order_nsu)}]
        })
    });
    const responseText=await response.text();
    let data={}; try{data=responseText?JSON.parse(responseText):{}}catch{data={raw:responseText};}
    if(!response.ok) throw new Error("Resend API "+response.status+": "+JSON.stringify(data));
    return {sent:true,status:"sent",message_id:data?.id||null,idempotency_key:idempotencyKey};
}
function trackingStatusLabel(status) {
    return ({
        paid: "Pagamento confirmado",
        processing: "Pedido em separação",
        shipped: "Pedido enviado",
        delivered: "Pedido entregue"
    })[status] || status || "Atualização do pedido";
}


// Comprovante da InfinitePay: só https e só nos domínios dela.
function infinitePayReceiptUrl(value) {
    try {
        const url = new URL(safeString(value));
        const host = url.hostname.toLowerCase();
        const allowed = ["infinitepay.io", "infinitepay.com.br", "infinitepay.com"].some(domain => host === domain || host.endsWith("." + domain));
        return url.protocol === "https:" && allowed ? url.href : null;
    } catch {
        return null;
    }
}

async function sendAdminSaleNotificationEmail(order) {
    if (!order?.order_nsu) return { sent: false, status: "invalid_order" };
    if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { sent: false, status: "not_configured" };
    const recipients = ORDER_NOTIFICATION_EMAILS.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
    if (!recipients.length) return { sent: false, status: "no_recipients" };
    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const customerName = safeString(order.customer_name) || "Não informado";
    const customerEmail = safeString(order.customer_email) || "Não informado";
    const customerPhone = safeString(order.customer_phone || order.customer_whatsapp) || "Não informado";
    const paymentMethod = formatWhatsAppPaymentMethod(order.payment_method);
    const address = formatWhatsAppAddress(order.customer_address);
    const total = Number(order.total || 0);
    const items = Array.isArray(order.items) && order.items.length
        ? order.items.map(item => {
            const name = safeString(item.name || item.product_name || item.description) || "Produto";
            const color = safeString(item.variant_color || item.color);
            const qty = Math.max(1, Number(item.quantity || 1));
            const unit = Number(item.price ?? item.unit_price ?? 0);
            return qty + "x " + escapeEmailHtml(name) + (color ? " (" + escapeEmailHtml(color) + ")" : "") + (item.presale === true ? " — PRÉ-VENDA" : "") + (isGiftItem(item) ? " — PRESENTE (" + escapeEmailHtml(item.promotion_name || "promoção") + ")" : " — R$ " + unit.toFixed(2).replace(".", ","));
        }).join("<br>")
        : "Consultar itens do pedido no painel.";
    const html =
        "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
        "<div style=\"max-width:680px;margin:0 auto;padding:32px 18px;\">" +
        "<div style=\"background:#111;color:#fff;text-align:center;padding:22px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
        "<div style=\"background:#fff;padding:30px;\">" +
        "<p style=\"margin:0 0 8px;font-size:11px;letter-spacing:2px;color:#777;\">NOVA VENDA</p>" +
        "<h1 style=\"margin:0 0 22px;font-size:28px;font-weight:500;\">Pagamento confirmado</h1>" +
        (order.approval_status === "pending" ? "<p style=\"padding:14px;background:#f6efe8;border-left:3px solid #571b29;font-size:14px;line-height:1.6;\"><strong>Pré-venda:</strong> aceite ou recuse este pedido no painel (Pedidos). Recusado, ele é cancelado e o valor precisa ser estornado no app da InfinitePay.</p>" : "") +
        (order.pix_paid_by_card ? "<p style=\"padding:14px;background:#fff4e5;border-left:3px solid #b35c00;font-size:14px;line-height:1.6;\"><strong>Atenção:</strong> este pedido foi feito com o desconto do Pix, mas a cliente pagou com cartão no link da InfinitePay. Confira antes de enviar.</p>" : "") +
        "<div style=\"padding:18px;background:#f7f5f2;margin-bottom:20px;\"><strong style=\"font-size:20px;\">" + escapeEmailHtml(orderCode) + "</strong><br><span style=\"font-size:14px;color:#555;\">Total: <strong>R$ " + total.toFixed(2).replace(".", ",") + "</strong></span></div>" +
        "<h3 style=\"font-size:14px;letter-spacing:1px;\">CLIENTE</h3>" +
        "<p style=\"line-height:1.7;font-size:14px;\">Nome: " + escapeEmailHtml(customerName) + "<br>E-mail: " + escapeEmailHtml(customerEmail) + "<br>Telefone: " + escapeEmailHtml(customerPhone) + "<br>Endereço: " + escapeEmailHtml(address) + "</p>" +
        "<h3 style=\"font-size:14px;letter-spacing:1px;\">PRODUTOS</h3>" +
        "<p style=\"line-height:1.8;font-size:14px;\">" + items + "</p>" +
        "<p style=\"font-size:14px;line-height:1.7;\"><strong>Pagamento:</strong> " + escapeEmailHtml(paymentMethod) + (order.coupon_code ? "<br><strong>Cupom:</strong> " + escapeEmailHtml(order.coupon_code) + " (-R$ " + Number(order.coupon_discount || 0).toFixed(2).replace(".", ",") + ")" : "") + "<br><strong>Frete:</strong> R$ " + Number(order.shipping || 0).toFixed(2).replace(".", ",") + "<br><strong>Total:</strong> R$ " + total.toFixed(2).replace(".", ",") + "</p>" +
        "</div><p style=\"text-align:center;font-size:11px;color:#999;margin:18px 0;\">MONTÊ — Notificação interna de venda</p></div></body></html>";
    const text =
        "NOVA VENDA MONTÊ\n\nPedido: " + orderCode + "\nCliente: " + customerName +
        "\nE-mail: " + customerEmail + "\nTelefone: " + customerPhone +
        "\nProdutos: " + (Array.isArray(order.items) ? order.items.map(i => (i.quantity || 1) + "x " + (i.name || i.product_name || "Produto")).join("; ") : "Consultar pedido") +
        "\nPagamento: " + paymentMethod + "\nTotal: R$ " + total.toFixed(2).replace(".", ",");
    const response = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{"Authorization":"Bearer "+RESEND_API_KEY,"Content-Type":"application/json","Accept":"application/json","Idempotency-Key":"monte-admin-sale-"+String(order.order_nsu)},
        body:JSON.stringify({from:RESEND_FROM_NAME+" <"+RESEND_FROM_EMAIL+">",to:recipients,subject:(order.approval_status==="pending"?"PRÉ-VENDA (ACEITE NO PAINEL) — ":"")+(order.pix_paid_by_card?"⚠️ PIX PAGO NO CARTÃO — ":"")+"MONTÊ — NOVA VENDA "+orderCode+" — R$ "+total.toFixed(2).replace(".", ","),text,html})
    });
    const responseText=await response.text();
    let data={}; try{data=responseText?JSON.parse(responseText):{}}catch{data={raw:responseText};}
    if(!response.ok) throw new Error("Resend API "+response.status+": "+JSON.stringify(data));
    return {sent:true,status:"sent",message_id:data?.id||null};
}
async function ensureAdminSaleNotificationEmail(order) {
    if (!order || order.admin_sale_email_sent_at) return {sent:false,status:"already_sent"};
    try {
        const result=await sendAdminSaleNotificationEmail(order);
        await supabaseRequest("orders?id=eq."+encodeURIComponent(order.id),{method:"PATCH",body:JSON.stringify({admin_sale_email_status:result.status,admin_sale_email_sent_at:result.sent?new Date().toISOString():null})});
        return result;
    } catch(error) {
        console.error("E-mail interno de nova venda:",error);
        await supabaseRequest("orders?id=eq."+encodeURIComponent(order.id),{method:"PATCH",body:JSON.stringify({admin_sale_email_status:"error"})}).catch(()=>{});
        return {sent:false,status:"error",error:error.message};
    }
}
async function sendOrderTrackingEmail(order) {
    if (!order?.customer_email || !order?.order_nsu) return { sent: false, status: "invalid_recipient", message_id: null };
    if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return { sent: false, status: "not_configured", message_id: null };

    const email = safeString(order.customer_email).toLowerCase();
    const orderCode = formatOrderCode(order.order_code || order.order_nsu);
    const customerName = safeString(order.customer_name).split(/\s+/)[0] || "cliente";
    const status = safeString(order.status).toLowerCase();
    const statusLabel = trackingStatusLabel(status);
    const carrier = safeString(order.shipping_carrier);
    const trackingCode = safeString(order.tracking_code);
    const trackingUrl = safeString(order.tracking_url);
    const purchasesUrl = PUBLIC_SITE_URL + "/minhas-compras.html?order_nsu=" + encodeURIComponent(orderCode);
    const total = Number(order.total || 0);

    if (status === "shipped" && !trackingCode) {
        throw new Error("O pedido precisa ter código de rastreio para enviar o e-mail de envio.");
    }

    let shippingBlock = "";
    if (status === "shipped" || status === "delivered") {
        shippingBlock =
            "<div style=\"margin:24px 0;padding:20px;background:#f7f5f2;\">" +
            "<p style=\"margin:0 0 12px;font-size:11px;letter-spacing:1.5px;color:#777;\">DETALHES DA ENTREGA</p>" +
            (carrier ? "<p style=\"margin:7px 0;font-size:14px;\"><strong>Transportadora:</strong> " + escapeEmailHtml(carrier) + "</p>" : "") +
            "<p style=\"margin:7px 0;font-size:14px;\"><strong>Código de rastreio:</strong> " + escapeEmailHtml(trackingCode || "—") + "</p>" +
            (trackingUrl ? "<p style=\"margin:16px 0 0;\"><a href=\"" + trackingUrl.replace(/"/g, "&quot;") + "\" style=\"color:#111;font-size:14px;font-weight:bold;\">ACOMPANHAR ENTREGA</a></p>" : "") +
            "</div>";
    }

    const html =
        "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
        "<div style=\"max-width:620px;margin:0 auto;padding:40px 20px;\">" +
        "<div style=\"background:#111;color:#fff;text-align:center;padding:24px 20px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
        "<div style=\"background:#fff;padding:38px 30px;\">" +
        "<p style=\"margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#777;\">ATUALIZAÇÃO DO PEDIDO</p>" +
        "<h1 style=\"margin:0 0 18px;font-size:28px;font-weight:500;\">Olá, " + escapeEmailHtml(customerName) + ".</h1>" +
        "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Seu pedido <strong>" + escapeEmailHtml(orderCode) + "</strong> foi atualizado.</p>" +
        "<div style=\"margin:24px 0;padding:22px;background:#f7f5f2;text-align:center;\"><p style=\"margin:0 0 8px;font-size:11px;letter-spacing:1.5px;color:#777;\">STATUS ATUAL</p><strong style=\"font-size:21px;\">" + escapeEmailHtml(statusLabel) + "</strong></div>" +
        shippingBlock +
        "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Você pode consultar os detalhes completos do pedido e acompanhar novas atualizações pela área <strong>Minhas Compras</strong>.</p>" +
        "<div style=\"text-align:center;margin:30px 0;\"><a href=\"" + purchasesUrl + "\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:15px 26px;font-size:13px;letter-spacing:1.5px;\">ACESSAR MINHAS COMPRAS</a></div>" +
        "<p style=\"font-size:13px;line-height:1.6;color:#777;\">Total do pedido: <strong>R$ " + total.toFixed(2).replace(".", ",") + "</strong></p>" +
        "</div><p style=\"text-align:center;font-size:11px;color:#999;margin:20px 0;\">MONTÊ — Bolsas e acessórios</p></div></body></html>";

    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
            from: RESEND_FROM_NAME ? RESEND_FROM_NAME + " <" + RESEND_FROM_EMAIL + ">" : RESEND_FROM_EMAIL,
            to: [email],
            subject: "MONTÊ — Pedido " + orderCode + " · " + statusLabel,
            html
        })
    });

    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }
    if (!response.ok) throw new Error("Resend API " + response.status + ": " + JSON.stringify(data));
    return { sent: true, status: "sent", message_id: data?.id || null };
}

async function ensureWhatsAppAdminNewOrderNotification(order) {
    if (!order || order.whatsapp_admin_notification_sent_at) {
        return { sent: false, status: "already_sent", message_id: order?.whatsapp_admin_notification_message_id || null };
    }
    try {
        const result = await sendWhatsAppAdminNewOrderNotification(order);
        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
            method: "PATCH",
            body: JSON.stringify({
                whatsapp_admin_notification_status: result.status,
                whatsapp_admin_notification_sent_at: result.sent ? new Date().toISOString() : null,
                whatsapp_admin_notification_message_id: result.message_id
            })
        });
        return result;
    } catch (error) {
        console.error("WhatsApp nova venda:", error);
        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
            method: "PATCH",
            body: JSON.stringify({ whatsapp_admin_notification_status: "error" })
        }).catch(() => {});
        return { sent: false, status: "error", message_id: null, error: error.message };
    }
}

async function ensureOrderConfirmationEmail(order) {
    if (!order || order.order_confirmation_email_sent_at) return { sent: false, status: "already_sent" };
    try {
        const result = await sendOrderConfirmationEmail(order);
        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
            method: "PATCH",
            body: JSON.stringify({ order_confirmation_email_status: result.status, order_confirmation_email_sent_at: result.sent ? new Date().toISOString() : null })
        });
        return result;
    } catch (error) {
        console.error("E-mail de confirmação do pedido:", error);
        await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), { method: "PATCH", body: JSON.stringify({ order_confirmation_email_status: "error" }) }).catch(() => {});
        return { sent: false, status: "error", error: error.message };
    }
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function supabaseRequest(path, options = {}) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
    }

    const startedAt = Date.now();
    const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
            ...(options.headers || {})
        }
    }, 12000);

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
        throw new Error(`Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }

    console.log(`Supabase OK ${response.status} em ${Date.now() - startedAt}ms: ${String(path).slice(0, 140)}`);
    return data;
}

// Pré-venda: bolsas que ainda vão chegar. A entrega é em 10 dias úteis (ou no prazo da
// transportadora, se for maior).
const PRESALE_MIN_BUSINESS_DAYS = 10;
const orderHasPresale = order => Array.isArray(order?.items) && order.items.some(item => item?.presale === true);

const METROPOLITAN_CITIES = new Set(["AQUIRAZ","CAUCAIA","EUSEBIO","GUAIUBA","ITAITINGA","MARACANAU"]);

// Benefícios fixos da loja, editados no painel (aba Promoções) e guardados no kv_store:
// - frete grátis só na entrega MONTÊ (Fortaleza e região metropolitana), a partir de um
//   valor em peças (preço de tabela, antes do Pix e do cupom; o frete não conta);
// - desconto do Pix nas peças (o frete fica integral).
// O script.js recebe os mesmos valores por /api/promocoes.
const STORE_BENEFITS_KEY = "store_benefits";
const STORE_BENEFITS_DEFAULT = {
    free_shipping: { enabled: true, min_subtotal: Number(process.env.FREE_SHIPPING_MIN || 599) },
    pix_discount: { enabled: true, percent: 5 }
};
const FREE_SHIPPING_OPTION_IDS = new Set(["monte-fortaleza", "monte-regiao-metropolitana"]);

function normalizeStoreBenefits(value) {
    const shipping = value?.free_shipping || {};
    const pix = value?.pix_discount || {};
    const min = Number(shipping.min_subtotal);
    const percent = Number(pix.percent);
    return {
        free_shipping: {
            enabled: shipping.enabled !== false,
            min_subtotal: Number.isFinite(min) && min > 0 ? Number(min.toFixed(2)) : STORE_BENEFITS_DEFAULT.free_shipping.min_subtotal
        },
        pix_discount: {
            enabled: pix.enabled !== false,
            percent: Number.isFinite(percent) && percent > 0 && percent <= 50 ? Number(percent.toFixed(2)) : STORE_BENEFITS_DEFAULT.pix_discount.percent
        }
    };
}

async function loadStoreBenefits() {
    const rows = await supabaseRequest("kv_store_48db9b7e?key=eq." + STORE_BENEFITS_KEY + "&select=value&limit=1", { method: "GET" });
    return normalizeStoreBenefits(rows?.[0]?.value || STORE_BENEFITS_DEFAULT);
}

// Com cache de 30 s; se o Supabase falhar, valem os benefícios padrão.
async function storeBenefits() {
    try {
        return await cachedPublic("store_benefits", 30 * 1000, loadStoreBenefits);
    } catch (error) {
        console.error("Benefícios da loja:", error.message);
        return normalizeStoreBenefits(STORE_BENEFITS_DEFAULT);
    }
}

const pixPercentOf = benefits => benefits?.pix_discount?.enabled ? Number(benefits.pix_discount.percent) : 0;

function shippingChargeFor(option, productsSubtotal, benefits) {
    const price = Number(option?.price || 0);
    const free = benefits?.free_shipping;
    return free?.enabled && FREE_SHIPPING_OPTION_IDS.has(option?.id) && productsSubtotal >= Number(free.min_subtotal) ? 0 : price;
}

// Frase dos e-mails de lembrete com os benefícios que estão valendo.
function benefitsSentence(benefits) {
    const parts = [];
    if (benefits?.pix_discount?.enabled) parts.push("no Pix, você ganha " + String(benefits.pix_discount.percent).replace(".", ",") + "% de desconto");
    if (benefits?.free_shipping?.enabled) parts.push("em Fortaleza e região metropolitana o frete é grátis em compras a partir de R$ " + Number(benefits.free_shipping.min_subtotal).toFixed(2).replace(".", ",").replace(",00", ""));
    if (!parts.length) return "";
    const text = parts.join(", e ") + ".";
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// CEPs de Fortaleza e da região metropolitana começam com 60 ou 61 (60000-000 a 61999-999).
function isLocalDeliveryCep(cep) {
    const digits = safeString(cep).replace(/\D/g, "");
    return digits.length === 8 && /^6[01]/.test(digits);
}

function localShippingOption(city, state) {
    const normalized = normalizeCity(city);
    const normalizedState = safeString(state).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    if (normalizedState !== "CE") return null;
    if (normalized === "FORTALEZA") return { id:"monte-fortaleza", name:"Entrega MONTÊ — Fortaleza", price:15, delivery_days:1 };
    if (METROPOLITAN_CITIES.has(normalized)) return { id:"monte-regiao-metropolitana", name:"Entrega MONTÊ — Região Metropolitana", price:20, delivery_days:3 };
    return null;
}

const SHIPPING_DEFAULTS = {
    bolsas: { weight: 0.8, height: 12, width: 25, length: 32 },
    acessorios: { weight: 0.3, height: 8, width: 20, length: 25 }
};

function normalizeShippingProduct(row, quantity) {
    const defaults = SHIPPING_DEFAULTS[String(row.category || "bolsas").toLowerCase()] || SHIPPING_DEFAULTS.bolsas;
    const values = [
        Number(row.shipping_weight_kg),
        Number(row.shipping_height_cm),
        Number(row.shipping_width_cm),
        Number(row.shipping_length_cm)
    ];
    const fallback = [defaults.weight, defaults.height, defaults.width, defaults.length];
    const resolved = values.map((value, index) => (
        Number.isFinite(value) && value > 0 ? value : fallback[index]
    ));
    // O painel pede o peso em kg. Acima de 30 kg (limite dos Correios) é peso digitado em
    // gramas (480 em vez de 0,480), que deixaria o produto sem nenhuma opção de frete.
    if (resolved[0] > 30) resolved[0] = resolved[0] / 1000;
    return {
        quantity: Math.max(1, Number(quantity || 1)),
        weight: resolved[0],
        height: resolved[1],
        width: resolved[2],
        length: resolved[3]
    };
}

async function calculateSuperfreteQuotes({toCep,items}) {
    if (!SUPERFRETE_TOKEN) throw new Error("SUPERFRETE_TOKEN não configurado no Render.");
    if (!SUPERFRETE_ORIGIN_CEP || SUPERFRETE_ORIGIN_CEP.length!==8) throw new Error("SUPERFRETE_ORIGIN_CEP não configurado corretamente.");
    const grouped=new Map();
    for(const item of Array.isArray(items)?items:[]){const id=safeString(item.id||item.product_id);const quantity=Math.max(1,Number(item.quantity||1));if(id) grouped.set(id,(grouped.get(id)||0)+quantity);}
    if(!grouped.size) throw new Error("Nenhum produto válido para calcular o frete.");
    const productRows=await Promise.all([...grouped.entries()].map(async([id,quantity])=>{
        const rows=await supabaseRequest("products?id=eq."+encodeURIComponent(id)+"&active=eq.true&select=id,name,category,shipping_weight_kg,shipping_height_cm,shipping_width_cm,shipping_length_cm",{method:"GET"});
        const product=Array.isArray(rows)?rows[0]:null;
        if(!product) throw new Error("Produto não encontrado para cálculo de frete.");
        const shippingProduct=normalizeShippingProduct(product,quantity);
        if(!shippingProduct) throw new Error(`O produto "${product.name||"sem nome"}" ainda não possui peso e dimensões cadastrados para o cálculo de frete.`);
        return shippingProduct;
    }));
    const response=await fetch(`${SUPERFRETE_API_URL.replace(/\/$/,"")}/api/v0/calculator`,{
        method:"POST",
        headers:{"Authorization":`Bearer ${SUPERFRETE_TOKEN}`,"User-Agent":SUPERFRETE_USER_AGENT,"Accept":"application/json","Content-Type":"application/json"},
        body:JSON.stringify({from:{postal_code:SUPERFRETE_ORIGIN_CEP},to:{postal_code:String(toCep).replace(/\D/g,"")},services:"1,2,17,3,33",options:{own_hand:false,receipt:false,insurance_value:0,use_insurance_value:false},products:productRows})
    });
    const responseText=await response.text();
    let data={}; try{data=responseText?JSON.parse(responseText):{}}catch{data={raw:responseText};}
    if(!response.ok){console.error("SuperFrete cotação:",response.status,data);throw new Error("A SuperFrete não conseguiu calcular o frete para este CEP.");}
    const candidates=Array.isArray(data)?data:(data?.services||data?.data||data?.results||data?.cotation||data?.quotes||[]);
    const list=Array.isArray(candidates)?candidates:(candidates&&typeof candidates==="object"?Object.values(candidates):[]);
    const quotes=list.map(service=>{
        const price=Number(service?.price??service?.custom_price??service?.value??service?.amount);
        const id=service?.id??service?.service_id??service?.code;
        const name=service?.name||service?.service||service?.service_name;
        const range=service?.delivery_range||service?.deliveryRange||{};
        const min=Number(service?.delivery_min??service?.delivery_time_min??range?.min??service?.delivery_time);
        const max=Number(service?.delivery_max??service?.delivery_time_max??range?.max??service?.delivery_time);
        if(!id||!name||!Number.isFinite(price)||price<=0)return null;
        return {id:String(id),name:String(name),price:Number(price.toFixed(2)),delivery_days:Number.isFinite(max)?Math.max(1,max):null,delivery_min_days:Number.isFinite(min)?Math.max(1,min):null,delivery_max_days:Number.isFinite(max)?Math.max(1,max):null};
    }).filter(Boolean);
    const unique=new Map(); for(const quote of quotes) if(!unique.has(quote.id)) unique.set(quote.id,quote);
    return [...unique.values()];
}

/* =====================================================
   MIDDLEWARES
===================================================== */

const allowedOrigins = new Set([
    SITE_URL.replace(/\/$/, ""),
    PUBLIC_SITE_URL,
    "https://oficialmontee.com.br",
    "https://www.oficialmontee.com.br",
    ...safeString(process.env.ALLOWED_ORIGINS).split(",").map(origin => origin.trim().replace(/\/$/, "")).filter(Boolean)
]);

// CSP sem 'unsafe-inline': nenhum script ou estilo dentro do HTML (eventos usam data-click,
// veja safe-html.js) e cada diretiva definida explicitamente. A mesma política está no
// arquivo _headers (páginas servidas direto dos assets); as duas precisam ficar iguais.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "frame-src 'none'",
    "form-action 'self'",
    "script-src 'self' https://www.googletagmanager.com",
    "script-src-attr 'none'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data: blob: https://uvrhougaurupvkxmezwy.supabase.co https://*.googletagmanager.com https://*.google-analytics.com",
    "connect-src 'self' https://uvrhougaurupvkxmezwy.supabase.co https://viacep.com.br https://*.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com",
    "media-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests"
].join("; ");

// Painel: mesma política, sem Google (o painel não usa) e sem poder ser aberto dentro de outra página.
const ADMIN_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY
    .replace(/ https:\/\/(\*|www)\.googletagmanager\.com/g, "")
    .replace(/ https:\/\/\*\.google-analytics\.com/g, "")
    .replace(/ https:\/\/\*\.analytics\.google\.com/g, "")
    .replace("frame-ancestors 'self'", "frame-ancestors 'none'");

function securityHeaders(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    if (IS_WORKERS || req.secure || req.headers["x-forwarded-proto"] === "https") {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (req.path.startsWith("/api/admin/") || req.path.startsWith("/api/olist/")) {
        res.setHeader("Cache-Control", "no-store");
    }
    next();
}

const corsMiddleware = cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false
});

// Requisição de outro site (com Origin de fora da lista): recusada com 403, sem executar a rota.
function corsGate(req, res, next) {
    const origin = safeString(req.headers.origin);
    if (origin && !allowedOrigins.has(origin.replace(/\/$/, ""))) {
        return res.status(403).json({ success: false, message: "Origem não autorizada." });
    }
    return corsMiddleware(req, res, next);
}

// Fotos chegam em base64 só nas rotas de upload do painel (até 20 MB por foto). O resto da
// API aceita no máximo 1 MB por requisição: menos espaço para abuso e menos CPU no Cloudflare.
// Corpo grande (fotos) só é lido depois de conferir a sessão do painel.
const uploadJsonParser = express.json({ limit: "30mb" });
const jsonParser = express.json({ limit: "1mb" });

/* =====================================================
   RATE LIMITING — proteção contra abuso de endpoints
===================================================== */
// IP real do visitante. No Workers o Cloudflare preenche CF-Connecting-IP (o visitante não
// consegue trocar); fora dele o cabeçalho viria do próprio visitante e não vale.
function clientIp(req) {
    if (IS_WORKERS) return safeString(req.headers["cf-connecting-ip"]) || "unknown";
    return req.ip || "unknown";
}

function createRateLimiter({ windowMs, max, keyFn = req => clientIp(req) }) {
    const buckets = new Map();

    const cleanup = () => {
        const now = Date.now();
        for (const [key, bucket] of buckets.entries()) {
            if (now - bucket.startedAt >= windowMs) buckets.delete(key);
        }
    };

    // No Workers não há timer de fundo: a limpeza acontece durante as próprias requisições.
    if (!IS_WORKERS) setInterval(cleanup, Math.min(windowMs, 5 * 60 * 1000)).unref();

    return (req, res, next) => {
        if (IS_WORKERS && buckets.size > 500) cleanup();
        const key = String(keyFn(req) || "unknown");
        const now = Date.now();
        let bucket = buckets.get(key);

        if (!bucket || now - bucket.startedAt >= windowMs) {
            bucket = { startedAt: now, count: 0 };
            buckets.set(key, bucket);
        }

        bucket.count += 1;

        if (bucket.count > max) {
            const retryAfter = Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000));
            res.setHeader("Retry-After", String(retryAfter));
            return res.status(429).json({
                success: false,
                message: "Muitas solicitações. Aguarde alguns instantes e tente novamente."
            });
        }

        next();
    };
}

const checkoutRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 12
});

const adminLoginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20
});

const orderStatusRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30
});

// Endpoints públicos que acionam APIs externas ou processamento pesado recebem
// limites próprios para reduzir abuso, consumo de quota e DoS.
const shippingQuoteRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 20
});

const newsletterRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5
});

const imageNormalizeRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 20
});

const infinitePayWebhookRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30
});

// Eventos de analytics têm limite próprio para não consumir a cota do checkout.
const analyticsRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120
});

/* =====================================================
   MONTÊ ADMIN AUTH — acesso exclusivo do administrador
===================================================== */
const ADMIN_EMAIL = safeString(process.env.ADMIN_EMAIL);
const ADMIN_PASSWORD_HASH = safeString(process.env.ADMIN_PASSWORD_HASH);
const ADMIN_SESSION_TTL = 1000 * 60 * 60 * 8;
// Sessão do painel em cookie assinado (HMAC), sem estado no servidor: o Worker roda em
// várias instâncias e o Render pode reiniciar, então guardar sessões na memória deslogava.
function signingKey(){return crypto.createHash("sha256").update("monte-signing:"+safeString(process.env.ADMIN_SESSION_SECRET)+":"+ADMIN_PASSWORD_HASH+":"+SUPABASE_SERVICE_ROLE_KEY).digest()}
function createSignedToken(data,ttlMs){const payload=Buffer.from(JSON.stringify({...data,exp:Date.now()+ttlMs,n:crypto.randomBytes(8).toString("hex")})).toString("base64url");const sig=crypto.createHmac("sha256",signingKey()).update(payload).digest("base64url");return payload+"."+sig}
function verifySignedToken(token){const [payload,sig]=String(token||"").split(".");if(!payload||!sig)return null;const expected=Buffer.from(crypto.createHmac("sha256",signingKey()).update(payload).digest("base64url"));const given=Buffer.from(sig);if(given.length!==expected.length||!crypto.timingSafeEqual(given,expected))return null;try{const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));if(!data||typeof data.exp!=="number"||Date.now()>data.exp)return null;return data}catch{return null}}
// Vale enquanto o pedido pode ser pago (48 h): quem leva mais de 30 min no pagamento (Pix pago
// depois, por exemplo) voltava para "Token de confirmação inválido ou expirado" com a compra paga.
function createOrderConfirmationToken(orderNsu){return createSignedToken({purpose:"order-confirmation",order_nsu:String(orderNsu)},PENDING_ORDER_EXPIRE_MS)}
function verifyOrderConfirmationToken(token,orderNsu){const data=verifySignedToken(token);return !!(data&&data.purpose==="order-confirmation"&&String(data.order_nsu)===String(orderNsu))}
const adminLoginAttempts = new Map();
function parseCookies(req){const h=req.headers.cookie||"";const o={};h.split(";").filter(Boolean).forEach(p=>{const i=p.indexOf("=");if(i<0)return;const v=p.slice(i+1).trim();try{o[p.slice(0,i).trim()]=decodeURIComponent(v)}catch{o[p.slice(0,i).trim()]=v}});return o}
function getAdminSession(req){const t=parseCookies(req)["monte_admin_session"];if(!t||!ADMIN_EMAIL||!ADMIN_PASSWORD_HASH)return null;const s=verifySignedToken(t);if(!s||s.purpose!=="admin"||s.email!==ADMIN_EMAIL)return null;return {token:t,email:s.email,expiresAt:s.exp,epoch:Number(s.ep)||0}}

// "Época" das sessões do painel: ao sair, ela muda e todas as sessões abertas (em qualquer
// navegador) deixam de valer. Fica no Supabase, com 60 s de cache em cada instância.
const ADMIN_EPOCH_KEY = "admin_session_epoch";
let adminEpochCache = { value: null, at: 0 };
async function adminSessionEpoch(force = false) {
    if (!force && adminEpochCache.value !== null && Date.now() - adminEpochCache.at < 60 * 1000) return adminEpochCache.value;
    const rows = await supabaseRequest("kv_store_48db9b7e?key=eq." + ADMIN_EPOCH_KEY + "&select=value&limit=1", { method: "GET" });
    const value = Number(rows?.[0]?.value?.epoch) || 0;
    adminEpochCache = { value, at: Date.now() };
    return value;
}
async function bumpAdminSessionEpoch() {
    const epoch = Date.now();
    await supabaseRequest("kv_store_48db9b7e?on_conflict=key", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: ADMIN_EPOCH_KEY, value: { epoch } })
    });
    adminEpochCache = { value: epoch, at: Date.now() };
}
// Sessão válida e da época atual (sessões antigas, de antes de sair, não valem).
async function currentAdminSession(req) {
    const session = getAdminSession(req);
    if (!session) return null;
    const epoch = await adminSessionEpoch();
    return session.epoch === epoch ? session : null;
}
// Pedido vindo de outro site: o navegador avisa em Sec-Fetch-Site; e o painel sempre manda JSON.
function crossSiteAdminRequest(req) {
    const origin = safeString(req.headers.origin);
    if (origin && !allowedOrigins.has(origin.replace(/\/$/, ""))) return true;
    if (safeString(req.headers["sec-fetch-site"]).toLowerCase() === "cross-site") return true;
    const changes = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    return changes && !/^application\/json\b/i.test(safeString(req.headers["content-type"]));
}
async function requireAdmin(req,res,next){
    try{
        if (crossSiteAdminRequest(req)) {
            return res.status(403).json({success:false,message:"Origem não autorizada."});
        }
        const s=await currentAdminSession(req);
        if(!s)return res.status(401).json({success:false,message:"Acesso administrativo não autorizado."});
        req.adminSession=s;
        next();
    }catch(error){
        console.error("Sessão do painel:", error.message);
        return res.status(503).json({success:false,message:"Não foi possível conferir o acesso agora. Tente de novo."});
    }
}
function normalizeCity(value) {
    return safeString(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isValidCpf(value){
    const cpf=String(value||"").replace(/\D/g,"");
    if(cpf.length!==11||/^([0-9])\1{10}$/.test(cpf)) return false;
    let sum=0;
    for(let i=0;i<9;i++) sum+=Number(cpf[i])*(10-i);
    let digit=(sum*10)%11; if(digit===10) digit=0;
    if(digit!==Number(cpf[9])) return false;
    sum=0;
    for(let i=0;i<10;i++) sum+=Number(cpf[i])*(11-i);
    digit=(sum*10)%11; if(digit===10) digit=0;
    return digit===Number(cpf[10]);
}
// Celular com DDD e 9 dígitos (aceita o +55 na frente). Devolve só os 11 dígitos, ou "" se não for celular.
// A InfinitePay não abre o pagamento com telefone incompleto: nenhum pedido com 9 ou 10 dígitos foi pago.
function brazilMobileDigits(value){
    let digits=String(value??"").replace(/\D/g,"");
    if(digits.length>11&&digits.startsWith("55")) digits=digits.slice(2);
    return /^[1-9]{2}9\d{8}$/.test(digits)?digits:"";
}
function passwordMatches(password){try{const [salt,storedHex]=ADMIN_PASSWORD_HASH.split(":");if(!salt||!storedHex)return false;const stored=Buffer.from(storedHex,"hex");const derived=crypto.scryptSync(String(password||""),salt,stored.length);return crypto.timingSafeEqual(stored,derived)}catch{return false}}
function loginKey(req,email){return `${clientIp(req)}:${safeString(email).toLowerCase()}`}
// Bloqueio após 5 senhas erradas seguidas (mesmo IP e e-mail) por 15 minutos. Fica no
// Supabase: no Workers cada requisição pode cair em outra instância e a memória se perde.
// A chave guarda só um hash do IP e do e-mail. Se o Supabase falhar, vale a memória.
const ADMIN_LOGIN_MAX_FAILURES=5;
const ADMIN_LOGIN_LOCK_MS=15*60*1000;
function loginKvKey(req,email){return "admin_login:"+crypto.createHash("sha256").update(loginKey(req,email)).digest("hex").slice(0,40)}
async function readLoginRecord(req,email){
    const memory=adminLoginAttempts.get(loginKey(req,email))||null;
    try{
        const rows=await supabaseRequest("kv_store_48db9b7e?key=eq."+loginKvKey(req,email)+"&select=value&limit=1",{method:"GET"});
        const saved=rows?.[0]?.value||null;
        if(!saved)return memory;
        if(!memory)return saved;
        return Number(saved.lockedUntil||0)>=Number(memory.lockedUntil||0)?saved:memory;
    }catch(error){console.warn("Login admin — tentativas no Supabase indisponíveis:",error.message);return memory}
}
async function loginAllowed(req,email){const r=await readLoginRecord(req,email);return !(r&&r.lockedUntil&&Date.now()<Number(r.lockedUntil))}
async function failedLogin(req,email){
    const k=loginKey(req,email);
    const prev=await readLoginRecord(req,email);
    // Falhas antigas (fora da janela de 15 minutos) não contam mais.
    const fresh=prev&&Date.now()-Number(prev.lastAt||0)<ADMIN_LOGIN_LOCK_MS&&!(prev.lockedUntil&&Date.now()>=Number(prev.lockedUntil));
    const r={count:(fresh?Number(prev.count||0):0)+1,lockedUntil:0,lastAt:Date.now()};
    if(r.count>=ADMIN_LOGIN_MAX_FAILURES){r.count=0;r.lockedUntil=Date.now()+ADMIN_LOGIN_LOCK_MS;console.warn("Login admin bloqueado por 15 minutos após "+ADMIN_LOGIN_MAX_FAILURES+" senhas erradas.")}
    adminLoginAttempts.set(k,r);
    await supabaseRequest("kv_store_48db9b7e?on_conflict=key",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({key:loginKvKey(req,email),value:r})}).catch(error=>console.warn("Login admin — tentativa não registrada:",error.message));
}
// Bloqueio da conta (de qualquer IP): ADMIN_ACCOUNT_MAX_FAILURES senhas erradas em 15 minutos
// travam o login por 15 minutos e mandam um alerta para os e-mails de aviso de venda.
const ADMIN_ACCOUNT_MAX_FAILURES=20;
const ADMIN_ACCOUNT_KEY="admin_login_account";
async function adminAccountLocked(){
    try{
        const rows=await supabaseRequest("kv_store_48db9b7e?key=eq."+ADMIN_ACCOUNT_KEY+"&select=value&limit=1",{method:"GET"});
        return Number(rows?.[0]?.value?.lockedUntil||0)>Date.now();
    }catch(error){console.warn("Login admin — bloqueio da conta indisponível:",error.message);return false}
}
async function recordAdminAccountFailure(){
    try{
        const rows=await supabaseRequest("kv_store_48db9b7e?key=eq."+ADMIN_ACCOUNT_KEY+"&select=value&limit=1",{method:"GET"});
        const prev=rows?.[0]?.value||{};
        const fresh=Date.now()-Number(prev.firstAt||0)<ADMIN_LOGIN_LOCK_MS;
        const next={count:(fresh?Number(prev.count||0):0)+1,firstAt:fresh?Number(prev.firstAt):Date.now(),lockedUntil:Number(prev.lockedUntil||0)};
        const lockNow=next.count>=ADMIN_ACCOUNT_MAX_FAILURES&&!(next.lockedUntil>Date.now());
        if(lockNow){next.lockedUntil=Date.now()+ADMIN_LOGIN_LOCK_MS;next.count=0;next.firstAt=Date.now();}
        await supabaseRequest("kv_store_48db9b7e?on_conflict=key",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({key:ADMIN_ACCOUNT_KEY,value:next})});
        if(lockNow){
            console.warn("Login admin: conta bloqueada por 15 minutos após "+ADMIN_ACCOUNT_MAX_FAILURES+" senhas erradas.");
            sendAdminSecurityAlert("Muitas tentativas de login no painel","O painel da MONTÊ recebeu "+ADMIN_ACCOUNT_MAX_FAILURES+" senhas erradas em menos de 15 minutos e o login foi bloqueado por 15 minutos. Se não foi você, troque a senha do painel.").catch(()=>{});
        }
    }catch(error){console.warn("Login admin — falha da conta não registrada:",error.message)}
}
async function sendAdminSecurityAlert(subject,message){
    const recipients=safeString(process.env.ORDER_NOTIFICATION_EMAILS).split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
    if(!RESEND_API_KEY||!RESEND_FROM_EMAIL||!recipients.length)return;
    await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:RESEND_FROM_NAME+" <"+RESEND_FROM_EMAIL+">",to:recipients,subject:"MONTÊ — Alerta de segurança: "+subject,text:message})});
}
async function clearLoginFailures(req,email){
    adminLoginAttempts.delete(loginKey(req,email));
    await supabaseRequest("kv_store_48db9b7e?key=eq."+loginKvKey(req,email),{method:"DELETE",headers:{"Prefer":"return=minimal"}}).catch(()=>{});
}
function setAdminCookie(res,t){res.setHeader("Set-Cookie",`monte_admin_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL/1000)}`)}
function clearAdminCookie(res){res.setHeader("Set-Cookie","monte_admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")}
app.post("/api/admin/login",adminLoginRateLimit,async(req,res)=>{
    try{
        const email=safeString(req.body?.email).toLowerCase(),password=req.body?.password;
        if(!ADMIN_EMAIL||!ADMIN_PASSWORD_HASH)return res.status(503).json({success:false,message:"Acesso administrativo não configurado no servidor."});
        if(!(await loginAllowed(req,email)))return res.status(429).json({success:false,message:"Muitas tentativas. Tente novamente em 15 minutos."});
        if(await adminAccountLocked())return res.status(429).json({success:false,message:"Muitas tentativas. Tente novamente em 15 minutos."});
        // A senha é sempre conferida (mesmo com e-mail errado): o tempo de resposta não revela o e-mail.
        const passwordOk=passwordMatches(password);
        const emailOk=crypto.timingSafeEqual(crypto.createHash("sha256").update(email).digest(),crypto.createHash("sha256").update(ADMIN_EMAIL.toLowerCase()).digest());
        if(!emailOk||!passwordOk){
            if(emailOk){await failedLogin(req,email);await recordAdminAccountFailure();}
            return res.status(401).json({success:false,message:"E-mail ou senha incorretos."});
        }
        await clearLoginFailures(req,email);
        const token=createSignedToken({purpose:"admin",email:ADMIN_EMAIL,ep:await adminSessionEpoch(true)},ADMIN_SESSION_TTL);
        setAdminCookie(res,token);
        return res.json({success:true,email:ADMIN_EMAIL});
    }catch(error){console.error("Login admin:",error);return res.status(500).json({success:false,message:"Não foi possível entrar agora."})}
});
app.post("/api/admin/logout",async(req,res)=>{
    if(crossSiteAdminRequest(req))return res.status(403).json({success:false,message:"Origem não autorizada."});
    // Sair encerra a sessão em todos os navegadores (quem estiver com o cookie também sai).
    if(getAdminSession(req))await bumpAdminSessionEpoch().catch(error=>console.error("Sair do painel:",error.message));
    clearAdminCookie(res);
    return res.json({success:true});
});
app.get("/api/admin/session",async(req,res)=>{try{const s=await currentAdminSession(req);if(!s)return res.status(401).json({success:false});return res.json({success:true,email:s.email})}catch{return res.status(503).json({success:false})}});
const CAROUSEL_KV_KEY = "site_carousel_images";

// Configuração do carrossel: { images: [url...], sizes: { url: [largura, altura] } }.
// As medidas vêm do painel (fotos otimizadas) ou são lidas no cabeçalho do arquivo
// (primeiros 64 KB) e guardadas; com elas a página reserva o espaço do banner.
const DEFAULT_CAROUSEL_IMAGES = ["/backend/assets/carousel-photo-1.webp", "/backend/assets/carousel-photo-2.webp"];
async function readCarouselConfig(){
  const rows=await supabaseRequest("kv_store_48db9b7e?key=eq."+encodeURIComponent(CAROUSEL_KV_KEY)+"&select=key,value",{method:"GET"});
  const value=Array.isArray(rows)?rows[0]?.value:null;
  const images=Array.isArray(value?.images)?value.images.filter(v=>typeof v==="string"&&v).slice(0,20):[];
  const sizes=value?.sizes&&typeof value.sizes==="object"?value.sizes:{};
  return {images:images.length?images:DEFAULT_CAROUSEL_IMAGES,sizes,stored:value||null};
}
function normalizeCarouselImages(images){
  return Array.isArray(images)?images.map(v=>safeString(v)).filter(Boolean).slice(0,20):[];
}
function normalizeCarouselSizes(sizes,images){
  const out={};
  if(!sizes||typeof sizes!=="object")return out;
  images.forEach(url=>{const s=sizes[url];if(Array.isArray(s)&&s.length===2&&s.every(n=>Number.isInteger(n)&&n>0&&n<20000))out[url]=[s[0],s[1]]});
  return out;
}
// Foto otimizada pelo painel: ".../opt/.../<id>-full.webp" tem a versão menor em "-small".
function smallImageUrl(url){return /\/opt\/[^?#]+-full\.(webp|jpg)$/.test(url)?url.replace(/-full\.(webp|jpg)$/,"-small.$1"):""}
async function imageSizeFromUrl(url){
  try{
    const absolute=url.startsWith("/")?null:url;
    if(!absolute)return null;
    if(!isAllowedProductImageUrl(absolute))return null;
    const response=await fetchWithTimeout(absolute,{headers:{Range:"bytes=0-65535"}},5000);
    if(!response.ok)return null;
    const info=readImageInfo(Buffer.from(await response.arrayBuffer()));
    return info.width&&info.height?[info.width,info.height]:null;
  }catch{return null}
}
const DEFAULT_CAROUSEL_SIZES={"/backend/assets/carousel-photo-1.webp":[640,360],"/backend/assets/carousel-photo-2.webp":[640,360]};
async function carouselSlides(){
  const config=await readCarouselConfig();
  const sizes={...DEFAULT_CAROUSEL_SIZES,...config.sizes};
  const missing=config.images.filter(url=>!sizes[url]).slice(0,4);
  if(missing.length){
    const found=await Promise.all(missing.map(imageSizeFromUrl));
    let changed=false;
    missing.forEach((url,i)=>{if(found[i]){sizes[url]=found[i];changed=true}});
    // Guarda as medidas lidas para não precisar ler de novo.
    if(changed&&config.stored){
      const value={...config.stored,sizes:normalizeCarouselSizes(sizes,config.images)};
      supabaseRequest("kv_store_48db9b7e",{method:"POST",body:JSON.stringify({key:CAROUSEL_KV_KEY,value}),headers:{"Prefer":"resolution=merge-duplicates,return=minimal"}}).catch(()=>{});
    }
  }
  return config.images.map(url=>{const src=siteMediaPath(url);return {src,small:smallImageUrl(src),width:sizes[url]?.[0]||null,height:sizes[url]?.[1]||null}});
}
app.get("/api/carousel",async(req,res)=>{
  try{const slides=await cachedPublic("carousel",60*1000,carouselSlides);return res.json({success:true,images:slides.map(s=>s.src),slides})}
  catch(e){console.error("Public carousel GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar o carrossel."})}
});
app.get("/api/admin/carousel",requireAdmin,async(req,res)=>{
  try{const config=await readCarouselConfig();return res.json({success:true,images:config.images,sizes:config.sizes})}
  catch(e){console.error("Admin carousel GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar o carrossel."})}
});
app.put("/api/admin/carousel",requireAdmin,async(req,res)=>{
  try{
    const images=normalizeCarouselImages(req.body?.images);
    if(!images.length)return res.status(400).json({success:false,message:"Adicione pelo menos uma foto ao carrossel."});
    const previous=await readCarouselConfig().catch(()=>({sizes:{}}));
    const sizes=normalizeCarouselSizes({...previous.sizes,...(req.body?.sizes||{})},images);
    const body=JSON.stringify({key:CAROUSEL_KV_KEY,value:{images,sizes,updated_at:new Date().toISOString()}});
    await supabaseRequest("kv_store_48db9b7e",{method:"POST",body,headers:{"Prefer":"resolution=merge-duplicates,return=representation"}});
    publicCache.delete("carousel");
    return res.json({success:true,images,sizes});
  }catch(e){console.error("Admin carousel PUT:",e);return res.status(500).json({success:false,message:adminErrorMessage(e,"Não foi possível salvar o carrossel.")})}
});

// Banner do meio da página inicial (fotos ao lado de "Mais que bolsas."), trocado pelo painel.
// Sem fotos salvas, a página mostra as da Bordeaux Collection que já estão no index.html.
// Fotos enviadas pelo painel são otimizadas no navegador: "-full" (2400 px) e "-small" (1200 px).
const EDITORIAL_KV_KEY = "site_editorial_images";
const DEFAULT_EDITORIAL_IMAGES = ["/assets/bordeaux-collection-2-2000.webp", "/assets/bordeaux-collection-1-2000.webp"];
function editorialImageUrl(value){
  const url=safeString(value);
  return DEFAULT_EDITORIAL_IMAGES.includes(url)?url:canonicalProductImageUrl(url);
}
async function readEditorialImages(){
  const rows=await supabaseRequest("kv_store_48db9b7e?key=eq."+encodeURIComponent(EDITORIAL_KV_KEY)+"&select=key,value",{method:"GET"});
  const value=Array.isArray(rows)?rows[0]?.value:null;
  return (Array.isArray(value?.images)?value.images:[]).map(editorialImageUrl).filter(Boolean).slice(0,10);
}
function editorialSlides(images){
  return images.map(url=>{
    const original=/^\/assets\/(bordeaux-collection-\d)-2000\.webp$/.exec(url);
    if(original){const base="/assets/"+original[1];return {src:base+"-1200.webp",srcset:base+"-800.webp 800w, "+base+"-1200.webp 1200w, "+base+"-2000.webp 2000w"}}
    const src=siteMediaPath(url),small=smallImageUrl(src);
    return {src,srcset:small?small+" 1200w, "+src+" 2400w":""};
  });
}
app.get("/api/editorial",async(req,res)=>{
  try{const images=await cachedPublic("editorial",60*1000,readEditorialImages);return res.json({success:true,slides:editorialSlides(images)})}
  catch(e){console.error("Public editorial GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar o banner."})}
});
app.get("/api/admin/editorial",requireAdmin,async(req,res)=>{
  try{const images=await readEditorialImages();return res.json({success:true,images:images.length?images:DEFAULT_EDITORIAL_IMAGES,custom:images.length>0})}
  catch(e){console.error("Admin editorial GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar o banner do meio."})}
});
app.put("/api/admin/editorial",requireAdmin,async(req,res)=>{
  try{
    const sent=Array.isArray(req.body?.images)?req.body.images.map(safeString).filter(Boolean):[];
    if(!sent.length)return res.status(400).json({success:false,message:"Adicione pelo menos uma foto ao banner do meio."});
    if(sent.length>10)return res.status(400).json({success:false,message:"Use no máximo 10 fotos no banner do meio."});
    const images=sent.map(editorialImageUrl);
    const invalid=sent.find((url,i)=>!images[i]);
    if(invalid)return res.status(400).json({success:false,message:"Foto inválida na lista ("+invalid.slice(0,160)+")."});
    const body=JSON.stringify({key:EDITORIAL_KV_KEY,value:{images,updated_at:new Date().toISOString()}});
    await supabaseRequest("kv_store_48db9b7e",{method:"POST",body,headers:{"Prefer":"resolution=merge-duplicates,return=minimal"}});
    publicCache.delete("editorial");
    return res.json({success:true,images,custom:true});
  }catch(e){console.error("Admin editorial PUT:",e);return res.status(500).json({success:false,message:adminErrorMessage(e,"Não foi possível salvar o banner do meio.")})}
});

app.get("/api/admin/products",requireAdmin,async(req,res)=>{try{const data=await supabaseRequest("products?select=*,product_variants(*)&order=created_at.desc");return res.json({success:true,products:data||[]})}catch(e){console.error("Admin products GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar os produtos."})}});

function analyticsClientInfo(req){
  const ua=String(req.headers["user-agent"]||"");
  return {
    device_type:/mobile|android|iphone|ipad|ipod/i.test(ua)?"mobile":"desktop",
    browser:/edg/i.test(ua)?"Edge":/chrome/i.test(ua)?"Chrome":/safari/i.test(ua)&&!/chrome/i.test(ua)?"Safari":/firefox/i.test(ua)?"Firefox":"Outro",
    os:/windows/i.test(ua)?"Windows":/mac os|macintosh/i.test(ua)?"macOS":/android/i.test(ua)?"Android":/iphone|ipad|ipod/i.test(ua)?"iOS":/linux/i.test(ua)?"Linux":"Outro"
  };
}
// O que o visitante manda para o analytics fica pequeno: objetos acima do limite viram {}.
function smallJson(value, maxChars) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    try { return JSON.stringify(value).length <= maxChars ? value : {}; } catch { return {}; }
}
// Itens da sacola guardados para o painel e para o lembrete: só os campos usados, com tamanho limitado.
function cartSnapshotItems(items) {
    const money = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    return (Array.isArray(items) ? items : []).slice(0, 30).filter(item => item && typeof item === "object").map(item => ({
        id: safeString(item.id || item.product_id).slice(0, 80),
        product_id: safeString(item.product_id || item.id).slice(0, 80),
        product_name: safeString(item.product_name || item.name).slice(0, 160),
        sku: safeString(item.sku).slice(0, 80) || null,
        variant_id: safeString(item.variant_id).slice(0, 80) || null,
        variant_color: safeString(item.variant_color || item.color).slice(0, 80) || null,
        quantity: Math.min(20, Math.max(1, Math.floor(Number(item.quantity) || 1))),
        unit_price: money(item.unit_price ?? item.price),
        total_price: money(item.total_price)
    }));
}

app.post("/api/analytics/event",analyticsRateLimit,async(req,res)=>{
  try{
    const b=req.body||{}, allowed=["page_view","view_product","add_to_cart","remove_from_cart","begin_checkout","checkout_started","checkout_completed","purchase","consent_granted"];
    const event_name=safeString(b.event_name);
    const visitor_id=safeString(b.visitor_id).slice(0,120), session_key=safeString(b.session_id).slice(0,120);
    if(!allowed.includes(event_name)||!visitor_id||!session_key) return res.status(400).json({success:false,message:"Evento inválido."});
    const now=new Date().toISOString(), info=analyticsClientInfo(req);
    let rows=await supabaseRequest("site_sessions?session_id=eq."+encodeURIComponent(session_key)+"&select=id",{method:"GET"});
    let session=Array.isArray(rows)?rows[0]:null;
    if(!session){
      const created=await supabaseRequest("site_sessions",{method:"POST",body:JSON.stringify({visitor_id,session_id:session_key,first_seen_at:now,last_seen_at:now,landing_path:safeString(b.path).slice(0,500),referrer:safeString(b.referrer).slice(0,500)||null,utm_source:safeString(b.utm_source).slice(0,100)||null,utm_medium:safeString(b.utm_medium).slice(0,100)||null,utm_campaign:safeString(b.utm_campaign).slice(0,150)||null,...info})});
      session=Array.isArray(created)?created[0]:created;
    }else{
      await supabaseRequest("site_sessions?id=eq."+encodeURIComponent(session.id),{method:"PATCH",body:JSON.stringify({last_seen_at:now,...info})});
    }
    await supabaseRequest("site_events",{method:"POST",body:JSON.stringify({
      session_id:session.id,visitor_id,event_name,path:safeString(b.path).slice(0,500),product_id:safeString(b.product_id).slice(0,80)||null,
      product_name:safeString(b.product_name).slice(0,160)||null,variant_id:safeString(b.variant_id).slice(0,80)||null,
      quantity:Number.isFinite(Number(b.quantity))?Math.max(1,Math.min(100,Number(b.quantity))):null,
      value:Number.isFinite(Number(b.value))?Number(b.value):null,metadata:smallJson(b.metadata,2000)
    })});
    res.status(201).json({success:true});
  }catch(e){console.error("Analytics:",e);res.status(400).json({success:false,message:"Não foi possível registrar o evento."})}
});
app.post("/api/analytics/cart",analyticsRateLimit,async(req,res)=>{
  try{
    const b=req.body||{}, visitor_id=safeString(b.visitor_id).slice(0,120), session_key=safeString(b.session_id).slice(0,120);
    if(!visitor_id||!session_key) return res.status(400).json({success:false,message:"Identificadores ausentes."});
    const ses=await supabaseRequest("site_sessions?session_id=eq."+encodeURIComponent(session_key)+"&select=id",{method:"GET"});
    const session_id=Array.isArray(ses)?ses[0]?.id:null;
    const subtotal=Math.max(0,Number(b.subtotal||0)),shipping=Math.max(0,Number(b.shipping||0)),total=Math.max(0,Number(b.total||subtotal+shipping));
    // Celular salvo sempre no mesmo formato, (85) 99999-9999: o aviso de WhatsApp da loja procura por ele.
    const typedPhone=safeString(b.customer_phone).slice(0,60), mobile=brazilMobileDigits(typedPhone);
    const customer_phone=mobile?"("+mobile.slice(0,2)+") "+mobile.slice(2,7)+"-"+mobile.slice(7):(typedPhone||null);
    const row={visitor_id,session_id,cart_key:session_key,customer_name:safeString(b.customer_name).slice(0,160)||null,customer_email:safeString(b.customer_email).trim().toLowerCase().slice(0,160)||null,customer_phone,items:cartSnapshotItems(b.items),subtotal,shipping,total,status:"active",last_activity_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    const updated=await supabaseRequest("cart_snapshots?cart_key=eq."+encodeURIComponent(session_key),{method:"PATCH",body:JSON.stringify(row)});
    if(!Array.isArray(updated)||!updated.length) await supabaseRequest("cart_snapshots",{method:"POST",body:JSON.stringify(row)});
    res.status(201).json({success:true});
  }catch(e){console.error("Analytics cart:",e);res.status(400).json({success:false,message:"Não foi possível salvar o carrinho."})}
});
app.get("/api/admin/analytics",requireAdmin,async(req,res)=>{
  try{
    const days=Math.min(90,Math.max(1,Number(req.query.days||30))),since=new Date(Date.now()-days*86400000).toISOString();
    const [events,sessions,carts,orders,items]=await Promise.all([
      supabaseRequest("site_events?created_at=gte."+encodeURIComponent(since)+"&select=*&order=created_at.desc&limit=10000",{method:"GET"}),
      supabaseRequest("site_sessions?last_seen_at=gte."+encodeURIComponent(since)+"&select=*&order=last_seen_at.desc&limit=5000",{method:"GET"}),
      supabaseRequest("cart_snapshots?last_activity_at=gte."+encodeURIComponent(since)+"&select=*&order=last_activity_at.desc&limit=5000",{method:"GET"}),
      supabaseRequest("orders?created_at=gte."+encodeURIComponent(since)+"&select=id,order_nsu,order_code,customer_name,customer_email,subtotal,shipping,total,status,payment_method,created_at,paid_at,paid_amount&order=created_at.desc",{method:"GET"}),
      supabaseRequest("order_items?created_at=gte."+encodeURIComponent(since)+"&select=order_id,product_id,product_name,sku,quantity,total_price,created_at&order=created_at.desc&limit=10000",{method:"GET"})
    ]);
    const good=["paid","processing","shipped","delivered"],paid=orders.filter(o=>good.includes(o.status)),paidIds=new Set(paid.map(o=>String(o.id)));
    const revenue=paid.reduce((s,o)=>s+Number(o.total||0),0), visitors=new Set(sessions.map(s=>s.visitor_id)).size, pageViews=events.filter(e=>e.event_name==="page_view").length;
    const addToCart=events.filter(e=>e.event_name==="add_to_cart").length,checkoutStarted=events.filter(e=>["begin_checkout","checkout_started"].includes(e.event_name)).length;
    const active=carts.filter(c=>c.status==="active"), converted=carts.filter(c=>c.status==="converted");
    const productMap={}, unitsSold={}; items.filter(i=>paidIds.has(String(i.order_id))).forEach(i=>{const key=i.product_name||i.product_id||"—";productMap[key]=(productMap[key]||0)+Number(i.total_price||0);unitsSold[key]=(unitsSold[key]||0)+Number(i.quantity||0)});
    const methods={};paid.forEach(o=>{const key=o.payment_method||"não informado";methods[key]=(methods[key]||0)+Number(o.total||0)});
    const series=[];for(let i=days-1;i>=0;i--){const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10),dayEvents=events.filter(e=>String(e.created_at).slice(0,10)===d),daySessions=sessions.filter(s=>String(s.last_seen_at).slice(0,10)===d),dayOrders=paid.filter(o=>String(o.paid_at||o.created_at).slice(0,10)===d);series.push({date:d,visitors:new Set(daySessions.map(s=>s.visitor_id)).size,pageViews:dayEvents.filter(e=>e.event_name==="page_view").length,purchases:dayOrders.length,revenue:dayOrders.reduce((s,o)=>s+Number(o.total||0),0)});}
    res.json({success:true,summary:{visitors, pageViews, sessions:sessions.length, addToCart, checkoutStarted, orders:orders.length, paidOrders:paid.length, grossRevenue:revenue, ticketAverage:paid.length?revenue/paid.length:0, conversionRate:visitors?paid.length/visitors*100:0, activeCarts:active.length, abandonedValue:active.reduce((s,c)=>s+Number(c.total||0),0), abandonmentRate:(active.length+converted.length)?active.length/(active.length+converted.length)*100:0, convertedCarts:converted.length},series,topProducts:Object.keys(productMap).map(k=>({key:k,revenue:productMap[k],units:unitsSold[k]})).sort((a,b)=>b.revenue-a.revenue).slice(0,10),paymentMethods:methods,recentOrders:orders.slice(0,12),recentCarts:carts.slice(0,20),generatedAt:new Date().toISOString()});
  }catch(e){console.error("Admin analytics:",e);res.status(500).json({success:false,message:"Não foi possível carregar o Dashboard."})}
});

const PRODUCT_IMAGE_BUCKET = "product-images";

// Endereço público de uma foto do bucket, sempre no mesmo formato (https, sem "//").
function storagePublicUrl(objectPath) {
    return "https://" + new URL(SUPABASE_URL).host + "/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/" + objectPath;
}
// Foto do bucket da loja no formato padrão, ou "" se o endereço não for de lá.
function canonicalProductImageUrl(value) {
    try {
        const parsed = new URL(String(value || ""));
        const path = parsed.pathname.replace(/\/{2,}/g, "/");
        const prefix = "/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/";
        if (parsed.protocol !== "https:" || parsed.host !== new URL(SUPABASE_URL).host || !path.startsWith(prefix)) return "";
        return "https://" + parsed.host + path;
    } catch {
        return "";
    }
}
function isAllowedProductImageUrl(value) {
    return !!canonicalProductImageUrl(value);
}

/* =====================================================
   FOTOS PELO ENDEREÇO DA LOJA
   A loja mostra as fotos do bucket como /media/product-images/<arquivo>. No Workers
   a foto fica no cache da Cloudflare (o arquivo é o mesmo, byte a byte), então o
   Supabase só entrega cada foto quando ela ainda não está no cache — o tráfego de
   fotos (Cached Egress do plano Free) deixa de crescer a cada visita.
===================================================== */
const MEDIA_PREFIX = "/media/" + PRODUCT_IMAGE_BUCKET + "/";
const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
function isMediaObjectPath(objectPath) {
    return objectPath.length > 0 && objectPath.length <= 300 && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(objectPath) && !/(^|\/)\.{1,2}(\/|$)/.test(objectPath);
}
// Foto do bucket → endereço da loja (/media/...); qualquer outro endereço fica igual.
function siteMediaPath(value) {
    const canonical = canonicalProductImageUrl(value);
    if (!canonical) return value;
    const objectPath = new URL(canonical).pathname.slice(("/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/").length);
    return isMediaObjectPath(objectPath) ? MEDIA_PREFIX + objectPath : value;
}
// O Supabase responde 400 para arquivo que não existe.
function mediaNotFound(status) {
    return new Response(null, { status: status === 400 || status === 404 ? 404 : 502, headers: { "Cache-Control": "no-store" } });
}
// Chamado pelo Worker antes do Express: devolve a resposta da foto, ou null se o
// endereço não for de foto. A chave do cache ignora "?...": variar o endereço não
// força o Supabase a mandar a foto de novo.
async function serveMediaRequest(request, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(MEDIA_PREFIX)) return null;
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
    }
    const objectPath = url.pathname.slice(MEDIA_PREFIX.length);
    if (!isMediaObjectPath(objectPath)) return mediaNotFound(404);
    const cache = caches.default;
    const key = new Request(url.origin + url.pathname);
    let response = await cache.match(key);
    if (!response) {
        let upstream;
        try {
            upstream = await fetch(storagePublicUrl(objectPath));
        } catch (error) {
            console.error("Foto do bucket:", error.message);
            return mediaNotFound(502);
        }
        const type = String(upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!upstream.ok || !MEDIA_TYPES.has(type)) {
            if (upstream.body) upstream.body.cancel().catch(() => {});
            return mediaNotFound(upstream.status);
        }
        const headers = new Headers({
            "Content-Type": type,
            // O nome do arquivo muda a cada envio: a mesma foto pode ficar um ano em cache.
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy": "same-site"
        });
        const etag = upstream.headers.get("etag");
        if (etag) headers.set("ETag", etag);
        response = new Response(upstream.body, { status: 200, headers });
        ctx.waitUntil(cache.put(key, response.clone()).catch(error => console.error("Cache da foto:", error.message)));
    }
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
// Fora do Workers (servidor Node) não há cache da Cloudflare: a foto sai direto do bucket.
app.use(MEDIA_PREFIX, (req, res) => {
    const objectPath = req.path.replace(/^\/+/, "");
    if (!isMediaObjectPath(objectPath)) return res.status(404).end();
    return res.redirect(302, storagePublicUrl(objectPath));
});

// Antes recortava as bordas da foto com o sharp, biblioteca nativa que não roda no
// Cloudflare. O site não usa mais este endereço; ele só leva à foto original.
app.get("/api/product-image-normalized", imageNormalizeRateLimit, (req, res) => {
    const sourceUrl = safeString(req.query?.url);
    if (!isAllowedProductImageUrl(sourceUrl)) {
        return res.status(400).json({ success: false, message: "Imagem inválida." });
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.redirect(sourceUrl);
});

// Lê o formato e as dimensões no cabeçalho do arquivo (JPEG, PNG ou WebP), sem bibliotecas nativas.
function readImageInfo(b) {
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") {
        return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
        const chunk = b.toString("ascii", 12, 16);
        if (chunk === "VP8X") return { format: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
        if (chunk === "VP8L") { const bits = b.readUInt32LE(21); return { format: "webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }; }
        if (chunk === "VP8 ") return { format: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
        return { format: "webp" };
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
        let o = 2;
        while (o + 8 < b.length) {
            if (b[o] !== 0xff) return { format: "jpeg" };
            const marker = b[o + 1];
            if (marker === 0xff) { o += 1; continue; }
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { o += 2; continue; }
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { format: "jpeg", width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5) };
            }
            o += 2 + b.readUInt16BE(o + 2);
        }
        return { format: "jpeg" };
    }
    return { format: null };
}

// Motivo da recusa do Supabase Storage em português (antes o painel só mostrava o código).
async function storageUploadError(response, prefix) {
    let detail = "";
    try { const data = await response.json(); detail = safeString(data?.message || data?.error); } catch {}
    if (response.status === 413 || /maximum allowed size|too large|payload/i.test(detail)) {
        return "A foto passa do tamanho máximo aceito pelo armazenamento. Envie um arquivo menor.";
    }
    if (/mime type|not supported/i.test(detail)) return "Formato de foto não aceito pelo armazenamento. Use JPG, PNG ou WebP.";
    return prefix + " (" + response.status + (detail ? ": " + detail.slice(0, 120) : "") + ").";
}

async function validateImageBuffer(buffer, declaredContentType) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error("Arquivo de imagem vazio.");
    }
    if (buffer.length > 20 * 1024 * 1024) {
        throw new Error("Cada imagem pode ter no máximo 20 MB.");
    }
    const metadata = readImageInfo(buffer);
    const detected = metadata?.format === "jpeg" ? "image/jpeg"
        : metadata?.format === "png" ? "image/png"
        : metadata?.format === "webp" ? "image/webp"
        : null;
    if (!detected || detected !== declaredContentType) {
        throw new Error("O conteúdo da imagem não corresponde ao formato informado.");
    }
    if (!Number.isFinite(metadata.width) || !Number.isFinite(metadata.height) ||
        metadata.width < 1 || metadata.height < 1 ||
        metadata.width > 20000 || metadata.height > 20000) {
        throw new Error("Dimensões de imagem inválidas.");
    }
    return metadata;
}

async function uploadProductImage({ productId, fileName, contentType, dataBase64 }) {
    if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(contentType)) throw new Error("Formato de imagem não permitido. Use JPG, PNG ou WebP.");
    const raw = String(dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    await validateImageBuffer(buffer, contentType);
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const safeName = safeString(fileName).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "imagem." + ext;
    const objectPath = productId + "/" + Date.now() + "-" + crypto.randomBytes(5).toString("hex") + "-" + safeName;
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + PRODUCT_IMAGE_BUCKET + "/" + encodeURIComponent(objectPath).replace(/%2F/g, "/"), {
        method: "POST",
        headers: { "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "apikey": SUPABASE_SERVICE_ROLE_KEY, "Content-Type": contentType, "x-upsert": "false", "cache-control": "max-age=31536000" },
        body: buffer
    });
    if (!response.ok) throw new Error(await storageUploadError(response, "Upload da imagem falhou"));
    return storagePublicUrl(objectPath);
}

async function uploadCarouselImage({fileName,contentType,dataBase64}) {
    if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(contentType)) throw new Error("Formato de imagem não permitido. Use JPG, PNG ou WebP.");
    const raw = String(dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    await validateImageBuffer(buffer, contentType);
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const safeName = safeString(fileName).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "carousel."+ext;
    const objectPath = "carousel/" + Date.now() + "-" + crypto.randomBytes(5).toString("hex") + "-" + safeName;
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + PRODUCT_IMAGE_BUCKET + "/" + encodeURIComponent(objectPath).replace(/%2F/g, "/"), {
        method: "POST",
        headers: { "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "apikey": SUPABASE_SERVICE_ROLE_KEY, "Content-Type": contentType, "x-upsert": "false", "cache-control": "max-age=31536000" },
        body: buffer
    });
    if (!response.ok) throw new Error(await storageUploadError(response, "Upload da imagem do carrossel falhou"));
    return storagePublicUrl(objectPath);
}
// Envio direto do painel para o Supabase: o servidor só cria os endereços de envio
// (válidos por 2 horas, um arquivo cada) e o navegador manda as fotos para lá. Assim as
// fotos não passam pelo Cloudflare, que no plano grátis tem só 10 ms de CPU por pedido.
async function signedStorageUpload(objectPath) {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/upload/sign/" + PRODUCT_IMAGE_BUCKET + "/" + encodeURIComponent(objectPath).replace(/%2F/g, "/"), {
        method: "POST",
        headers: { "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "apikey": SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
        body: "{}"
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.url || !String(data.url).includes("token=")) throw new Error("Não foi possível preparar o envio da foto (" + response.status + ").");
    return { upload_url: "https://" + new URL(SUPABASE_URL).host + "/storage/v1" + data.url, url: storagePublicUrl(objectPath) };
}
// Pasta das fotos otimizadas: a do produto, ou "banner" para as fotos do banner do meio.
function optimizedPhotoFolder(body) {
    if (safeString(body?.kind) === "banner") return "banner";
    const productId = safeString(body?.product_id);
    if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new Error("Produto inválido.");
    return productId;
}
app.post("/api/admin/uploads/optimized-image/sign", requireAdmin, async (req, res) => {
    try {
        if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
        const folder = optimizedPhotoFolder(req.body);
        const contentType = safeString(req.body?.content_type).toLowerCase();
        if (!["image/webp", "image/jpeg"].includes(contentType)) throw new Error("Formato inválido para a foto otimizada.");
        const ext = contentType === "image/webp" ? "webp" : "jpg";
        const base = "opt/" + folder + "/" + Date.now() + "-" + crypto.randomBytes(5).toString("hex");
        const [full, small] = await Promise.all([signedStorageUpload(base + "-full." + ext), signedStorageUpload(base + "-small." + ext)]);
        return res.json({ success: true, full, small });
    } catch (e) {
        console.error("Admin optimized image sign:", e);
        return res.status(400).json({ success: false, message: adminErrorMessage(e, "Não foi possível preparar o envio da foto.") });
    }
});

// Foto de PRODUTO otimizada no navegador do painel: chega a versão grande e a pequena
// (WebP, ou JPEG em navegadores sem WebP) e as duas vão para "opt/..." com o mesmo nome.
// A loja usa a pequena nos cards e a grande na galeria. As fotos do banner não passam
// por aqui: ficam como foram enviadas.
async function uploadStorageObject(objectPath, contentType, buffer) {
    const response = await fetch(SUPABASE_URL + "/storage/v1/object/" + PRODUCT_IMAGE_BUCKET + "/" + encodeURIComponent(objectPath).replace(/%2F/g, "/"), {
        method: "POST",
        headers: { "Authorization": "Bearer " + SUPABASE_SERVICE_ROLE_KEY, "apikey": SUPABASE_SERVICE_ROLE_KEY, "Content-Type": contentType, "x-upsert": "false", "cache-control": "max-age=31536000" },
        body: buffer
    });
    if (!response.ok) throw new Error(await storageUploadError(response, "Upload da imagem falhou"));
    return storagePublicUrl(objectPath);
}
app.post("/api/admin/uploads/optimized-image", requireAdmin, async (req, res) => {
    try {
        if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
        const folder = optimizedPhotoFolder(req.body);
        const contentType = safeString(req.body?.content_type).toLowerCase();
        if (!["image/webp", "image/jpeg"].includes(contentType)) throw new Error("Formato inválido para a foto otimizada.");
        const decode = value => Buffer.from(String(value || "").replace(/^data:[^;]+;base64,/, ""), "base64");
        const full = decode(req.body?.full_base64), small = decode(req.body?.small_base64);
        const fullInfo = await validateImageBuffer(full, contentType);
        await validateImageBuffer(small, contentType);
        if (full.length > 6 * 1024 * 1024 || small.length > 2 * 1024 * 1024) throw new Error("A foto otimizada ficou grande demais.");
        const ext = contentType === "image/webp" ? "webp" : "jpg";
        const name = Date.now() + "-" + crypto.randomBytes(5).toString("hex");
        const prefix = "opt/" + folder + "/";
        const [url, smallUrl] = await Promise.all([
            uploadStorageObject(prefix + name + "-full." + ext, contentType, full),
            uploadStorageObject(prefix + name + "-small." + ext, contentType, small)
        ]);
        return res.status(201).json({ success: true, url, small: smallUrl, width: fullInfo.width, height: fullInfo.height });
    } catch (e) {
        console.error("Admin optimized image upload:", e);
        return res.status(400).json({ success: false, message: adminErrorMessage(e, "Não foi possível enviar a foto.") });
    }
});

// Troca as fotos de um produto pelas versões otimizadas. A lista anterior fica guardada
// em images_original (só na primeira vez) para poder voltar atrás.
app.put("/api/admin/products/:id/images", requireAdmin, async (req, res) => {
    try {
        const id = safeString(req.params.id);
        if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, message: "Produto inválido." });
        const images = Array.isArray(req.body?.images) ? req.body.images.map(safeString).filter(Boolean).slice(0, 30).map(url => /^\/?assets\//.test(url) ? url : canonicalProductImageUrl(url) || url) : [];
        const invalid = images.find(url => !isAllowedProductImageUrl(url) && !/^\/?assets\//.test(url));
        if (invalid) {
            console.error("Admin product images PUT: foto fora do bucket:", invalid);
            return res.status(400).json({ success: false, message: "Foto inválida na lista (" + invalid.slice(0, 160) + ")." });
        }
        const rows = await supabaseRequest("products?id=eq." + encodeURIComponent(id) + "&select=images,images_original", { method: "GET" });
        const current = Array.isArray(rows) ? rows[0] : null;
        if (!current) return res.status(404).json({ success: false, message: "Produto não encontrado." });
        const patch = { images };
        if (!current.images_original) patch.images_original = current.images || [];
        await supabaseRequest("products?id=eq." + encodeURIComponent(id), { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify(patch) });
        publicCache.delete("catalog");
        return res.json({ success: true, images });
    } catch (e) {
        console.error("Admin product images PUT:", e);
        return res.status(500).json({ success: false, message: "Não foi possível salvar as fotos." });
    }
});

app.post("/api/admin/uploads/carousel-image", requireAdmin, async (req,res)=>{
  try{
    const url=await uploadCarouselImage({
      fileName:safeString(req.body?.file_name),
      contentType:safeString(req.body?.content_type).toLowerCase(),
      dataBase64:safeString(req.body?.data_base64)
    });
    return res.status(201).json({success:true,url});
  }catch(e){
    console.error("Admin carousel image upload:",e);
    return res.status(400).json({success:false,message:adminErrorMessage(e,"Não foi possível enviar a imagem.")});
  }
});

app.post("/api/admin/uploads/product-image", requireAdmin, async (req, res) => {
    try {
        const productId = safeString(req.body?.product_id);
        const fileName = safeString(req.body?.file_name);
        const contentType = safeString(req.body?.content_type).toLowerCase();
        const dataBase64 = safeString(req.body?.data_base64);
        if (!/^[0-9a-f-]{36}$/i.test(productId)) return res.status(400).json({ success: false, message: "Produto inválido." });
        const url = await uploadProductImage({ productId, fileName, contentType, dataBase64 });
        return res.status(201).json({ success: true, url });
    } catch (error) {
        console.error("Admin image upload:", error);
        return res.status(400).json({ success: false, message: adminErrorMessage(error, "Não foi possível enviar a imagem.") });
    }
});

// Erro mostrado no painel: mensagens de validação escritas por nós passam; respostas internas
// (Supabase, Olist, chaves de configuração) ficam só no log do servidor.
function adminErrorMessage(error, fallback) {
    const message = safeString(error?.message);
    if (!message || /supabase|olist api|service_role|_key\b|token|\{|\bat\s|stack|ECONN|fetch failed/i.test(message)) return fallback;
    return message.slice(0, 300);
}
function productSaveError(error) {
    if (/duplicate key|23505|products_sku_key/i.test(safeString(error?.message))) return "Já existe outro produto com este SKU.";
    return adminErrorMessage(error, "Não foi possível salvar o produto.");
}

function sanitizeProductPayload(b={}){return{name:safeString(b.name),sku:safeString(b.sku)||null,category:safeString(b.category)||"bolsas",price:Number(b.price||0),sale_price:b.sale_price===null||b.sale_price===""||b.sale_price===undefined?null:Number(b.sale_price),description:safeString(b.description),images:Array.isArray(b.images)?b.images:[],shipping_weight_kg:b.shipping_weight_kg===null||b.shipping_weight_kg===""||b.shipping_weight_kg===undefined?null:Number(b.shipping_weight_kg),shipping_height_cm:b.shipping_height_cm===null||b.shipping_height_cm===""||b.shipping_height_cm===undefined?null:Number(b.shipping_height_cm),shipping_width_cm:b.shipping_width_cm===null||b.shipping_width_cm===""||b.shipping_width_cm===undefined?null:Number(b.shipping_width_cm),shipping_length_cm:b.shipping_length_cm===null||b.shipping_length_cm===""||b.shipping_length_cm===undefined?null:Number(b.shipping_length_cm),is_new:Boolean(b.is_new),is_sale:Boolean(b.is_sale),is_presale:Boolean(b.is_presale),active:b.active!==false}}
app.post("/api/admin/products",requireAdmin,async(req,res)=>{try{publicCache.delete("catalog");const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest("products",{method:"POST",body:JSON.stringify(p)});return res.status(201).json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products POST:",e);return res.status(500).json({success:false,message:productSaveError(e)})}});
app.put("/api/admin/products/:id",requireAdmin,async(req,res)=>{try{publicCache.delete("catalog");const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest(`products?id=eq.${encodeURIComponent(req.params.id)}`,{method:"PATCH",body:JSON.stringify(p)});return res.json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products PUT:",e);return res.status(500).json({success:false,message:productSaveError(e)})}});
app.delete("/api/admin/products/:id",requireAdmin,async(req,res)=>{
    try{
        const productId=safeString(req.params.id);
        if(!/^[0-9a-f-]{36}$/i.test(productId)) return res.status(400).json({success:false,message:"Produto inválido."});

        const orders=await supabaseRequest(
            "order_items?product_id=eq."+encodeURIComponent(productId)+"&select=id&limit=1"
        );
        if(Array.isArray(orders)&&orders.length){
            return res.status(409).json({
                success:false,
                message:"Este produto já está vinculado a um pedido. Para preservar o histórico da venda, use DESATIVAR em vez de excluir."
            });
        }

        await supabaseRequest(
            "product_variants?product_id=eq."+encodeURIComponent(productId),
            {method:"DELETE",headers:{"Prefer":"return=minimal"}}
        );
        const deleted=await supabaseRequest(
            "products?id=eq."+encodeURIComponent(productId),
            {method:"DELETE",headers:{"Prefer":"return=representation"}}
        );
        if(!Array.isArray(deleted)||!deleted[0]){
            return res.status(404).json({success:false,message:"Produto não encontrado."});
        }
        return res.json({success:true});
    }catch(e){
        console.error("Admin product DELETE:",e);
        return res.status(500).json({success:false,message:"Não foi possível excluir o produto."});
    }
});

/* =====================================================
   LIMPEZA DOS PRODUTOS SINCRONIZADOS DA OLIST
   A antiga sincronização de catálogo marcava os produtos com
   olist_product_id. Só produtos com essa marca são removidos.
   Produtos com pedidos são apenas desativados, para preservar o
   histórico das vendas.
===================================================== */
function chunkList(list, size) {
    const chunks = [];
    for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
    return chunks;
}

async function deleteOlistProductsByIds(ids) {
    const filter = "in.(" + ids.map(encodeURIComponent).join(",") + ")";
    await supabaseRequest("product_variants?product_id=" + filter, {
        method: "DELETE",
        headers: { "Prefer": "return=minimal" }
    });
    const deleted = await supabaseRequest("products?id=" + filter + "&olist_product_id=not.is.null", {
        method: "DELETE",
        headers: { "Prefer": "return=representation" }
    });
    return Array.isArray(deleted) ? deleted.length : 0;
}

async function deactivateProductsByIds(ids) {
    const filter = "in.(" + ids.map(encodeURIComponent).join(",") + ")";
    const updated = await supabaseRequest("products?id=" + filter + "&olist_product_id=not.is.null", {
        method: "PATCH",
        body: JSON.stringify({ active: false })
    });
    return Array.isArray(updated) ? updated.length : 0;
}

app.post("/api/admin/olist/products/delete", requireAdmin, async (req, res) => {
    try {
        const requested = Array.isArray(req.body?.product_ids) ? req.body.product_ids.map(safeString) : [];
        const ids = [...new Set(requested)].filter(id => /^[0-9a-f-]{36}$/i.test(id));
        if (!ids.length) {
            return res.status(400).json({ success: false, message: "Nenhum produto da Olist informado." });
        }
        if (ids.length > 2000) {
            return res.status(400).json({ success: false, message: "Quantidade de produtos excede o limite." });
        }

        // Confere no banco quais IDs realmente vieram da Olist.
        const olistIds = [];
        for (const chunk of chunkList(ids, 50)) {
            const rows = await supabaseRequest(
                "products?id=in.(" + chunk.map(encodeURIComponent).join(",") + ")&olist_product_id=not.is.null&select=id",
                { method: "GET" }
            );
            if (Array.isArray(rows)) olistIds.push(...rows.map(row => String(row.id)));
        }

        const withOrders = new Set();
        for (const chunk of chunkList(olistIds, 50)) {
            const rows = await supabaseRequest(
                "order_items?product_id=in.(" + chunk.map(encodeURIComponent).join(",") + ")&select=product_id",
                { method: "GET" }
            );
            if (Array.isArray(rows)) rows.forEach(row => withOrders.add(String(row.product_id)));
        }

        const toDeactivate = olistIds.filter(id => withOrders.has(id));
        const toDelete = olistIds.filter(id => !withOrders.has(id));
        let deleted = 0;
        let deactivated = 0;
        const failed = [];

        for (const chunk of chunkList(toDeactivate, 50)) {
            deactivated += await deactivateProductsByIds(chunk);
        }

        for (const chunk of chunkList(toDelete, 50)) {
            try {
                deleted += await deleteOlistProductsByIds(chunk);
            } catch (chunkError) {
                console.error("Olist cleanup — lote falhou, tentando um a um:", chunkError.message);
                for (const id of chunk) {
                    try {
                        deleted += await deleteOlistProductsByIds([id]);
                    } catch (error) {
                        // Se não puder excluir, ao menos tira o produto da loja.
                        console.error("Olist cleanup — não excluído:", id, error.message);
                        await deactivateProductsByIds([id]).catch(() => {});
                        failed.push(id);
                    }
                }
            }
        }

        console.log("🧹 Olist cleanup:", { requested: ids.length, olist: olistIds.length, deleted, deactivated, failed: failed.length });

        return res.json({
            success: true,
            requested: ids.length,
            ignored_not_olist: ids.length - olistIds.length,
            deleted,
            deactivated_with_orders: deactivated,
            failed
        });
    } catch (error) {
        console.error("Olist cleanup:", error);
        return res.status(500).json({ success: false, message: "Não foi possível excluir os produtos da Olist." });
    }
});
/* =====================================================
   SKUs — COMPARAÇÃO SITE × OLIST
   A Olist é só consultada (nenhuma escrita lá). Cada produto do
   site é casado com um produto da Olist (mesmo nome, nome parecido
   ou mesmo SKU) e cada variação com uma variação dele (mesmo SKU,
   mesma cor ou cor equivalente). Quando o SKU diverge, a correção é
   feita apenas no site e apenas em produtos que já existem. Pares
   incertos ficam como sugestão e itens sem par podem ser escolhidos
   à mão no painel.
===================================================== */
const OLIST_SKU_COMPARE_TTL = 30 * 60 * 1000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function skuKey(value) {
    return safeString(value).toUpperCase();
}

// Os mesmos nomes são normalizados milhares de vezes por comparação: guarda o resultado
// (o plano gratuito do Cloudflare dá poucos milissegundos de CPU por requisição).
const nameKeyCache = new Map();
function nameKey(value) {
    const raw = safeString(value);
    let key = nameKeyCache.get(raw);
    if (key === undefined) {
        key = raw
            .normalize("NFD").replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
        if (nameKeyCache.size > 5000) nameKeyCache.clear();
        nameKeyCache.set(raw, key);
    }
    return key;
}

// "preta" e "preto", "marrom" e "marrons": compara sem a última vogal.
function stemKey(value) {
    return nameKey(value).split(" ").map(word => word.length > 3 ? word.replace(/[aeos]$/, "") : word).join(" ");
}

// Nome sem espaços e sem "Bag"/"Bolsa": "Bolsa Porto Fino" → "portofino".
const GENERIC_NAME_WORDS = new Set(["bag", "bags", "bolsa", "bolsas"]);
const coreKeyCache = new Map();
function coreKey(value) {
    const name = nameKey(value);
    let key = coreKeyCache.get(name);
    if (key === undefined) {
        key = name.split(" ").filter(word => word && !GENERIC_NAME_WORDS.has(word)).join("");
        if (coreKeyCache.size > 5000) coreKeyCache.clear();
        coreKeyCache.set(name, key);
    }
    return key;
}

// Tira o nome do produto e a palavra "cor" do começo: "Bag Cannes - café" → "cafe".
function colorKey(color, productName) {
    let key = nameKey(color);
    const base = nameKey(productName);
    if (base && (key === base || key.startsWith(base + " "))) key = key.slice(base.length).trim();
    return key.replace(/^cor\s+/, "").trim();
}

// Cores que aparecem com nomes diferentes no site e na Olist.
const COLOR_GROUPS = [
    ["bordo", "vinho", "burgundy", "marsala", "bordeaux"],
    ["off", "off white", "offwhite", "gelo"],
    ["preta", "preto", "black", "negra"],
    ["caramelo", "camel", "conhaque"],
    ["ouro", "dourado", "dourada", "gold"],
    ["prata", "prateado", "prateada", "silver"]
].map(group => group.map(stemKey));
function colorGroup(key) {
    const stem = stemKey(key);
    return COLOR_GROUPS.findIndex(group => group.includes(stem));
}

// Semelhança entre dois textos (0 a 1), por pares de letras.
function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const grams = text => {
        const map = new Map();
        for (let i = 0; i < text.length - 1; i++) map.set(text.slice(i, i + 2), (map.get(text.slice(i, i + 2)) || 0) + 1);
        return map;
    };
    const ga = grams(a), gb = grams(b);
    let both = 0;
    ga.forEach((count, gram) => { both += Math.min(count, gb.get(gram) || 0); });
    return (2 * both) / Math.max(1, a.length + b.length - 2);
}

function nameScore(a, b) {
    const ca = coreKey(a), cb = coreKey(b);
    let score = similarity(ca, cb);
    if (ca.length >= 4 && cb.length >= 4 && (ca.startsWith(cb) || cb.startsWith(ca))) score = Math.max(score, 0.8);
    return score;
}

async function listOlistProductsForSku(read) {
    const all = [];
    for (let offset = 0; offset < 5000; offset += 100) {
        const data = await read("/produtos?limit=100&offset=" + offset);
        const items = olistItemsFromResponse(data);
        all.push(...items);
        const total = Number(data?.paginacao?.total || 0);
        if (items.length < 100 || (total && all.length >= total)) break;
    }
    return all.filter(item => item && item.id && safeString(item.situacao).toUpperCase() !== "E");
}

function variationColor(variation, parentName) {
    const grade = Array.isArray(variation?.grade) ? variation.grade : [];
    const color = grade.find(g => /cor/i.test(safeString(g?.chave))) || (grade.length === 1 ? grade[0] : null);
    if (color?.valor) return colorKey(color.valor, parentName);
    return colorKey(variation?.descricao, parentName);
}

function pickByColor(options, siteColor) {
    const exact = options.filter(o => o.color === siteColor);
    if (exact.length === 1) return { match: exact[0] };
    if (exact.length > 1) return { ambiguous: true };
    const stem = stemKey(siteColor);
    const loose = options.filter(o => stemKey(o.color) === stem);
    if (loose.length === 1) return { match: loose[0] };
    if (loose.length > 1) return { ambiguous: true };
    return {};
}

const isOlistTipo = (item, tipo) => safeString(item?.tipo).toUpperCase() === tipo;
const isOlistInactive = item => safeString(item?.situacao).toUpperCase() === "I";

// "read" consulta a Olist (ou devolve a resposta guardada de um passo anterior).
async function buildOlistSkuComparison(read) {
    const [siteProducts, olistList] = await Promise.all([
        supabaseRequest("products?select=id,name,sku,active,product_variants(id,color,sku,active)&order=name.asc", { method: "GET" }),
        listOlistProductsForSku(read)
    ]);
    const products = Array.isArray(siteProducts) ? siteProducts : [];

    const byName = new Map();
    const bySku = new Map();
    olistList.forEach(item => {
        const key = nameKey(item.descricao);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(item);
        if (item.sku) bySku.set(skuKey(item.sku), item);
    });

    const details = new Map();
    async function detailOf(id) {
        if (!details.has(String(id))) {
            details.set(String(id), await read("/produtos/" + encodeURIComponent(id)));
        }
        return details.get(String(id)) || {};
    }

    // Se o item achado for uma variação, sobe para o produto pai.
    async function parentOf(item) {
        const detail = await detailOf(item.id);
        const pai = detail?.produtoPai;
        if (pai?.id && String(pai.id) !== String(item.id)) {
            return olistList.find(o => String(o.id) === String(pai.id)) || { id: pai.id, sku: pai.sku, descricao: pai.descricao, tipo: "V" };
        }
        return item;
    }

    async function findBySku(sku) {
        let item = bySku.get(sku);
        if (!item) {
            const data = await read("/produtos?codigo=" + encodeURIComponent(sku) + "&limit=20");
            item = olistItemsFromResponse(data).find(p => skuKey(p.sku || p.codigo) === sku) || null;
        }
        if (!item || safeString(item.situacao).toUpperCase() === "E") return null;
        return parentOf(item);
    }

    function preferred(list, variantCount) {
        const sorted = list.filter(i => !isOlistInactive(i)).concat(list.filter(isOlistInactive));
        const withVariations = sorted.filter(i => isOlistTipo(i, "V"));
        return variantCount > 1 ? (withVariations[0] || sorted[0]) : sorted[0];
    }

    // Produto da Olist para um produto do site. sure=false vira sugestão no painel.
    async function findParent(product, variants) {
        const exact = byName.get(nameKey(product.name)) || [];
        if (exact.length) return { item: preferred(exact, variants.length), sure: true, how: "" };

        const core = coreKey(product.name);
        const sameCore = core.length >= 3 ? olistList.filter(i => coreKey(i.descricao) === core) : [];
        if (sameCore.length) return { item: preferred(sameCore, variants.length), sure: true, how: "Nome na Olist: " };

        {
            // SKU das cores só em produtos ativos: em rascunhos ele costuma estar repetido.
            const skus = [...new Set([product.sku, ...(product.active !== false ? variants.map(v => v.sku) : [])].map(skuKey).filter(Boolean))];
            for (const sku of skus) {
                const item = await findBySku(sku);
                if (item) {
                    const sure = nameScore(product.name, item.descricao) >= 0.5;
                    return { item, sure, how: sure ? "Achado pelo SKU " + sku + ". Na Olist: " : "Achado pelo SKU " + sku + ", mas o nome é diferente. Na Olist: " };
                }
            }
        }

        const scored = olistList
            .filter(i => !/ - /.test(safeString(i.descricao)))
            .map(i => ({ item: i, score: nameScore(product.name, i.descricao) }))
            .sort((a, b) => b.score - a.score);
        const [best, second] = scored;
        if (best && best.score >= 0.75 && (!second || second.score < best.score - 0.1)) {
            return { item: best.item, sure: false, how: "Nome parecido na Olist: " };
        }
        return { item: null, candidates: scored.filter(s => s.score >= 0.4).slice(0, 8).map(s => s.item) };
    }

    const rows = [];
    const choiceOf = item => ({ sku: safeString(item.sku), name: safeString(item.descricao || item.name) });

    for (const product of products) {
        const variants = Array.isArray(product.product_variants) ? product.product_variants : [];
        const base = { product_id: product.id, product_name: product.name, product_active: product.active !== false };
        const found = await findParent(product, variants);
        const parent = found.item;

        if (!parent) {
            rows.push({ ...base, key: "p:" + product.id, kind: "produto", variant_id: null, color: "", site_sku: safeString(product.sku),
                olist_sku: "", olist_name: "", status: "sem_par",
                note: found.candidates?.length ? "Não achamos o par sozinhos. Escolha o produto da Olist abaixo." : "Produto não encontrado na Olist.",
                choices: (found.candidates || []).filter(i => safeString(i.sku)).map(choiceOf) });
            continue;
        }

        const sameProductSku = skuKey(product.sku) === skuKey(parent.sku);
        rows.push({ ...base, key: "p:" + product.id, kind: "produto", variant_id: null, color: "", site_sku: safeString(product.sku),
            olist_sku: safeString(parent.sku), olist_name: safeString(parent.descricao),
            status: sameProductSku ? "ok" : (found.sure ? "divergente" : "sugerido"),
            note: found.how ? found.how + safeString(parent.descricao) : "" });

        // Variações da Olist: detalhe do produto pai.
        let options = [];
        if (isOlistTipo(parent, "V")) {
            const detail = await detailOf(parent.id);
            options = (Array.isArray(detail.variacoes) ? detail.variacoes : [])
                .filter(v => safeString(v?.sku))
                .map(v => ({ sku: safeString(v.sku), name: safeString(v.descricao) || safeString(parent.descricao), color: variationColor(v, parent.descricao) }));
        }
        // Produtos avulsos por cor na Olist ("Bag Cannes - café").
        olistList.forEach(item => {
            const key = nameKey(item.descricao);
            const baseKey = nameKey(product.name);
            if (item.id !== parent.id && key.startsWith(baseKey + " ") && safeString(item.sku) && !options.some(o => skuKey(o.sku) === skuKey(item.sku))) {
                options.push({ sku: safeString(item.sku), name: safeString(item.descricao), color: colorKey(item.descricao, product.name) });
            }
        });

        const variantRow = (variant, option, how) => {
            const row = { ...base, key: "v:" + variant.id, kind: "variacao", variant_id: variant.id, color: safeString(variant.color), site_sku: safeString(variant.sku) };
            if (!option) return row;
            const same = skuKey(variant.sku) === skuKey(option.sku);
            const sure = found.sure && how.sure;
            const note = same ? "" : (how.note || (found.sure ? "" : "Depende do produto sugerido acima."));
            return { ...row, olist_sku: option.sku, olist_name: option.name, status: same ? "ok" : (sure ? "divergente" : "sugerido"), note };
        };

        if (!options.length && variants.length === 1 && !isOlistTipo(parent, "V")) {
            rows.push(variantRow(variants[0], { sku: safeString(parent.sku), name: safeString(parent.descricao) }, { sure: true, note: "Produto simples na Olist." }));
            continue;
        }

        const used = new Set();
        const free = () => options.filter(o => !used.has(o));
        let pending = [];
        const done = new Map();

        // 1. Mesmo SKU dos dois lados: é a mesma peça, mesmo com a cor escrita diferente.
        variants.forEach(variant => {
            const option = skuKey(variant.sku) && free().find(o => skuKey(o.sku) === skuKey(variant.sku));
            if (option) { used.add(option); done.set(variant.id, variantRow(variant, option, { sure: true, note: "" })); }
            else pending.push(variant);
        });

        // 2. Mesma cor.
        pending = pending.filter(variant => {
            const picked = pickByColor(free(), colorKey(variant.color, product.name));
            if (!picked.match) return true;
            used.add(picked.match);
            done.set(variant.id, variantRow(variant, picked.match, { sure: true, note: "" }));
            return false;
        });

        // 3. Uma cor só dos dois lados: é a mesma peça, mesmo com nomes diferentes.
        if (pending.length === 1 && variants.length === 1 && free().length === 1) {
            const option = free()[0];
            used.add(option);
            done.set(pending[0].id, variantRow(pending[0], option, { sure: true, note: "Cor na Olist: " + option.name }));
            pending = [];
        }

        // 4. Cor equivalente (Bordô ↔ Vinho...): sugestão.
        pending = pending.filter(variant => {
            const group = colorGroup(colorKey(variant.color, product.name));
            if (group < 0) return true;
            const same = free().filter(o => colorGroup(o.color) === group);
            if (same.length !== 1) return true;
            used.add(same[0]);
            done.set(variant.id, variantRow(variant, same[0], { sure: false, note: "Cor parecida na Olist: " + same[0].name }));
            return false;
        });

        // 5. Sobrou uma variação de cada lado: sugestão.
        if (pending.length === 1 && free().length === 1) {
            const option = free()[0];
            used.add(option);
            done.set(pending[0].id, variantRow(pending[0], option, { sure: false, note: "Única variação sem par dos dois lados. Na Olist: " + option.name }));
            pending = [];
        }

        // 6. Sem par: escolha manual entre as variações da Olist que sobraram.
        pending.forEach(variant => {
            const remaining = free().length ? free() : options;
            done.set(variant.id, { ...variantRow(variant, null), olist_sku: "", olist_name: "", status: "sem_par",
                note: remaining.length ? "Cor não encontrada na Olist. Escolha a variação abaixo." : "Cor não encontrada nas variações da Olist.",
                choices: remaining.map(o => ({ sku: o.sku, name: o.name })) });
        });

        variants.forEach(variant => rows.push(done.get(variant.id)));
    }

    // SKU de produto é único no site: não troca para um SKU que outro produto
    // vai continuar usando. Em empate, o par certo ganha da sugestão.
    const changing = rows.filter(r => r.kind === "produto" && (r.status === "divergente" || r.status === "sugerido"));
    const holders = new Map();
    products.forEach(p => {
        if (!skuKey(p.sku) || changing.some(r => r.product_id === p.id)) return;
        holders.set(skuKey(p.sku), (holders.get(skuKey(p.sku)) || 0) + 1);
    });
    const bySkuChanging = new Map();
    changing.forEach(r => bySkuChanging.set(skuKey(r.olist_sku), (bySkuChanging.get(skuKey(r.olist_sku)) || []).concat(r)));
    bySkuChanging.forEach((list, sku) => {
        const sure = list.filter(r => r.status === "divergente");
        const blocked = holders.get(sku) ? list : (list.length > 1 ? (sure.length === 1 ? list.filter(r => r.status !== "divergente") : list) : []);
        blocked.forEach(r => { r.status = "conflito"; r.note = "Outro produto do site já usa esse SKU."; });
    });

    const summary = { ok: 0, divergente: 0, sugerido: 0, sem_par: 0, conflito: 0 };
    rows.forEach(r => { summary[r.status] = (summary[r.status] || 0) + 1; });
    return { rows, summary, olist_products: olistList.length };
}

// A comparação consulta a Olist umas 40 vezes (lista de produtos e detalhe de cada um),
// mais do que as 50 chamadas por requisição do plano gratuito do Cloudflare. Ela anda em
// passos: cada passo faz até OLIST_SKU_STEP_CALLS consultas novas, guarda as respostas
// (só os campos usados) no Supabase e o painel chama de novo até a comparação fechar.
const OLIST_SKU_CACHE_KEY = "olist_sku_compare_cache";
const OLIST_SKU_STEP_CALLS = 36;

function trimOlistForSku(endpoint, data) {
    if (/^\/produtos\/\d+$/.test(endpoint)) {
        const pai = data?.produtoPai;
        return {
            produtoPai: pai?.id ? { id: pai.id, sku: pai.sku, descricao: pai.descricao } : null,
            variacoes: (Array.isArray(data?.variacoes) ? data.variacoes : []).map(v => ({
                sku: v?.sku,
                descricao: v?.descricao,
                grade: (Array.isArray(v?.grade) ? v.grade : []).map(g => ({ chave: g?.chave, valor: g?.valor }))
            }))
        };
    }
    return {
        itens: olistItemsFromResponse(data).map(i => ({ id: i.id, sku: i.sku, codigo: i.codigo, descricao: i.descricao, tipo: i.tipo, situacao: i.situacao })),
        paginacao: { total: Number(data?.paginacao?.total || 0) }
    };
}

async function saveSkuCompareCache(value) {
    await supabaseRequest("kv_store_48db9b7e?on_conflict=key", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: OLIST_SKU_CACHE_KEY, value })
    });
}

app.get("/api/admin/olist/sku-compare", requireAdmin, async (req, res) => {
    try {
        let cache = { started_at: Date.now(), entries: {} };
        if (req.query.restart !== "1") {
            const saved = (await supabaseRequest("kv_store_48db9b7e?key=eq." + OLIST_SKU_CACHE_KEY + "&select=value&limit=1", { method: "GET" }))?.[0]?.value;
            if (saved?.entries && Date.now() - Number(saved.started_at || 0) < OLIST_SKU_COMPARE_TTL) cache = saved;
        }
        const budget = createCallBudget(OLIST_SKU_STEP_CALLS);
        let fetched = 0;
        const read = async endpoint => {
            if (Object.prototype.hasOwnProperty.call(cache.entries, endpoint)) return cache.entries[endpoint];
            if (!budget.has(1)) throw Object.assign(new Error("SKU_COMPARE_NEXT_STEP"), { nextStep: true });
            if (fetched) await pause(350);
            budget.use();
            fetched++;
            const data = trimOlistForSku(endpoint, await olistRequest(endpoint));
            cache.entries[endpoint] = data;
            return data;
        };

        let result;
        try {
            await ensureOlistAccess(budget);
            result = await buildOlistSkuComparison(read);
        } catch (error) {
            const rateLimited = error?.status === 429;
            if (!error?.nextStep && !rateLimited) throw error;
            await saveSkuCompareCache(cache);
            return res.json({ success: true, partial: true, read: Object.keys(cache.entries).length, wait: rateLimited ? 8 : 0 });
        }
        if (fetched) await saveSkuCompareCache(cache).catch(error => console.warn("SKU — cache não salvo:", error.message));

        // A comparação vai assinada para o painel: no Workers cada requisição
        // pode cair em outra instância, então nada fica guardado em memória.
        const actionable = result.rows
            .filter(r => r.status === "divergente" || r.status === "sugerido" || (r.choices && r.choices.length))
            .map(r => ({ k: r.key, t: r.kind === "produto" ? "p" : "v", p: r.product_id, v: r.variant_id, f: r.site_sku, s: r.status, o: r.olist_sku, c: (r.choices || []).map(c => c.sku), n: r.product_name, cor: r.color }));
        const token = createSignedToken({ purpose: "sku-sync", rows: actionable }, OLIST_SKU_COMPARE_TTL);
        return res.json({ success: true, token, generated_at: new Date().toISOString(), ...result });
    } catch (error) {
        console.error("SKU site × Olist:", error);
        const auth = /OLIST_AUTH_(REQUIRED|REFRESH_FAILED)/.test(String(error.message));
        return res.status(502).json({ success: false, reconnect: auth, message: auth
            ? "A conexão com a Olist expirou. Clique em RECONECTAR OLIST, entre na Olist e autorize de novo."
            : "Não foi possível consultar os produtos na Olist agora. Tente de novo em alguns minutos." });
    }
});

const SKU_SYNC_WRITES = 36;

app.post("/api/admin/olist/sku-sync", requireAdmin, async (req, res) => {
    try {
        const saved = verifySignedToken(req.body?.token);
        if (!saved || saved.purpose !== "sku-sync" || !Array.isArray(saved.rows)) {
            return res.status(409).json({ success: false, message: "A comparação expirou. Compare de novo antes de corrigir." });
        }
        const accept = new Set(Array.isArray(req.body?.accept) ? req.body.accept.map(safeString) : []);
        const picks = req.body?.picks && typeof req.body.picks === "object" ? req.body.picks : {};

        // Só entra o que a comparação permitiu: divergentes, sugestões aceitas e
        // escolhas manuais entre as opções que ela mostrou.
        const pending = [];
        saved.rows.forEach(r => {
            let target = "";
            const pick = skuKey(picks[r.k]);
            if (pick && Array.isArray(r.c) && r.c.some(sku => skuKey(sku) === pick)) target = r.c.find(sku => skuKey(sku) === pick);
            else if (r.s === "divergente") target = r.o;
            else if (r.s === "sugerido" && accept.has(r.k)) target = r.o;
            if (target && skuKey(target) !== skuKey(r.f)) pending.push({ ...r, target });
        });

        const updated = [];
        const skipped = [];
        const label = r => ({ product_name: r.n, color: r.cor || "" });
        // Até 50 chamadas por requisição no Cloudflare: lê tudo em duas consultas e grava
        // no máximo SKU_SYNC_WRITES por vez. O painel chama de novo enquanto sobrar algo;
        // o que já foi gravado aparece com o SKU novo e é pulado em silêncio.
        let writes = SKU_SYNC_WRITES;
        let remaining = 0;
        const idList = ids => [...new Set(ids.map(String))].map(encodeURIComponent).join(",");

        // Variações: não deixa duas cores do mesmo produto com o mesmo SKU.
        const variantRows = pending.filter(r => r.t === "v");
        const siblingsByProduct = new Map();
        const currentVariant = new Map();
        if (variantRows.length) {
            const rows = await supabaseRequest("product_variants?product_id=in.(" + idList(variantRows.map(r => r.p)) + ")&select=id,sku,product_id", { method: "GET" });
            (Array.isArray(rows) ? rows : []).forEach(v => {
                currentVariant.set(String(v.id), v);
                if (!siblingsByProduct.has(String(v.product_id))) siblingsByProduct.set(String(v.product_id), new Map());
                siblingsByProduct.get(String(v.product_id)).set(String(v.id), skuKey(v.sku));
            });
        }
        for (const row of variantRows) {
            const current = currentVariant.get(String(row.v));
            if (!current) { skipped.push({ ...label(row), reason: "Variação não existe mais." }); continue; }
            if (skuKey(current.sku) === skuKey(row.target)) continue;
            if (skuKey(current.sku) !== skuKey(row.f)) { skipped.push({ ...label(row), reason: "SKU mudou desde a comparação." }); continue; }
            const taken = siblingsByProduct.get(String(current.product_id)) || new Map();
            const clash = [...taken.entries()].some(([id, sku]) => id !== String(row.v) && sku === skuKey(row.target) && !variantRows.some(o => String(o.v) === id && skuKey(o.target) !== sku));
            if (clash) { skipped.push({ ...label(row), reason: "Outra cor deste produto já usa esse SKU." }); continue; }
            if (writes < 1) { remaining++; continue; }
            writes--;
            await supabaseRequest("product_variants?id=eq." + encodeURIComponent(row.v), { method: "PATCH", body: JSON.stringify({ sku: row.target }) });
            taken.set(String(row.v), skuKey(row.target));
            updated.push({ ...label(row), from: row.f, to: row.target });
        }

        // Produtos: SKU único. Primeiro libera os SKUs antigos, depois grava os novos
        // (duas gravações por produto, todas na mesma requisição para permitir trocas).
        const productRowsAll = pending.filter(r => r.t === "p");
        const currentProduct = new Map();
        if (productRowsAll.length) {
            const rows = await supabaseRequest("products?id=in.(" + idList(productRowsAll.map(r => r.p)) + ")&select=id,sku", { method: "GET" });
            (Array.isArray(rows) ? rows : []).forEach(p => currentProduct.set(String(p.id), p));
        }
        const productRows = [];
        for (const row of productRowsAll) {
            const current = currentProduct.get(String(row.p));
            if (!current) { skipped.push({ ...label(row), reason: "Produto não existe mais." }); continue; }
            if (skuKey(current.sku) === skuKey(row.target)) continue;
            // "SYNC-<id>" sobra quando uma correção anterior parou no meio.
            if (skuKey(current.sku) !== skuKey(row.f) && current.sku !== "SYNC-" + row.p) { skipped.push({ ...label(row), reason: "SKU mudou desde a comparação." }); continue; }
            if (writes < 2) { remaining++; continue; }
            writes -= 2;
            productRows.push(row);
        }
        for (const row of productRows) {
            await supabaseRequest("products?id=eq." + encodeURIComponent(row.p), { method: "PATCH", body: JSON.stringify({ sku: "SYNC-" + row.p }) });
        }
        for (const row of productRows) {
            try {
                await supabaseRequest("products?id=eq." + encodeURIComponent(row.p), { method: "PATCH", body: JSON.stringify({ sku: row.target }) });
                updated.push({ ...label(row), from: row.f, to: row.target });
            } catch (error) {
                console.error("SKU do produto não atualizado:", row.p, error.message);
                await supabaseRequest("products?id=eq." + encodeURIComponent(row.p), { method: "PATCH", body: JSON.stringify({ sku: row.f || null }) }).catch(() => {});
                skipped.push({ ...label(row), reason: "Outro produto já usa esse SKU." });
            }
        }

        console.log("🔁 SKU site ← Olist:", { updated: updated.length, skipped: skipped.length, remaining });
        return res.json({ success: true, updated: updated.length, skipped, changes: updated, remaining });
    } catch (error) {
        console.error("SKU sync:", error);
        return res.status(500).json({ success: false, message: "Não foi possível corrigir os SKUs no site." });
    }
});

/* =====================================================
   OLIST → SITE (estoque, preço, promoção e cores)
   A Olist manda: o site confere cada produto ativo na Olist e deixa o
   site igual a ela.
   - Estoque de cada cor = disponível na Olist, menos as vendas do site
     que a Olist ainda não registrou (pedidos pagos nos últimos dias que
     ainda não foram enviados e não aparecem como reservados lá). Sobe e
     desce, para ficar igual à Olist sem vender o que já foi vendido.
   - Preço e preço promocional (promoção na Olist vira SALE no site; a
     SALE feita à mão no painel continua até a Olist ter promoção).
   - Cores: o nome da cor segue a Olist e cores novas da Olist (com
     estoque) entram no produto.
   Nome, descrição e fotos continuam sendo do site, e nada é alterado na
   Olist. As peças são reconhecidas pelo SKU. Roda em lotes pequenos a
   cada minuto (o plano gratuito do Cloudflare permite 50 chamadas
   externas por execução) e recomeça a rodada logo depois de terminar;
   na hora da compra, as peças do carrinho são conferidas de novo.
===================================================== */
const OLIST_STOCK_PAUSE_MS = 900;
const OLIST_STOCK_STATUS_KEY = "olist_stock_sync";
const OLIST_SYNC_SETTINGS_KEY = "olist_sync_settings";
const OLIST_SYNC_DEFAULT_SETTINGS = { prices: true, colors: true };
// Produtos lidos do Supabase por lote (o lote para antes se acabarem as chamadas).
const OLIST_SYNC_PRODUCT_PAGE = 12;
const OLIST_STOCK_BATCH_MS = 40 * 1000;
const OLIST_STOCK_LEASE_MS = 90 * 1000;
// Intervalo entre o fim de uma rodada automática e o começo da próxima.
const OLIST_STOCK_CYCLE_GAP_MS = 60 * 1000;
// Vendas do site desses últimos dias que ainda não foram enviadas contam como
// "a Olist ainda pode não ter baixado".
const OLIST_PENDING_SALE_DAYS = 7;

function olistAvailableFrom(data) {
    const value = ["disponivel", "saldo"].map(key => Number(data?.[key])).find(Number.isFinite);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OLIST_TIMEOUT")), ms); })
    ]);
}

// Id da peça na Olist (variação ou produto simples) pelo SKU. Fica guardado
// em product_variants.olist_product_id para as próximas consultas.
async function olistItemIdForVariant(variant, { refresh = false, budget = null } = {}) {
    const sku = skuKey(variant.sku);
    if (!sku) return null;
    if (variant.olist_product_id && !refresh) return Number(variant.olist_product_id);
    spend(budget);
    const data = await olistRequest("/produtos?codigo=" + encodeURIComponent(safeString(variant.sku)) + "&limit=20");
    const item = olistItemsFromResponse(data).find(p => skuKey(p.sku || p.codigo) === sku && safeString(p.situacao).toUpperCase() !== "E");
    const id = item?.id ? Number(item.id) : null;
    const saved = variant.olist_product_id ? Number(variant.olist_product_id) : null;
    if (id !== saved) {
        spend(budget);
        await supabaseRequest("product_variants?id=eq." + encodeURIComponent(variant.id), {
            method: "PATCH",
            headers: { "Prefer": "return=minimal" },
            body: JSON.stringify({ olist_product_id: id })
        });
    }
    variant.olist_product_id = id;
    return id;
}

// Estoque disponível da peça na Olist. found=false quando o SKU não existe lá.
async function olistAvailableForVariant(variant, budget = null) {
    let id = await olistItemIdForVariant(variant, { budget });
    if (!id) return { available: null, found: false };
    let data = null;
    try {
        spend(budget);
        data = await olistRequest("/estoque/" + encodeURIComponent(id));
    } catch (error) {
        if (error?.status !== 404) throw error;
    }
    // O SKU mudou ou a peça foi apagada na Olist: procura de novo pelo SKU.
    if (!data || (data.codigo && skuKey(data.codigo) !== skuKey(variant.sku))) {
        id = await olistItemIdForVariant(variant, { refresh: true, budget });
        if (!id) return { available: null, found: false };
        spend(budget);
        data = await olistRequest("/estoque/" + encodeURIComponent(id));
    }
    return { available: olistAvailableFrom(data), found: true };
}

// Na hora da compra: baixa o estoque da variação até "target" (nunca aumenta) e registra no histórico.
async function lowerSiteStock(variant, target, reason, budget = null) {
    for (let attempt = 0; attempt < 2; attempt++) {
        spend(budget);
        const rows = await supabaseRequest("product_variants?id=eq." + encodeURIComponent(variant.id) + "&select=stock", { method: "GET" });
        const current = Number(rows?.[0]?.stock || 0);
        const delta = Math.max(0, target) - current;
        if (delta >= 0) return { changed: false, from: current, to: current };
        try {
            spend(budget);
            await supabaseRequest("rpc/adjust_product_variant_stock", {
                method: "POST",
                body: JSON.stringify({ p_variant_id: variant.id, p_delta: delta, p_movement_type: "correction", p_reason: reason, p_created_by: "olist" })
            });
            return { changed: true, from: current, to: current + delta };
        } catch (error) {
            // Uma venda baixou o estoque no meio do caminho: lê de novo e tenta mais uma vez.
            if (attempt || !/Estoque insuficiente/.test(String(error.message))) throw error;
        }
    }
    return { changed: false };
}

// Estado guardado no Supabase: a rodada em andamento (cycle, com o cursor "after"), a última
// rodada concluída (last), a trava do lote que está rodando (lease_until), a última conferência
// de cada produto e cor (snapshot, para o painel), o produto pai na Olist de cada cor (links) e
// as promoções que vieram da Olist (sales). As opções do painel ficam numa chave separada.
function normalizeOlistStockState(value = {}) {
    // Formato antigo (a rodada inteira de uma vez): vira a última rodada concluída.
    if (value.ran_at && !value.version) value = { last: value };
    return {
        last: value.last || null,
        cycle: value.cycle || null,
        lease_until: Number(value.lease_until) || 0,
        snapshot: { products: value.snapshot?.products || {}, variants: value.snapshot?.variants || {} },
        links: value.links || {},
        sales: value.sales || {}
    };
}

async function readOlistStockState() {
    const rows = await supabaseRequest(
        "kv_store_48db9b7e?key=in.(" + OLIST_STOCK_STATUS_KEY + "," + OLIST_SYNC_SETTINGS_KEY + ")&select=key,value",
        { method: "GET" }
    );
    const byKey = new Map((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
    const state = normalizeOlistStockState(byKey.get(OLIST_STOCK_STATUS_KEY) || {});
    state.settings = { ...OLIST_SYNC_DEFAULT_SETTINGS, ...(byKey.get(OLIST_SYNC_SETTINGS_KEY) || {}) };
    return state;
}

async function writeOlistStockState(state) {
    const { settings, ...value } = state;
    await supabaseRequest("kv_store_48db9b7e?on_conflict=key", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: OLIST_STOCK_STATUS_KEY, value: { ...value, version: 3, updated_at: new Date().toISOString() } })
    });
}

// Espaça as consultas à Olist (limite de requisições por minuto da API).
function createOlistPacer(ms = OLIST_STOCK_PAUSE_MS) {
    let last = 0;
    return async () => {
        const wait = last + ms - Date.now();
        if (wait > 0) await pause(wait);
        last = Date.now();
    };
}

// Valor em reais vindo da Olist (número ou texto "1.234,56"). null quando vazio ou zero.
function olistMoney(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = typeof value === "number"
        ? value
        : Number(String(value).trim().replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
    return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null;
}

// Preço e preço promocional de um produto ou variação da Olist.
function olistPricesOf(item) {
    const price = olistMoney(item?.precos?.preco ?? item?.preco);
    const promo = olistMoney(item?.precos?.precoPromocional ?? item?.precoPromocional);
    return { price, promo: price && promo && promo < price - 0.004 ? promo : null };
}

// Nome da cor de uma variação da Olist, só quando a grade tem "Cor" (ex.: "Café").
function olistColorLabel(variation) {
    const grade = Array.isArray(variation?.grade) ? variation.grade : [];
    const value = safeString(grade.find(g => /^cor/i.test(safeString(g?.chave)))?.valor);
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

const sameMoney = (a, b) => a !== null && b !== null && a !== undefined && b !== undefined && Math.abs(Number(a) - Number(b)) < 0.005;
const brlText = value => "R$ " + Number(value || 0).toFixed(2).replace(".", ",");

async function olistDetail(id, ctx) {
    await ctx.pace();
    spend(ctx.budget);
    try {
        return await olistRequest("/produtos/" + encodeURIComponent(id));
    } catch (error) {
        if (error?.status === 404) return null;
        throw error;
    }
}

// Disponível e reservado de uma peça da Olist pelo id. null quando a peça não existe.
async function olistStockById(id, ctx) {
    await ctx.pace();
    spend(ctx.budget);
    let data;
    try {
        data = await olistRequest("/estoque/" + encodeURIComponent(id));
    } catch (error) {
        if (error?.status === 404) return null;
        throw error;
    }
    const reserved = Number(data?.reservado);
    return {
        codigo: safeString(data?.codigo),
        available: olistAvailableFrom(data),
        reserved: Number.isFinite(reserved) ? Math.max(0, Math.floor(reserved)) : 0
    };
}

// Estoque da cor na Olist. found=false quando o SKU não existe lá.
async function olistStockForVariant(variant, ctx) {
    let stock = variant.olist_product_id ? await olistStockById(variant.olist_product_id, ctx) : null;
    // O SKU mudou ou a peça foi apagada na Olist: procura de novo pelo SKU.
    if (!stock || (stock.codigo && skuKey(stock.codigo) !== skuKey(variant.sku))) {
        await ctx.pace();
        const id = await olistItemIdForVariant(variant, { refresh: true, budget: ctx.budget });
        delete ctx.state.links[variant.id];
        if (!id) return { found: false };
        stock = await olistStockById(id, ctx);
        if (!stock) return { found: false };
    }
    return { found: true, available: stock.available, reserved: stock.reserved };
}

// Deixa o estoque da cor em "target" (sobe ou desce) e registra no histórico. Se uma venda
// do site mexeu no estoque no meio do caminho, desconta a venda e tenta mais uma vez.
async function setSiteStock(variant, target, reason, budget) {
    const loaded = Number(variant.stock || 0);
    let current = loaded;
    let wanted = Math.max(0, target);
    for (let attempt = 0; attempt < 2; attempt++) {
        if (wanted === current) return attempt ? { from: loaded, to: current } : null;
        try {
            spend(budget);
            const rows = await supabaseRequest("rpc/adjust_product_variant_stock", {
                method: "POST",
                body: JSON.stringify({ p_variant_id: variant.id, p_delta: wanted - current, p_movement_type: "correction", p_reason: reason, p_created_by: "olist" })
            });
            const row = Array.isArray(rows) ? rows[0] : rows;
            const to = Number.isFinite(Number(row?.stock)) ? Number(row.stock) : wanted;
            variant.stock = to;
            return { from: loaded, to };
        } catch (error) {
            if (attempt || !/Estoque insuficiente/.test(String(error.message))) throw error;
            spend(budget);
            const fresh = await supabaseRequest("product_variants?id=eq." + encodeURIComponent(variant.id) + "&select=stock", { method: "GET" });
            current = Number(fresh?.[0]?.stock || 0);
            wanted = Math.max(0, target - Math.max(0, loaded - current));
        }
    }
    return null;
}

// Preço e promoção da Olist no produto do site. A SALE feita no site continua com os preços
// dela (nada muda nesses produtos). Promoção na Olist vira SALE no site e sai quando acaba lá.
async function applyOlistPrices(product, olist, ctx) {
    const id = String(product.id);
    const sales = ctx.state.sales;
    const sitePrice = Number(product.price);
    const siteSale = product.is_sale && product.sale_price !== null && product.sale_price !== undefined ? Number(product.sale_price) : null;
    // A SALE é do site quando não veio da Olist (ou foi mudada no painel depois de vir).
    if (siteSale !== null && !(sales[id] !== undefined && sameMoney(siteSale, sales[id]))) {
        delete sales[id];
        return { kept: true };
    }
    const patch = {};
    if (olist.promo) {
        if (!sameMoney(sitePrice, olist.price)) patch.price = olist.price;
        if (!sameMoney(siteSale, olist.promo)) { patch.sale_price = olist.promo; patch.is_sale = true; }
        sales[id] = olist.promo;
    } else {
        if (sales[id] !== undefined) {
            // A promoção tinha vindo da Olist e acabou lá.
            patch.is_sale = false;
            patch.sale_price = null;
            delete sales[id];
        }
        if (!sameMoney(sitePrice, olist.price)) patch.price = olist.price;
    }
    if (!Object.keys(patch).length) return {};
    spend(ctx.budget);
    await supabaseRequest("products?id=eq." + encodeURIComponent(product.id), {
        method: "PATCH",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    });
    publicCache.delete("catalog");
    const before = siteSale !== null ? brlText(sitePrice) + " → SALE " + brlText(siteSale) : brlText(sitePrice);
    const price = patch.price ?? sitePrice;
    const sale = patch.is_sale === false ? null : (patch.sale_price ?? siteSale);
    Object.assign(product, { price, sale_price: sale, is_sale: sale !== null });
    return { changed: { from: before, to: sale !== null ? brlText(price) + " → SALE " + brlText(sale) : brlText(price) } };
}

// Confere um produto do site na Olist e deixa o site igual: preço, cores e estoque.
async function syncProductWithOlist(product, ctx) {
    const { budget, state, settings } = ctx;
    const now = new Date().toISOString();
    const name = safeString(product.name);
    const variants = Array.isArray(product.product_variants) ? product.product_variants : [];
    const label = variant => ({ product: name, color: safeString(variant.color), sku: safeString(variant.sku) });
    const snap = (variant, data) => { state.snapshot.variants[variant.id] = { p: product.id, at: now, ...data }; };
    const live = variants.filter(variant => variant.active !== false && safeString(variant.sku));

    // Pré-venda: as bolsas ainda não chegaram; estoque, preço e cores ficam como no painel
    // até a pré-venda ser desmarcada.
    if (product.is_presale) {
        state.snapshot.products[product.id] = { at: now, st: "pre_venda", price: null, promo: null };
        live.forEach(variant => snap(variant, { st: "pre_venda", site: Number(variant.stock || 0) }));
        return;
    }

    // 1. A peça da Olist de cada cor (pelo SKU) e o produto pai dela.
    const sources = new Map();   // id na Olist do produto pai (ou da peça avulsa) → detalhe
    const sourceOf = new Map();  // cor do site → id da fonte
    const checked = [];
    for (const variant of live) {
        if (ctx.dupSkus.has(skuKey(variant.sku))) {
            snap(variant, { st: "sku_repetido", site: Number(variant.stock || 0) });
            ctx.cycle.duplicates.push(label(variant));
            continue;
        }
        if (!variant.olist_product_id) {
            await ctx.pace();
            await olistItemIdForVariant(variant, { budget });
        }
        let item = variant.olist_product_id ? Number(variant.olist_product_id) : null;
        let link = state.links[variant.id];
        if (item && (!link || Number(link.item) !== item)) {
            let detail = await olistDetail(item, ctx);
            if (!detail) {
                // A peça foi apagada ou trocada na Olist: procura o SKU de novo.
                await ctx.pace();
                item = await olistItemIdForVariant(variant, { refresh: true, budget });
                detail = item ? await olistDetail(item, ctx) : null;
            }
            if (detail) {
                const pai = detail.produtoPai;
                const parent = pai?.id && String(pai.id) !== String(item) ? Number(pai.id) : 0;
                link = state.links[variant.id] = { item, parent };
                if (!parent) sources.set(item, detail);
            } else {
                item = null;
            }
        }
        if (!item) {
            delete state.links[variant.id];
            snap(variant, { st: "sem_olist", site: Number(variant.stock || 0) });
            ctx.cycle.not_found.push(label(variant));
            continue;
        }
        sourceOf.set(variant.id, link.parent || item);
        checked.push(variant);
    }

    // 2. Detalhe de cada fonte: o produto pai traz as variações; a peça avulsa, o próprio preço.
    for (const id of new Set(sourceOf.values())) {
        if (!sources.has(id)) sources.set(id, await olistDetail(id, ctx));
        // O produto pai sumiu: as cores dele procuram o pai de novo na próxima rodada.
        if (!sources.get(id)) checked.filter(v => sourceOf.get(v.id) === id).forEach(v => delete state.links[v.id]);
    }

    // 3. Preço e promoção: a variação tem preço próprio; se não tiver, vale o do produto pai.
    const report = { at: now, st: "igual", price: null, promo: null };
    const priceList = [];
    for (const [id, detail] of sources) {
        if (!detail) continue;
        const variations = Array.isArray(detail.variacoes) ? detail.variacoes : [];
        const own = olistPricesOf(detail);
        checked.filter(v => sourceOf.get(v.id) === id).forEach(variant => {
            const variation = variations.find(x => skuKey(x?.sku) === skuKey(variant.sku));
            const prices = variation ? olistPricesOf(variation) : { price: null, promo: null };
            priceList.push(prices.price ? prices : own);
        });
    }
    const known = priceList.filter(p => p.price);
    if (known.length) Object.assign(report, { price: known[0].price, promo: known[0].promo });
    if (!known.length) {
        report.st = checked.length ? "sem_preco" : live.some(v => ctx.dupSkus.has(skuKey(v.sku))) ? "sku_repetido" : "sem_olist";
    } else if (new Set(known.map(p => p.price + "/" + (p.promo || ""))).size > 1) {
        report.st = "aviso";
        report.note = "Na Olist, as cores deste produto têm preços diferentes; o site usa um preço só. Confira.";
    } else if (!settings.prices) {
        report.st = "desligado";
    } else {
        const result = await applyOlistPrices(product, known[0], ctx);
        if (result.kept) report.st = "sale_site";
        if (result.changed) {
            report.st = "atualizado";
            ctx.changes.push({ product: name, color: "", sku: "", what: "preco", ...result.changed });
        }
    }
    state.snapshot.products[product.id] = report;

    // 4. Cores: nome da cor igual ao da Olist e cores novas da Olist (com estoque) no site.
    if (settings.colors) {
        for (const [id, detail] of sources) {
            const variations = Array.isArray(detail?.variacoes) ? detail.variacoes : [];
            for (const variation of variations) {
                const sku = skuKey(variation?.sku);
                const color = olistColorLabel(variation);
                if (!sku || !color) continue;
                const siteVariant = variants.find(v => skuKey(v.sku) === sku);
                if (siteVariant) {
                    if (siteVariant.active === false || ctx.dupSkus.has(sku)) continue;
                    if (stemKey(colorKey(siteVariant.color, name)) === stemKey(colorKey(color, name))) continue;
                    if (variants.some(v => v.id !== siteVariant.id && nameKey(v.color) === nameKey(color))) continue;
                    spend(budget);
                    await supabaseRequest("product_variants?id=eq." + encodeURIComponent(siteVariant.id), {
                        method: "PATCH",
                        headers: { "Prefer": "return=minimal" },
                        body: JSON.stringify({ color, updated_at: new Date().toISOString() })
                    });
                    ctx.changes.push({ ...label(siteVariant), what: "cor", from: safeString(siteVariant.color), to: color });
                    siteVariant.color = color;
                    publicCache.delete("catalog");
                } else if (!ctx.allSkus.has(sku) && variation.id && !variants.some(v => nameKey(v.color) === nameKey(color))) {
                    if (!budget.has(4)) break;
                    const stock = await olistStockById(variation.id, ctx);
                    if (!stock || !(stock.available > 0)) continue;
                    spend(budget);
                    const rows = await supabaseRequest("product_variants", {
                        method: "POST",
                        body: JSON.stringify({ product_id: product.id, color, sku: safeString(variation.sku), stock: 0, active: true, olist_product_id: Number(variation.id) })
                    });
                    const created = Array.isArray(rows) ? rows[0] : rows;
                    if (!created?.id) continue;
                    ctx.allSkus.add(sku);
                    variants.push(created);
                    state.links[created.id] = { item: Number(variation.id), parent: id };
                    const target = stock.available;
                    const change = await setSiteStock(created, target, "Cor nova da Olist: " + stock.available + " disponível", budget);
                    snap(created, { st: "igual", olist: stock.available, res: stock.reserved, pend: 0, target, site: change ? change.to : 0 });
                    ctx.changes.push({ ...label(created), what: "nova_cor", from: "", to: color + " · " + target + " em estoque" });
                    publicCache.delete("catalog");
                }
            }
        }
    }

    // 5. Estoque de cada cor: disponível na Olist menos as vendas do site que ela ainda não registrou.
    for (const variant of checked) {
        const stock = await olistStockForVariant(variant, ctx);
        ctx.cycle.checked++;
        if (!stock.found) {
            snap(variant, { st: "sem_olist", site: Number(variant.stock || 0) });
            ctx.cycle.not_found.push(label(variant));
            continue;
        }
        if (stock.available === null) {
            snap(variant, { st: "erro", site: Number(variant.stock || 0) });
            continue;
        }
        const waiting = Math.max(0, (ctx.pending.get(String(variant.id)) || 0) - stock.reserved);
        const target = Math.max(0, stock.available - waiting);
        const change = await setSiteStock(
            variant,
            target,
            "Estoque da Olist: " + stock.available + " disponível" + (waiting ? " (" + waiting + " vendida" + (waiting > 1 ? "s" : "") + " no site aguardando a Olist)" : ""),
            budget
        );
        if (change) {
            ctx.changes.push({ ...label(variant), what: "estoque", from: change.from, to: change.to });
            publicCache.delete("catalog");
        }
        snap(variant, { st: "igual", olist: stock.available, res: stock.reserved, pend: waiting, target, site: change ? change.to : Number(variant.stock || 0) });
    }
}

// Um lote da rodada: confere os próximos produtos até gastar as chamadas ou o tempo.
// restart começa uma rodada nova (botão do painel); cycleId diz qual rodada o painel acompanha.
async function syncOlistStockBatch({ trigger = "agendada", calls = WORKER_CALL_LIMIT - 4, restart = false, cycleId = "", maxMs = OLIST_STOCK_BATCH_MS } = {}) {
    if (!OLIST_SYNC_ENABLED) return { skipped: "disabled" };
    const started = Date.now();
    const budget = createCallBudget(calls);
    // Estado, trava, produtos, vendas pendentes, SKUs e gravação final (6), acesso à Olist (3)
    // e pelo menos um produto pequeno.
    if (!budget.has(6 + 3 + 6)) return { skipped: "budget" };

    budget.use();
    const state = await readOlistStockState();
    if (state.lease_until > Date.now()) return { skipped: "running", state };
    // O painel acompanhava uma rodada que já terminou (o lote automático fechou).
    if (cycleId && !restart && state.cycle?.id !== cycleId) return { done: true, state, cycle_id: cycleId };

    let cycle = restart ? null : state.cycle;
    if (!cycle) {
        const lastEnd = Date.parse(state.last?.finished_at || "") || 0;
        if (!restart && Date.now() - lastEnd < OLIST_STOCK_CYCLE_GAP_MS) return { skipped: "rest", state };
        cycle = { id: new Date().toISOString(), started_at: new Date().toISOString(), trigger, after: "", products: 0, checked: 0, changes: [], not_found: [], duplicates: [], errors: 0 };
    }
    ["changes", "not_found", "duplicates"].forEach(key => { if (!Array.isArray(cycle[key])) cycle[key] = []; });
    budget.use();
    await writeOlistStockState({ ...state, cycle, lease_until: Date.now() + OLIST_STOCK_LEASE_MS });

    const changesNow = [];
    let finished = false;
    budget.use(); // gravação final
    try {
        await ensureOlistAccess(budget);
        budget.use(3);
        const since = new Date(Date.now() - OLIST_PENDING_SALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
        const [products, pendingRows, skuRows] = await Promise.all([
            supabaseRequest(
                "products?select=id,name,price,sale_price,is_sale,is_presale,product_variants(id,color,sku,stock,active,olist_product_id)" +
                "&active=eq.true" + (cycle.after ? "&id=gt." + encodeURIComponent(cycle.after) : "") +
                "&order=id.asc&limit=" + OLIST_SYNC_PRODUCT_PAGE,
                { method: "GET" }
            ),
            // Vendas do site já baixadas no site e ainda não enviadas.
            supabaseRequest(
                "order_items?select=variant_id,quantity,orders!inner(status,stock_decremented,created_at)" +
                "&variant_id=not.is.null&orders.status=in.(paid,processing)&orders.stock_decremented=is.true" +
                "&orders.created_at=gte." + encodeURIComponent(since),
                { method: "GET" }
            ),
            supabaseRequest("product_variants?select=sku,active,products!inner(active)&sku=not.is.null", { method: "GET" })
        ]);
        const pending = new Map();
        (Array.isArray(pendingRows) ? pendingRows : []).forEach(row => {
            pending.set(String(row.variant_id), (pending.get(String(row.variant_id)) || 0) + Math.max(0, Number(row.quantity) || 0));
        });
        // Um SKU em duas peças ativas do site não é conferido: o estoque da Olist seria vendido duas vezes.
        const allSkus = new Set();
        const activeCount = new Map();
        (Array.isArray(skuRows) ? skuRows : []).forEach(row => {
            const sku = skuKey(row.sku);
            if (!sku) return;
            allSkus.add(sku);
            if (row.active !== false && row.products?.active !== false) activeCount.set(sku, (activeCount.get(sku) || 0) + 1);
        });
        const dupSkus = new Set([...activeCount].filter(([, count]) => count > 1).map(([sku]) => sku));

        const ctx = { budget, state, settings: state.settings, cycle, pending, allSkus, dupSkus, changes: changesNow, pace: createOlistPacer() };
        const list = Array.isArray(products) ? products : [];
        let index = 0;
        for (; index < list.length; index++) {
            const product = list[index];
            const live = (product.product_variants || []).filter(v => v.active !== false && safeString(v.sku)).length;
            if (Date.now() - started > maxMs || !budget.has(Math.min(30, 4 + 3 * live))) break;
            try {
                await syncProductWithOlist(product, ctx);
                cycle.products++;
            } catch (error) {
                // Limite da Olist ou das chamadas: o produto fica para o próximo lote.
                if (error?.status === 429 || error?.budget) break;
                if (/OLIST_AUTH|OLIST_SYNC_DISABLED/.test(String(error.message))) throw error;
                cycle.errors++;
                console.error("Olist → site —", product.name, error.message);
            }
            cycle.after = product.id;
        }
        finished = index >= list.length && list.length < OLIST_SYNC_PRODUCT_PAGE;
    } catch (error) {
        // Sem acesso à Olist: encerra a rodada com o aviso para o painel.
        cycle.error = /OLIST_AUTH/.test(String(error.message))
            ? "A conexão com a Olist expirou. Clique em RECONECTAR OLIST."
            : "Não foi possível consultar a Olist agora.";
        console.error("Olist → site:", error.message);
        finished = true;
    }

    cycle.changes = cycle.changes.concat(changesNow).slice(-150);
    // Um produto que ficou para o lote seguinte entra de novo nessas listas: uma vez só.
    const once = list => [...new Map(list.map(x => [x.product + "|" + x.sku, x])).values()];
    cycle.not_found = once(cycle.not_found).slice(0, 60);
    cycle.duplicates = once(cycle.duplicates).slice(0, 20);
    const next = { ...state, cycle, lease_until: 0 };
    if (finished) {
        next.last = { ...cycle, ran_at: cycle.started_at, finished_at: new Date().toISOString() };
        next.cycle = null;
        // Produto ou cor que saiu do site (ou foi desativado) sai da conferência.
        if (!cycle.error) {
            const keepAfter = Date.parse(cycle.started_at) - 24 * 60 * 60 * 1000;
            for (const group of ["products", "variants"]) {
                for (const [id, entry] of Object.entries(state.snapshot[group])) {
                    if (!(Date.parse(entry?.at || "") >= keepAfter)) delete next.snapshot[group][id];
                }
            }
            for (const id of Object.keys(next.links)) if (!next.snapshot.variants[id]) delete next.links[id];
        }
    }
    await writeOlistStockState(next).catch(error => console.error("Olist → site — status não salvo:", error.message));
    if (changesNow.length) console.log("📦 Site atualizado pela Olist:", changesNow);
    return { done: finished, state: next, cycle_id: cycle.id, changes: changesNow };
}

// Na hora da compra: confere na Olist as peças do carrinho, dentro das chamadas que
// sobram na requisição. Se a Olist estiver fora do ar ou demorar, a compra segue com
// o estoque do site.
async function checkCartAgainstOlistStock(entries, budget) {
    if (!OLIST_SYNC_ENABLED || !entries.length) return null;
    const deadline = Date.now() + 6000;
    try {
        await withTimeout(ensureOlistAccess(budget), 3000);
    } catch (error) {
        console.warn("Checkout — estoque da Olist não conferido:", error.message);
        return null;
    }
    for (const { item, variant } of entries) {
        if (!safeString(variant?.sku)) continue;
        const left = deadline - Date.now();
        if (left < 400 || !budget.has(6)) break;
        try {
            const { available, found } = await withTimeout(olistAvailableForVariant(variant, budget), left);
            if (!found || available === null) continue;
            if (available < Number(variant.stock || 0) && budget.has(2)) {
                await lowerSiteStock(variant, available, "Estoque da Olist na hora da compra: " + available + " disponível", budget).catch(error => console.error("Checkout — estoque não baixado:", error.message));
            }
            if (available < Number(item.quantity || 0)) return { item, variant, available };
        } catch (error) {
            console.warn("Checkout — estoque da Olist indisponível, seguindo com o do site:", error.message);
            break;
        }
    }
    return null;
}

function olistStockStatusPayload(state) {
    const summary = cycle => cycle ? {
        id: cycle.id, started_at: cycle.started_at, finished_at: cycle.finished_at || null, trigger: cycle.trigger,
        products: cycle.products || 0, checked: cycle.checked || 0, errors: cycle.errors || 0, error: cycle.error || "",
        changes: cycle.changes || cycle.lowered || [], not_found: cycle.not_found || [], duplicates: cycle.duplicates || []
    } : null;
    return { last: summary(state?.last), cycle: summary(state?.cycle), running: Number(state?.lease_until || 0) > Date.now(), settings: state?.settings || OLIST_SYNC_DEFAULT_SETTINGS };
}

// Conferência para o painel: cada produto ativo do site, com o que a última rodada viu na Olist.
async function olistConferenceRows(state) {
    const products = await supabaseRequest(
        "products?select=id,name,price,sale_price,is_sale,is_presale,product_variants(id,color,sku,stock,active)&active=eq.true&order=name.asc",
        { method: "GET" }
    );
    const snapshot = state.snapshot || { products: {}, variants: {} };
    return (Array.isArray(products) ? products : []).map(product => {
        const seen = snapshot.products[product.id] || null;
        return {
            id: product.id,
            name: product.name,
            presale: product.is_presale === true,
            price: Number(product.price),
            sale_price: product.is_sale && product.sale_price !== null ? Number(product.sale_price) : null,
            olist: seen && { st: seen.st, price: seen.price, promo: seen.promo, note: seen.note || "", at: seen.at },
            variants: (product.product_variants || [])
                .filter(variant => variant.active !== false)
                .sort((a, b) => safeString(a.color).localeCompare(safeString(b.color), "pt-BR"))
                .map(variant => {
                    const entry = snapshot.variants[variant.id] || null;
                    return {
                        id: variant.id, color: variant.color, sku: variant.sku, stock: Number(variant.stock || 0),
                        olist: entry && { st: entry.st, available: entry.olist ?? null, reserved: entry.res || 0, waiting: entry.pend || 0, target: entry.target ?? null, at: entry.at }
                    };
                })
        };
    });
}

app.get("/api/admin/olist/stock-sync", requireAdmin, async (req, res) => {
    try {
        const state = await readOlistStockState();
        const conference = req.query.conference === "1" ? await olistConferenceRows(state) : undefined;
        return res.json({ success: true, enabled: OLIST_SYNC_ENABLED, ...olistStockStatusPayload(state), conference });
    } catch (error) {
        console.error("Olist → site — status:", error);
        return res.status(500).json({ success: false, message: "Não foi possível ler a última sincronização." });
    }
});

// O painel chama em sequência: a primeira com restart, as seguintes com o id da rodada,
// até done. Cada chamada confere um lote (no Cloudflare, 50 chamadas por requisição).
app.post("/api/admin/olist/stock-sync", requireAdmin, async (req, res) => {
    try {
        const result = await syncOlistStockBatch({
            trigger: "painel",
            restart: req.body?.restart === true,
            cycleId: safeString(req.body?.cycle),
            maxMs: 25 * 1000
        });
        if (result.skipped === "disabled") return res.status(409).json({ success: false, message: "A integração com a Olist está desligada neste servidor." });
        if (result.skipped === "running") return res.json({ success: true, waiting: true, done: false, ...olistStockStatusPayload(result.state) });
        if (result.skipped) return res.status(503).json({ success: false, message: "Não foi possível conferir agora. Tente de novo em instantes." });
        return res.json({ success: true, done: result.done, cycle_id: result.cycle_id, ...olistStockStatusPayload(result.state) });
    } catch (error) {
        console.error("Olist → site — painel:", error);
        return res.status(500).json({ success: false, message: "Não foi possível conferir a Olist agora." });
    }
});

// Opções do painel: atualizar preço/promoção e cores pela Olist (o estoque é sempre atualizado).
app.put("/api/admin/olist/sync-settings", requireAdmin, async (req, res) => {
    try {
        const settings = { prices: req.body?.prices !== false, colors: req.body?.colors !== false };
        await supabaseRequest("kv_store_48db9b7e?on_conflict=key", {
            method: "POST",
            headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({ key: OLIST_SYNC_SETTINGS_KEY, value: settings })
        });
        return res.json({ success: true, settings });
    } catch (error) {
        console.error("Olist → site — opções:", error);
        return res.status(500).json({ success: false, message: "Não foi possível salvar as opções." });
    }
});

app.put("/api/admin/products/:id/variants",requireAdmin,async(req,res)=>{
    try{
        const productId=safeString(req.params.id);
        const variants=Array.isArray(req.body?.variants)?req.body.variants:[];
        if(!/^[0-9a-f-]{36}$/i.test(productId)) return res.status(400).json({success:false,message:"Produto inválido."});
        if(variants.length>50) return res.status(400).json({success:false,message:"Quantidade de variações excede o limite."});

        const existing=await supabaseRequest(
            `product_variants?product_id=eq.${encodeURIComponent(productId)}&select=id,color,sku,stock,active`
        );
        const incomingIds=new Set(variants.map(v=>safeString(v.id)).filter(Boolean));

        for(const old of (existing||[])){
            if(!incomingIds.has(old.id)){
                if(Number(old.stock||0)>0){
                    return res.status(409).json({
                        success:false,
                        message:`A variação "${old.color}" possui estoque. Zere o estoque antes de removê-la.`
                    });
                }
                await supabaseRequest(
                    `product_variants?id=eq.${encodeURIComponent(old.id)}`,
                    {method:"DELETE",headers:{"Prefer":"return=minimal"}}
                );
            }
        }

        for(const v of variants){
            const color=safeString(v.color);
            const sku=safeString(v.sku)||null;
            const active=v.active!==false;
            const requestedStock=Number(v.stock);

            if(!color) continue;
            if(color.length>80 || (sku && sku.length>80) || !Number.isInteger(requestedStock) || requestedStock<0 || requestedStock>100000){
                return res.status(400).json({success:false,message:"Dados de variação ou estoque inválidos."});
            }

            if(v.id){
                const current=(existing||[]).find(x=>x.id===v.id);
                if(!current) return res.status(404).json({success:false,message:"Variação não encontrada."});

                await supabaseRequest(
                    `product_variants?id=eq.${encodeURIComponent(v.id)}`,
                    {
                        method:"PATCH",
                        body:JSON.stringify({color,sku,active})
                    }
                );

                const currentStock=Number(current.stock||0);
                const delta=requestedStock-currentStock;
                if(delta!==0){
                    await supabaseRequest("rpc/adjust_product_variant_stock",{
                        method:"POST",
                        body:JSON.stringify({
                            p_variant_id:v.id,
                            p_delta:delta,
                            p_movement_type:"adjustment",
                            p_reason:"Atualização de estoque pelo painel administrativo",
                            p_created_by:req.adminSession.email
                        })
                    });
                }
            }else{
                const created=await supabaseRequest("product_variants",{
                    method:"POST",
                    body:JSON.stringify({product_id:productId,color,sku,stock:0,active})
                });
                const createdVariant=Array.isArray(created)?created[0]:created;
                if(requestedStock>0){
                    await supabaseRequest("rpc/adjust_product_variant_stock",{
                        method:"POST",
                        body:JSON.stringify({
                            p_variant_id:createdVariant.id,
                            p_delta:requestedStock,
                            p_movement_type:"restock",
                            p_reason:"Estoque inicial pelo painel administrativo",
                            p_created_by:req.adminSession.email
                        })
                    });
                }
            }
        }

        return res.json({success:true});
    }catch(e){
        console.error("Admin variants PUT:",e);
        const msg=String(e.message||"");
        if(msg.includes("Estoque insuficiente")) return res.status(400).json({success:false,message:"Estoque insuficiente para este ajuste."});
        return res.status(500).json({success:false,message:"Não foi possível atualizar as variações."});
    }
});
app.get("/api/admin/orders",requireAdmin,async(req,res)=>{try{const d=await supabaseRequest("orders?select=*,order_items(*),payments(*)&order=created_at.desc");return res.json({success:true,orders:d||[]})}catch(e){console.error("Admin orders GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar os pedidos."})}});




/* =====================================================
   PRÉ-VENDA — A LOJA ACEITA OU RECUSA O PEDIDO
   Pedido com bolsa em pré-venda (vendida mesmo sem estoque) chega pago com
   approval_status "pending" e não vai para a Olist.
   - Aceito: segue o fluxo normal (Olist, separação, envio) e a cliente recebe um e-mail.
   - Recusado: vira "cancelled", o estoque baixado de outras peças volta, a cliente
     recebe um e-mail e o estorno fica pendente até a loja marcar como feito. A API de
     checkout da InfinitePay (links e payment_check) não tem estorno: ele é feito no app.
===================================================== */
function orderEmailItems(order) {
    return (Array.isArray(order.items) ? order.items : []).map(item => ({
        name: safeString(item.name || item.description) || "Produto",
        color: safeString(item.variant_color),
        quantity: Math.max(1, Number(item.quantity || 1)),
        price: Number(item.price || 0),
        image: null
    }));
}

async function sendOrderNoticeEmail(order, { type, subject, eyebrow, title, paragraphs, footnote }) {
    if (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !isEmailAddress(order.customer_email)) return { sent: false };
    const code = formatOrderCode(order.order_code || order.order_nsu);
    const url = PUBLIC_SITE_URL + "/minhas-compras.html?order_nsu=" + encodeURIComponent(code);
    await sendReminderEmail({
        to: safeString(order.customer_email).toLowerCase(),
        subject: subject.replace("{code}", code),
        type,
        idempotencyKey: "monte-" + type + "-" + order.order_nsu,
        html: reminderEmailHtml({ eyebrow, title, paragraphs, items: orderEmailItems(order), buttonUrl: url, buttonText: "VER MEU PEDIDO", footnote }),
        text: [title, ...paragraphs, "Pedido: " + code, url].join("\n\n")
    });
    return { sent: true };
}

async function orderForDecision(id) {
    if (!/^\d{1,12}$/.test(safeString(id))) return null;
    const rows = await supabaseRequest("orders?id=eq." + encodeURIComponent(id) + "&select=*,order_items(*)&limit=1", { method: "GET" });
    return Array.isArray(rows) ? rows[0] : null;
}

app.post("/api/admin/orders/:id/approve", requireAdmin, async (req, res) => {
    try {
        const order = await orderForDecision(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
        if (order.approval_status !== "pending") return res.status(409).json({ success: false, message: "Este pedido não está aguardando aprovação." });
        if (order.status !== "paid") return res.status(409).json({ success: false, message: "O pedido ainda não foi pago." });
        const now = new Date().toISOString();
        const rows = await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id) + "&approval_status=eq.pending", {
            method: "PATCH",
            body: JSON.stringify({ approval_status: "accepted", approval_decided_at: now, updated_at: now })
        });
        if (!Array.isArray(rows) || !rows[0]) return res.status(409).json({ success: false, message: "O pedido mudou enquanto você decidia. Atualize a lista." });
        // Agora o pedido segue para a Olist (aqui, ou pelo envio automático a cada minuto).
        runInBackground(processPendingOlistOrder({ ...order, ...rows[0] }));
        const firstName = reminderFirstName(order.customer_name);
        const email = await sendOrderNoticeEmail(order, {
            type: "presale_accepted",
            subject: "MONTÊ — Pré-venda confirmada: pedido {code}",
            eyebrow: "PRÉ-VENDA CONFIRMADA",
            title: "Sua bolsa está garantida" + (firstName ? ", " + firstName : "") + "!",
            paragraphs: [
                "Confirmamos o seu pedido de pré-venda. Assim que as peças chegarem, ele é preparado e enviado.",
                "A entrega é em " + PRESALE_MIN_BUSINESS_DAYS + " dias úteis. Você recebe o código de rastreio quando o pedido sair."
            ],
            footnote: "Dúvidas? É só responder este e-mail."
        }).catch(error => { console.error("E-mail de pré-venda aceita:", error.message); return { sent: false }; });
        return res.json({ success: true, order: rows[0], email_sent: email.sent });
    } catch (error) {
        console.error("Aceitar pedido:", error);
        return res.status(500).json({ success: false, message: "Não foi possível aceitar o pedido." });
    }
});

app.post("/api/admin/orders/:id/reject", requireAdmin, async (req, res) => {
    try {
        const reason = safeString(req.body?.reason).slice(0, 300);
        const order = await orderForDecision(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
        if (order.approval_status !== "pending") return res.status(409).json({ success: false, message: "Este pedido não está aguardando aprovação." });
        const paid = order.status === "paid";
        const now = new Date().toISOString();
        const rows = await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id) + "&approval_status=eq.pending", {
            method: "PATCH",
            body: JSON.stringify({
                status: "cancelled",
                approval_status: "rejected",
                approval_decided_at: now,
                cancel_reason: reason || null,
                refund_status: paid ? "pending" : null,
                updated_at: now
            })
        });
        if (!Array.isArray(rows) || !rows[0]) return res.status(409).json({ success: false, message: "O pedido mudou enquanto você decidia. Atualize a lista." });

        // Peças do pedido que não são de pré-venda tiveram o estoque baixado no pagamento: voltam.
        if (order.stock_decremented) {
            const presale = new Set((Array.isArray(order.items) ? order.items : []).filter(item => item?.presale === true).map(item => String(item.variant_id)));
            for (const item of Array.isArray(order.order_items) ? order.order_items : []) {
                if (!item.variant_id || presale.has(String(item.variant_id)) || !(Number(item.quantity) > 0)) continue;
                await supabaseRequest("rpc/adjust_product_variant_stock", {
                    method: "POST",
                    body: JSON.stringify({ p_variant_id: item.variant_id, p_delta: Number(item.quantity), p_movement_type: "restock", p_reason: "Pedido " + formatOrderCode(order.order_code || order.order_nsu) + " recusado", p_created_by: "admin" })
                }).catch(error => console.error("Estoque do pedido recusado:", error.message));
            }
            await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), { method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ stock_decremented: false }) });
        }
        publicCache.delete("catalog");

        const firstName = reminderFirstName(order.customer_name);
        const total = formatEmailMoney(order.total);
        const pix = safeString(order.payment_method).toLowerCase() === "pix";
        const email = await sendOrderNoticeEmail(order, {
            type: "presale_rejected",
            subject: "MONTÊ — Pedido {code} cancelado",
            eyebrow: "PEDIDO CANCELADO",
            title: "Não vamos conseguir atender o seu pedido" + (firstName ? ", " + firstName : "") + ".",
            paragraphs: [
                "Sentimos muito: o seu pedido de pré-venda foi cancelado." + (reason ? " Motivo: " + reason : ""),
                paid
                    ? "O valor de " + total + " será devolvido integralmente, " + (pix ? "na conta que fez o Pix." : "como estorno no cartão (o prazo para aparecer na fatura depende do banco).") + " Avisamos por e-mail quando o estorno for feito."
                    : "Como o pagamento não tinha sido concluído, nada foi cobrado."
            ],
            footnote: "Dúvidas? É só responder este e-mail."
        }).catch(error => { console.error("E-mail de pedido recusado:", error.message); return { sent: false }; });

        const payment = (await supabaseRequest("payments?order_id=eq." + encodeURIComponent(order.id) + "&select=transaction_nsu,invoice_slug,capture_method,receipt_url,paid_amount&limit=1", { method: "GET" }).catch(() => []))?.[0] || null;
        return res.json({ success: true, order: rows[0], email_sent: email.sent, refund: paid ? { amount: Number(order.total || 0), payment_method: order.payment_method, transaction_nsu: payment?.transaction_nsu || order.transaction_nsu || null, receipt_url: payment?.receipt_url || order.receipt_url || null } : null });
    } catch (error) {
        console.error("Recusar pedido:", error);
        return res.status(500).json({ success: false, message: "Não foi possível recusar o pedido." });
    }
});

app.post("/api/admin/orders/:id/refund-done", requireAdmin, async (req, res) => {
    try {
        const order = await orderForDecision(req.params.id);
        if (!order) return res.status(404).json({ success: false, message: "Pedido não encontrado." });
        if (order.status !== "cancelled" || order.refund_status !== "pending") return res.status(409).json({ success: false, message: "Este pedido não tem estorno pendente." });
        const now = new Date().toISOString();
        const rows = await supabaseRequest("orders?id=eq." + encodeURIComponent(order.id) + "&refund_status=eq.pending", {
            method: "PATCH",
            body: JSON.stringify({ refund_status: "done", refund_done_at: now, updated_at: now })
        });
        if (!Array.isArray(rows) || !rows[0]) return res.status(409).json({ success: false, message: "O pedido mudou. Atualize a lista." });
        const firstName = reminderFirstName(order.customer_name);
        const email = await sendOrderNoticeEmail(order, {
            type: "refund_done",
            subject: "MONTÊ — Estorno do pedido {code} realizado",
            eyebrow: "ESTORNO REALIZADO",
            title: "Seu estorno foi feito" + (firstName ? ", " + firstName : "") + ".",
            paragraphs: [
                "Devolvemos " + formatEmailMoney(order.total) + " referente ao pedido cancelado.",
                safeString(order.payment_method).toLowerCase() === "pix"
                    ? "No Pix, o valor volta para a conta que fez o pagamento."
                    : "No cartão, o estorno aparece na fatura conforme o prazo do seu banco."
            ],
            footnote: "Dúvidas? É só responder este e-mail."
        }).catch(error => { console.error("E-mail de estorno:", error.message); return { sent: false }; });
        return res.json({ success: true, order: rows[0], email_sent: email.sent });
    } catch (error) {
        console.error("Estorno feito:", error);
        return res.status(500).json({ success: false, message: "Não foi possível registrar o estorno." });
    }
});

app.patch("/api/admin/orders/:id/status",requireAdmin,async(req,res)=>{
    try{
        const id=encodeURIComponent(req.params.id);
        const status=safeString(req.body?.status).toLowerCase();
        const allowed=["pending","expired","paid","processing","shipped","delivered"];
        if(!allowed.includes(status)) return res.status(400).json({success:false,message:"Status inválido."});
        const current=(await supabaseRequest(`orders?id=eq.${id}&select=status,approval_status`,{method:"GET"}))?.[0];
        if(!current) return res.status(404).json({success:false,message:"Pedido não encontrado."});
        if(current.status==="cancelled") return res.status(409).json({success:false,message:"Este pedido foi cancelado."});
        if(current.approval_status==="pending"&&["processing","shipped","delivered"].includes(status)) return res.status(409).json({success:false,message:"Pedido de pré-venda: aceite ou recuse o pedido primeiro."});
        const patch={status,updated_at:new Date().toISOString()};
        if(status==="processing") patch.processing_at=new Date().toISOString();
        if(status==="shipped"){
            patch.shipping_carrier=safeString(req.body?.shipping_carrier)||null;
            patch.tracking_code=safeString(req.body?.tracking_code)||null;
            const trackingUrl=safeString(req.body?.tracking_url);
            if(trackingUrl&&!/^https:\/\/[^\s"'<>]+$/i.test(trackingUrl))return res.status(400).json({success:false,message:"O link de rastreio precisa começar com https://."});
            patch.tracking_url=trackingUrl||null;
            if(!patch.tracking_code) return res.status(400).json({success:false,message:"Informe o código de rastreio para marcar como enviado."});
            patch.shipped_at=new Date().toISOString();
        }
        if(status==="delivered") patch.delivered_at=new Date().toISOString();
        const d=await supabaseRequest(`orders?id=eq.${id}`,{method:"PATCH",body:JSON.stringify(patch)});
        if(!Array.isArray(d)||!d[0]) return res.status(404).json({success:false,message:"Pedido não encontrado."});

        let whatsapp = null;
        const savedOrder = d[0];
        if (status === "shipped" && savedOrder.tracking_code && !savedOrder.whatsapp_tracking_sent_at) {
            try {
                whatsapp = await sendWhatsAppTrackingNotification(savedOrder);
                await supabaseRequest(`orders?id=eq.${id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                        whatsapp_tracking_status: whatsapp.status,
                        whatsapp_tracking_sent_at: whatsapp.sent ? new Date().toISOString() : null,
                        whatsapp_tracking_message_id: whatsapp.message_id
                    })
                });
            } catch (whatsappError) {
                console.error("WhatsApp rastreio:", whatsappError);
                whatsapp = { sent: false, status: "error", message_id: null, error: whatsappError.message };
                await supabaseRequest(`orders?id=eq.${id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ whatsapp_tracking_status: "error" })
                }).catch(() => {});
            }
        }

        return res.json({success:true,order:{...savedOrder, ...(whatsapp ? {whatsapp_tracking_status:whatsapp.status, whatsapp_tracking_message_id:whatsapp.message_id}: {})},whatsapp});
    }catch(e){console.error("Admin order status PATCH:",e);return res.status(500).json({success:false,message:"Não foi possível atualizar o pedido."})}
});

app.post("/api/admin/orders/:id/tracking-whatsapp",requireAdmin,async(req,res)=>{
    try{
        const id=encodeURIComponent(req.params.id);
        const rows=await supabaseRequest(`orders?id=eq.${id}&select=*`,{method:"GET"});
        const order=Array.isArray(rows)?rows[0]:null;
        if(!order) return res.status(404).json({success:false,message:"Pedido não encontrado."});
        if(order.status!=="shipped" || !order.tracking_code) return res.status(400).json({success:false,message:"O pedido precisa estar como enviado e ter código de rastreio."});
        if(!order.customer_whatsapp && !order.customer_phone) return res.status(400).json({success:false,message:"O pedido não possui telefone para WhatsApp."});
        const result=await sendWhatsAppTrackingNotification(order);
        await supabaseRequest(`orders?id=eq.${id}`,{
            method:"PATCH",
            body:JSON.stringify({
                whatsapp_tracking_status: result.status,
                whatsapp_tracking_sent_at: result.sent ? new Date().toISOString() : null,
                whatsapp_tracking_message_id: result.message_id
            })
        });
        return res.json({success:true,whatsapp:result});
    }catch(e){
        console.error("Admin WhatsApp tracking:",e);
        await supabaseRequest(`orders?id=eq.${encodeURIComponent(req.params.id)}`,{method:"PATCH",body:JSON.stringify({whatsapp_tracking_status:"error"})}).catch(()=>{});
        return res.status(500).json({success:false,message:"Não foi possível enviar a atualização pelo WhatsApp.",error:process.env.NODE_ENV==="development"?e.message:undefined});
    }
});

app.post("/api/admin/orders/:id/tracking-email",requireAdmin,async(req,res)=>{
    try{
        const id=encodeURIComponent(req.params.id);
        const rows=await supabaseRequest(`orders?id=eq.${id}&select=*`,{method:"GET"});
        const order=Array.isArray(rows)?rows[0]:null;
        if(!order) return res.status(404).json({success:false,message:"Pedido não encontrado."});
        if(order.status==="pending") return res.status(400).json({success:false,message:"O pedido precisa ter um pagamento confirmado antes de enviar uma atualização por e-mail."});
        if(order.status==="shipped" && !order.tracking_code) return res.status(400).json({success:false,message:"Informe o código de rastreio antes de enviar o e-mail de envio."});

        const result=await sendOrderTrackingEmail(order);
        await supabaseRequest(`orders?id=eq.${id}`,{
            method:"PATCH",
            body:JSON.stringify({
                tracking_email_status: result.status,
                tracking_email_sent_at: result.sent ? new Date().toISOString() : null,
                tracking_email_message_id: result.message_id || null
            })
        });
        return res.json({success:true,email:result});
    }catch(e){
        console.error("Admin tracking email:",e);
        await supabaseRequest(`orders?id=eq.${encodeURIComponent(req.params.id)}`,{
            method:"PATCH",
            body:JSON.stringify({tracking_email_status:"error"})
        }).catch(()=>{});
        return res.status(500).json({success:false,message:"Não foi possível enviar a atualização por e-mail.",error:process.env.NODE_ENV==="development"?e.message:undefined});
    }
});

app.get("/api/admin/stock/movements",requireAdmin,async(req,res)=>{
    try{
        const d=await supabaseRequest("inventory_movements?select=*,product_variants(id,color,sku,product_id,products(name))&order=created_at.desc&limit=100");
        return res.json({success:true,movements:d||[]});
    }catch(e){console.error("Admin stock movements GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar o histórico de estoque."})}
});

app.post("/api/admin/stock/adjust",requireAdmin,async(req,res)=>{
    try{
        const variantId=safeString(req.body?.variant_id);
        const delta=Number(req.body?.delta);
        const type=safeString(req.body?.movement_type)||"adjustment";
        const reason=safeString(req.body?.reason);
        if(!variantId||!Number.isInteger(delta)||delta===0) return res.status(400).json({success:false,message:"Informe uma variação e uma quantidade inteira diferente de zero."});
        if(!["restock","adjustment","correction"].includes(type)) return res.status(400).json({success:false,message:"Tipo de movimentação inválido."});
        const result=await supabaseRequest("rpc/adjust_product_variant_stock",{
            method:"POST",
            body:JSON.stringify({p_variant_id:variantId,p_delta:delta,p_movement_type:type,p_reason:reason,p_created_by:req.adminSession.email})
        });
        return res.json({success:true,variant:Array.isArray(result)?result[0]:result});
    }catch(e){
        console.error("Admin stock adjustment POST:",e);
        const msg=String(e.message||"");
        if(msg.includes("Estoque insuficiente")) return res.status(400).json({success:false,message:"Estoque insuficiente para este ajuste."});
        return res.status(500).json({success:false,message:"Não foi possível ajustar o estoque."});
    }
});


/* =====================================================
   ÁREA GERENCIAL
   Rota explícita para o painel. O Render executa o backend em /backend,
   enquanto admin.html permanece na raiz do repositório.
===================================================== */
app.get("/admin", (req, res) => { res.setHeader("Content-Security-Policy", ADMIN_CONTENT_SECURITY_POLICY); return sendSitePage(res, "admin.html"); });

app.get("/admin/", (req, res) => { res.setHeader("Content-Security-Policy", ADMIN_CONTENT_SECURITY_POLICY); return sendSitePage(res, "admin.html"); });


/* =====================================================
   TESTE DO SERVIDOR
===================================================== */

// Catálogo e carrossel da página inicial ficam 60 s na memória da instância: a maioria
// das visitas não espera o Supabase. Mudanças no painel limpam a memória desta instância.
const publicCache = new Map();
async function cachedPublic(key, ttlMs, load) {
    const hit = publicCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await load();
    publicCache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
}
async function getPublicCatalog() {
    return cachedPublic("catalog", 60 * 1000, async () => {
        const rows = await supabaseRequest("products?select=*,product_variants(*)&active=eq.true&order=created_at.desc", { method: "GET" });
        return (Array.isArray(rows) ? rows : []).map(product => {
            const { images_original, ...publicProduct } = product;
            if (Array.isArray(publicProduct.images)) publicProduct.images = publicProduct.images.map(siteMediaPath);
            return publicProduct;
        });
    });
}
app.get("/api/catalogo", async (req, res) => {
    try {
        res.setHeader("Cache-Control", "public, max-age=30");
        return res.json({ success: true, products: await getPublicCatalog() });
    } catch (error) {
        console.error("Catálogo público:", error);
        return res.status(500).json({ success: false, message: "Não foi possível carregar os produtos." });
    }
});

// JSON dentro de <script type="application/json">: "<" vira \u003c para nunca fechar a tag.
function jsonForHtml(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function escapeAttribute(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function editorialSlidesHtml(slides) {
    return slides.map((slide, i) => '<figure class="editorial-slide' + (i === 0 ? " active" : "") + '"' + (i === 0 ? "" : ' aria-hidden="true"') + '><img src="' + escapeAttribute(slide.src) + '"' +
        (slide.srcset ? ' srcset="' + escapeAttribute(slide.srcset) + '" sizes="(max-width: 1023px) 100vw, 62vw"' : "") +
        ' width="2000" height="1000" loading="lazy" decoding="async" alt="MONTÊ — Mais que bolsas."></figure>').join("");
}
function heroSlidesHtml(slides) {
    return slides.map((slide, i) => {
        const size = slide.width && slide.height ? ' width="' + slide.width + '" height="' + slide.height + '"' : "";
        const srcset = slide.small ? ' srcset="' + escapeAttribute(slide.small) + ' 960w, ' + escapeAttribute(slide.src) + ' 2000w" sizes="100vw"' : "";
        const priority = i === 0 ? ' fetchpriority="high"' : ' loading="lazy"';
        return '<div class="slide' + (i === 0 ? " active" : "") + '"><img src="' + escapeAttribute(slide.src) + '"' + srcset + size + priority + ' decoding="async" alt="MONTÊ — Novidades"></div>';
    }).join("");
}

// Página inicial: o servidor já entrega o banner (com tamanho e prioridade) e os produtos
// dentro do HTML. A loja aparece sem esperar outras requisições e o banner não empurra a página.
app.get("/", async (req, res) => {
    try {
        const [html, catalog, slides, editorial] = await Promise.all([
            readSitePage("index.html"),
            getPublicCatalog().catch(error => { console.error("Página inicial — catálogo:", error.message); return null; }),
            cachedPublic("carousel", 60 * 1000, carouselSlides).catch(error => { console.error("Página inicial — carrossel:", error.message); return null; }),
            cachedPublic("editorial", 60 * 1000, readEditorialImages).catch(error => { console.error("Página inicial — banner do meio:", error.message); return null; })
        ]);
        let page = html;
        // Banner do meio: com fotos do painel, troca as do HTML; data-ssr evita que a página peça de novo.
        if (Array.isArray(editorial)) {
            if (editorial.length) page = page.replace(/<!-- BANNER DO MEIO -->[\s\S]*?<!-- FIM DO BANNER DO MEIO -->/, () => editorialSlidesHtml(editorialSlides(editorial)));
            page = page.replace('<div class="editorial-carousel" id="editorialCarousel"', '<div class="editorial-carousel" id="editorialCarousel" data-ssr="1"');
        }
        if (Array.isArray(slides) && slides.length) {
            page = page
                .replace(/<!-- SLIDES -->[\s\S]*?<!-- FIM DOS SLIDES -->/, () => heroSlidesHtml(slides))
                .replace('<div id="carouselSlides"', '<div id="carouselSlides" data-ssr="1"');
            const first = slides[0];
            const preload = '<link rel="preload" as="image" href="' + escapeAttribute(first.src) + '"' +
                (first.small ? ' imagesrcset="' + escapeAttribute(first.small) + ' 960w, ' + escapeAttribute(first.src) + ' 2000w" imagesizes="100vw"' : "") + ' fetchpriority="high">';
            page = page.replace("<!-- PRELOAD DO BANNER -->", () => preload);
        }
        if (Array.isArray(catalog)) {
            page = page.replace("<!-- CATÁLOGO -->", () => '<script id="catalogData" type="application/json">' + jsonForHtml(catalog) + "</script>");
        }
        res.setHeader("Cache-Control", "no-cache");
        return res.status(200).type("html").send(page);
    } catch (error) {
        console.error("Página inicial:", error);
        return sendSitePage(res, "index.html");
    }
});


/* =====================================================
   NORMALIZAR TEXTO
===================================================== */

function safeString(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value).trim();
}

/* =====================================================
   CUPONS DE DESCONTO
   Cadastrados no painel: porcentagem ou valor em R$, com validade
   e limite de pessoas (1 = cupom único). A mesma pessoa (CPF ou e-mail)
   nunca usa o mesmo cupom duas vezes. As regras ficam no Supabase
   (backend/sql/cupons.sql): check_coupon confere e claim_coupon
   registra o uso no pedido com trava, para dois checkouts ao mesmo
   tempo não usarem um cupom único.
   O desconto vale só para as peças (o frete fica integral) e, no Pix,
   incide depois do desconto do Pix.
===================================================== */

// Cada peça continua custando pelo menos R$ 1,00 no checkout da InfinitePay.
const COUPON_MIN_UNIT_CENTS = 100;
const COUPON_MAX_FIXED_VALUE = 100000;
const COUPON_REASON_MESSAGES = {
    invalid: "Cupom inválido.",
    not_started: "Este cupom ainda não está valendo.",
    expired: "Este cupom expirou.",
    already_used: "Você já usou este cupom.",
    exhausted: "Este cupom já foi utilizado."
};

function normalizeCouponCode(value) {
    return typeof value === "string" ? value.replace(/\s+/g, "").toUpperCase() : "";
}

function isValidCouponCode(code) {
    return /^[A-Z0-9_-]{3,30}$/.test(code);
}

function couponMessage(reason) {
    return COUPON_REASON_MESSAGES[reason] || COUPON_REASON_MESSAGES.invalid;
}

// Desconto do cupom, em centavos, sobre o valor das peças (já com o Pix, se for o caso).
function couponDiscountCents(coupon, productCents, units) {
    const value = Number(coupon?.discount_value);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const raw = coupon.discount_type === "percent"
        ? Math.round(productCents * Math.min(value, 100) / 100)
        : Math.round(value * 100);
    return Math.max(0, Math.min(raw, productCents - units * COUPON_MIN_UNIT_CENTS));
}

// Divide o desconto entre as linhas da sacola (proporcional ao valor de cada uma), em
// centavos inteiros. A InfinitePay cobra quantidade × preço unitário: quando o desconto
// de uma linha não divide igual entre as unidades, ela vira duas (parte com 1 centavo a
// menos) e a soma fecha exatamente o total do pedido.
// lines: [{ quantity, unitCents }] → para cada linha, [{ quantity, unit_cents }].
function splitCouponDiscount(lines, discountCents) {
    const totals = lines.map(line => line.unitCents * line.quantity);
    const capacity = lines.map(line => Math.max(0, line.quantity * (line.unitCents - COUPON_MIN_UNIT_CENTS)));
    const sum = totals.reduce((a, b) => a + b, 0);
    const shares = lines.map((line, i) => sum > 0 ? Math.min(capacity[i], Math.floor(discountCents * totals[i] / sum)) : 0);
    let left = discountCents - shares.reduce((a, b) => a + b, 0);
    for (let i = 0; left > 0 && i < lines.length; i++) {
        const extra = Math.min(left, capacity[i] - shares[i]);
        shares[i] += extra;
        left -= extra;
    }
    return lines.map((line, i) => {
        const each = Math.floor(shares[i] / line.quantity);
        const rest = shares[i] % line.quantity;
        return [
            { quantity: rest, unit_cents: line.unitCents - each - 1 },
            { quantity: line.quantity - rest, unit_cents: line.unitCents - each }
        ].filter(part => part.quantity > 0);
    });
}

async function checkCoupon(code, cpf, email) {
    return supabaseRequest("rpc/check_coupon", {
        method: "POST",
        body: JSON.stringify({ p_code: code, p_cpf: cpf || null, p_email: email || null })
    });
}

const couponRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 10
});

// A sacola confere o cupom antes do pagamento para mostrar o desconto.
// O valor cobrado é sempre recalculado no /api/criar-checkout.
app.post("/api/cupom", couponRateLimit, async (req, res) => {
    try {
        const code = normalizeCouponCode(req.body?.code);
        if (!isValidCouponCode(code)) {
            return res.status(400).json({ success: false, message: couponMessage("invalid") });
        }
        const cpf = typeof req.body?.cpf === "string" ? req.body.cpf.replace(/\D/g, "") : "";
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const result = await checkCoupon(
            code,
            cpf.length === 11 ? cpf : null,
            email.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
        );
        if (!result?.ok) {
            return res.status(400).json({ success: false, message: couponMessage(result?.reason) });
        }
        return res.json({
            success: true,
            coupon: {
                code: result.coupon.code,
                discount_type: result.coupon.discount_type,
                discount_value: Number(result.coupon.discount_value)
            }
        });
    } catch (error) {
        console.error("Cupom:", error);
        return res.status(500).json({ success: false, message: "Não foi possível conferir o cupom agora." });
    }
});

// Campos do cupom enviados pelo painel. Devolve { coupon } ou { error }.
function sanitizeCouponPayload(body, { partial = false } = {}) {
    const b = body || {};
    const coupon = {};
    const has = key => Object.prototype.hasOwnProperty.call(b, key);

    if (!partial || has("code")) {
        const code = normalizeCouponCode(b.code);
        if (!isValidCouponCode(code)) return { error: "O código precisa ter de 3 a 30 letras, números, - ou _." };
        coupon.code = code;
    }
    if (!partial || has("discount_type") || has("discount_value")) {
        const type = safeString(b.discount_type);
        const value = Number(b.discount_value);
        if (!["percent", "fixed"].includes(type)) return { error: "Escolha desconto em % ou em R$." };
        if (!Number.isFinite(value) || value <= 0) return { error: "Informe o valor do desconto." };
        if (type === "percent" && value > 100) return { error: "A porcentagem vai até 100%." };
        if (type === "fixed" && value > COUPON_MAX_FIXED_VALUE) return { error: "Valor de desconto muito alto." };
        coupon.discount_type = type;
        coupon.discount_value = Number(value.toFixed(2));
    }
    if (!partial || has("max_uses")) {
        const maxUses = b.max_uses === undefined || b.max_uses === null || b.max_uses === "" ? 1 : Number(b.max_uses);
        if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) return { error: "O limite de pessoas precisa ser um número inteiro a partir de 1." };
        coupon.max_uses = maxUses;
    }
    for (const key of ["starts_at", "expires_at"]) {
        if (partial && !has(key)) continue;
        const raw = safeString(b[key]);
        if (!raw) { coupon[key] = null; continue; }
        const time = new Date(raw);
        if (Number.isNaN(time.getTime())) return { error: "Data de validade inválida." };
        coupon[key] = time.toISOString();
    }
    if (coupon.starts_at && coupon.expires_at && coupon.expires_at <= coupon.starts_at) {
        return { error: "O fim da validade precisa ser depois do início." };
    }
    if (!partial || has("active")) coupon.active = b.active === undefined ? true : b.active === true;
    if (!partial || has("note")) coupon.note = safeString(b.note).slice(0, 200) || null;
    return { coupon };
}

function couponSaveError(error) {
    const text = String(error?.message || "");
    if (text.includes("23505") || text.includes("coupons_code_key")) return "Já existe um cupom com esse código.";
    if (text.includes("coupons_valid_window")) return "O fim da validade precisa ser depois do início.";
    return "Não foi possível salvar o cupom.";
}

app.get("/api/admin/coupons", requireAdmin, async (req, res) => {
    try {
        const data = await supabaseRequest(
            "coupons?select=*,coupon_redemptions(id,customer_name,customer_email,customer_cpf,discount_amount,created_at,orders(id,order_code,order_nsu,status,total))" +
            "&order=created_at.desc&coupon_redemptions.order=created_at.desc",
            { method: "GET" }
        );
        return res.json({ success: true, coupons: data || [] });
    } catch (error) {
        console.error("Admin cupons GET:", error);
        return res.status(500).json({ success: false, message: "Não foi possível carregar os cupons." });
    }
});

app.post("/api/admin/coupons", requireAdmin, async (req, res) => {
    try {
        const { coupon, error } = sanitizeCouponPayload(req.body);
        if (error) return res.status(400).json({ success: false, message: error });
        const saved = await supabaseRequest("coupons", { method: "POST", body: JSON.stringify(coupon) });
        return res.status(201).json({ success: true, coupon: saved?.[0] || saved });
    } catch (error) {
        console.error("Admin cupons POST:", error);
        return res.status(couponSaveError(error).startsWith("Já existe") ? 409 : 500).json({ success: false, message: couponSaveError(error) });
    }
});

app.patch("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
    try {
        const id = encodeURIComponent(req.params.id);
        const { coupon, error } = sanitizeCouponPayload(req.body, { partial: true });
        if (error) return res.status(400).json({ success: false, message: error });
        const current = (await supabaseRequest(`coupons?id=eq.${id}&select=*,coupon_redemptions(id)`, { method: "GET" }))?.[0];
        if (!current) return res.status(404).json({ success: false, message: "Cupom não encontrado." });
        // Depois do primeiro uso, o código e o desconto ficam como estavam: o histórico
        // mostra o que cada cliente usou. Para mudar, crie outro cupom.
        const used = (current.coupon_redemptions || []).length > 0;
        const changesTerms = ["code", "discount_type", "discount_value"].some(key =>
            key in coupon && String(coupon[key]) !== String(key === "discount_value" ? Number(current[key]) : current[key])
        );
        if (used && changesTerms) {
            return res.status(409).json({ success: false, message: "Este cupom já foi usado: o código e o desconto não mudam mais. Crie um novo cupom." });
        }
        const startsAt = "starts_at" in coupon ? coupon.starts_at : current.starts_at;
        const expiresAt = "expires_at" in coupon ? coupon.expires_at : current.expires_at;
        if (startsAt && expiresAt && new Date(expiresAt) <= new Date(startsAt)) {
            return res.status(400).json({ success: false, message: "O fim da validade precisa ser depois do início." });
        }
        const saved = await supabaseRequest(`coupons?id=eq.${id}`, {
            method: "PATCH",
            body: JSON.stringify({ ...coupon, updated_at: new Date().toISOString() })
        });
        return res.json({ success: true, coupon: saved?.[0] || saved });
    } catch (error) {
        console.error("Admin cupons PATCH:", error);
        return res.status(couponSaveError(error).startsWith("Já existe") ? 409 : 500).json({ success: false, message: couponSaveError(error) });
    }
});

app.delete("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
    try {
        const id = encodeURIComponent(req.params.id);
        const current = (await supabaseRequest(`coupons?id=eq.${id}&select=id,coupon_redemptions(id)`, { method: "GET" }))?.[0];
        if (!current) return res.status(404).json({ success: false, message: "Cupom não encontrado." });
        if ((current.coupon_redemptions || []).length) {
            return res.status(409).json({ success: false, message: "Este cupom já foi usado e fica no histórico. Desative-o para ninguém mais usar." });
        }
        await supabaseRequest(`coupons?id=eq.${id}`, { method: "DELETE" });
        return res.json({ success: true });
    } catch (error) {
        console.error("Admin cupons DELETE:", error);
        return res.status(500).json({ success: false, message: "Não foi possível excluir o cupom." });
    }
});

/* =====================================================
   PROMOÇÕES DE PRESENTE (cadastradas no painel, aba Promoções)
   Compra com as peças somando pelo menos min_subtotal (preço de
   tabela, antes do Pix e do cupom; o frete não conta) ganha uma peça
   da categoria da promoção, à escolha da cliente, entre as ativas com
   estoque. A loja define início e fim. Com mais de uma promoção no ar,
   elas viram degraus: vale o presente do maior degrau alcançado.
   O presente entra no pedido com preço zero: baixa o estoque como as
   outras peças, mas não vai para a InfinitePay.
   Tabela: backend/sql/promocoes.sql.
===================================================== */
const PROMOTION_CATEGORIES = { cintos: "cinto", acessorios: "acessório", bolsas: "bolsa" };

const isGiftItem = item => item?.gift === true;
const orderGiftItems = order => (Array.isArray(order?.items) ? order.items : []).filter(isGiftItem);

// Promoções ativas que ainda não acabaram (as agendadas também, para o cache servir quando
// elas começarem). Quem usa filtra pelo horário com promotionLive.
async function loadPromotions() {
    const rows = await supabaseRequest(
        "promotions?active=eq.true&ends_at=gt." + encodeURIComponent(new Date().toISOString()) +
        "&select=id,name,min_subtotal,gift_category,starts_at,ends_at,banner_text,terms_text&order=min_subtotal.asc",
        { method: "GET" }
    );
    return Array.isArray(rows) ? rows : [];
}

function promotionLive(promotion, now = Date.now()) {
    return Date.parse(promotion.starts_at) <= now && now < Date.parse(promotion.ends_at);
}

// O degrau alcançado: a promoção no ar de maior valor mínimo que as peças cobrem.
function reachedPromotion(promotions, productsSubtotal, now = Date.now()) {
    return promotions
        .filter(promotion => promotionLive(promotion, now) && productsSubtotal >= Number(promotion.min_subtotal))
        .sort((a, b) => Number(b.min_subtotal) - Number(a.min_subtotal))[0] || null;
}

// Página da loja: promoções no ar agora e os benefícios fixos (frete grátis e Pix).
app.get("/api/promocoes", async (req, res) => {
    const benefits = await storeBenefits();
    try {
        const promotions = await cachedPublic("promotions", 30 * 1000, loadPromotions);
        res.setHeader("Cache-Control", "public, max-age=30");
        return res.json({
            success: true,
            benefits,
            promotions: promotions.filter(promotion => promotionLive(promotion)).map(promotion => ({
                id: promotion.id,
                name: promotion.name,
                min_subtotal: Number(promotion.min_subtotal),
                gift_category: promotion.gift_category,
                ends_at: promotion.ends_at,
                banner_text: promotion.banner_text || null,
                terms_text: promotion.terms_text || null
            }))
        });
    } catch (error) {
        console.error("Promoções:", error);
        return res.json({ success: true, benefits, promotions: [] });
    }
});

// Presente escolhido pela cliente, conferido no cadastro: peça ativa da categoria da
// promoção, fora da pré-venda, com a cor ativa e em estoque. Devolve o item do pedido ou null.
async function loadGiftProduct(promotion, productId, variantId) {
    const rows = await supabaseRequest(
        "products?id=eq." + encodeURIComponent(productId) +
        "&active=eq.true&is_presale=eq.false&category=eq." + encodeURIComponent(promotion.gift_category) +
        "&select=id,name,product_variants(id,color,sku,stock,active,olist_product_id)" +
        "&product_variants.id=eq." + encodeURIComponent(variantId),
        { method: "GET" }
    );
    const product = Array.isArray(rows) ? rows[0] : null;
    const variant = product?.product_variants?.[0];
    if (!product || !variant || variant.active === false || Number(variant.stock || 0) < 1) return null;
    return {
        item: {
            id: product.id,
            name: product.name,
            description: product.name + " (presente)",
            sku: variant.sku || null,
            variant_id: variant.id,
            variant_color: variant.color || null,
            variant_sku: variant.sku || null,
            quantity: 1,
            price: 0,
            presale: false,
            gift: true,
            promotion_id: promotion.id,
            promotion_name: promotion.name,
            promotion_terms: promotion.terms_text || null
        },
        variant
    };
}

// Promoções no painel. Devolve { promotion } ou { error }.
function sanitizePromotionPayload(body, { partial = false } = {}) {
    const b = body || {};
    const promotion = {};
    const has = key => Object.prototype.hasOwnProperty.call(b, key);
    if (!partial || has("name")) {
        const name = safeString(b.name);
        if (name.length < 2 || name.length > 80) return { error: "Dê um nome à promoção (até 80 letras)." };
        promotion.name = name;
    }
    if (!partial || has("min_subtotal")) {
        const min = Number(b.min_subtotal);
        if (!Number.isFinite(min) || min <= 0 || min > 100000) return { error: "Informe o valor mínimo em peças." };
        promotion.min_subtotal = Number(min.toFixed(2));
    }
    if (!partial || has("gift_category")) {
        const category = safeString(b.gift_category);
        if (!PROMOTION_CATEGORIES[category]) return { error: "Escolha a categoria do presente." };
        promotion.gift_category = category;
    }
    for (const key of ["starts_at", "ends_at"]) {
        if (partial && !has(key)) continue;
        const time = new Date(safeString(b[key]));
        if (!safeString(b[key]) || Number.isNaN(time.getTime())) return { error: key === "starts_at" ? "Informe quando a promoção começa." : "Informe quando a promoção termina." };
        promotion[key] = time.toISOString();
    }
    if (promotion.starts_at && promotion.ends_at && promotion.ends_at <= promotion.starts_at) {
        return { error: "O fim precisa ser depois do início." };
    }
    if (!partial || has("banner_text")) {
        const banner = safeString(b.banner_text);
        if (banner.length > 90) return { error: "O aviso da barra do topo vai até 90 letras." };
        promotion.banner_text = banner || null;
    }
    if (!partial || has("terms_text")) {
        const terms = safeString(b.terms_text);
        if (terms.length > 200) return { error: "O aviso sobre o presente vai até 200 letras." };
        promotion.terms_text = terms || null;
    }
    if (!partial || has("active")) promotion.active = b.active === undefined ? true : b.active === true;
    return { promotion };
}

// Frete grátis e desconto do Pix (painel, aba Promoções).
app.put("/api/admin/store-benefits", requireAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const min = Number(b.free_shipping?.min_subtotal);
        const percent = Number(b.pix_discount?.percent);
        if (!Number.isFinite(min) || min <= 0 || min > 100000) {
            return res.status(400).json({ success: false, message: "Informe o valor mínimo do frete grátis." });
        }
        if (!Number.isFinite(percent) || percent <= 0 || percent > 50) {
            return res.status(400).json({ success: false, message: "O desconto do Pix precisa ser de 0,01% a 50%." });
        }
        const benefits = normalizeStoreBenefits({
            free_shipping: { enabled: b.free_shipping?.enabled === true, min_subtotal: min },
            pix_discount: { enabled: b.pix_discount?.enabled === true, percent }
        });
        await supabaseRequest("kv_store_48db9b7e?on_conflict=key", {
            method: "POST",
            headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({ key: STORE_BENEFITS_KEY, value: benefits })
        });
        publicCache.delete("store_benefits");
        return res.json({ success: true, benefits });
    } catch (error) {
        console.error("Admin benefícios PUT:", error);
        return res.status(500).json({ success: false, message: "Não foi possível salvar." });
    }
});

app.get("/api/admin/promotions", requireAdmin, async (req, res) => {
    try {
        const benefits = await loadStoreBenefits();
        const promotions = await supabaseRequest("promotions?select=*&order=starts_at.desc", { method: "GET" });
        // Pedidos que levaram o presente de cada promoção (o item guarda promotion_id).
        const list = Array.isArray(promotions) ? promotions : [];
        const orders = await Promise.all(list.map(promotion => supabaseRequest(
            "orders?items=cs." + encodeURIComponent(JSON.stringify([{ promotion_id: promotion.id }])) +
            "&select=id,order_code,order_nsu,customer_name,status,total,items,created_at&order=created_at.desc&limit=200",
            { method: "GET" }
        ).catch(() => [])));
        return res.json({
            success: true,
            benefits,
            promotions: list.map((promotion, index) => ({
                ...promotion,
                orders: (orders[index] || []).map(order => ({
                    id: order.id,
                    order_code: order.order_code,
                    order_nsu: order.order_nsu,
                    customer_name: order.customer_name,
                    status: order.status,
                    total: order.total,
                    created_at: order.created_at,
                    gifts: orderGiftItems(order).filter(item => item.promotion_id === promotion.id)
                        .map(item => ({ name: item.name, color: item.variant_color || null }))
                }))
            }))
        });
    } catch (error) {
        console.error("Admin promoções GET:", error);
        return res.status(500).json({ success: false, message: "Não foi possível carregar as promoções." });
    }
});

app.post("/api/admin/promotions", requireAdmin, async (req, res) => {
    try {
        const { promotion, error } = sanitizePromotionPayload(req.body);
        if (error) return res.status(400).json({ success: false, message: error });
        const saved = await supabaseRequest("promotions", { method: "POST", body: JSON.stringify(promotion) });
        publicCache.delete("promotions");
        return res.status(201).json({ success: true, promotion: saved?.[0] || saved });
    } catch (error) {
        console.error("Admin promoções POST:", error);
        return res.status(500).json({ success: false, message: "Não foi possível salvar a promoção." });
    }
});

app.patch("/api/admin/promotions/:id", requireAdmin, async (req, res) => {
    try {
        const id = encodeURIComponent(req.params.id);
        const { promotion, error } = sanitizePromotionPayload(req.body, { partial: true });
        if (error) return res.status(400).json({ success: false, message: error });
        const current = (await supabaseRequest(`promotions?id=eq.${id}&select=starts_at,ends_at`, { method: "GET" }))?.[0];
        if (!current) return res.status(404).json({ success: false, message: "Promoção não encontrada." });
        const startsAt = promotion.starts_at || current.starts_at;
        const endsAt = promotion.ends_at || current.ends_at;
        if (Date.parse(endsAt) <= Date.parse(startsAt)) {
            return res.status(400).json({ success: false, message: "O fim precisa ser depois do início." });
        }
        const saved = await supabaseRequest(`promotions?id=eq.${id}`, {
            method: "PATCH",
            body: JSON.stringify({ ...promotion, updated_at: new Date().toISOString() })
        });
        publicCache.delete("promotions");
        return res.json({ success: true, promotion: saved?.[0] || saved });
    } catch (error) {
        console.error("Admin promoções PATCH:", error);
        return res.status(500).json({ success: false, message: "Não foi possível salvar a promoção." });
    }
});

// Os pedidos guardam o nome da promoção no item do presente: o histórico continua.
app.delete("/api/admin/promotions/:id", requireAdmin, async (req, res) => {
    try {
        await supabaseRequest(`promotions?id=eq.${encodeURIComponent(req.params.id)}`, { method: "DELETE" });
        publicCache.delete("promotions");
        return res.json({ success: true });
    } catch (error) {
        console.error("Admin promoções DELETE:", error);
        return res.status(500).json({ success: false, message: "Não foi possível excluir a promoção." });
    }
});

/* =====================================================
   CRIAR CHECKOUT
   COM PEDIDO SALVO ANTES DO PAGAMENTO
===================================================== */

app.post("/api/frete/cotacao", shippingQuoteRateLimit, async (req,res)=>{
    try{
        const toCep=safeString(req.body?.to_cep||req.body?.cep).replace(/\D/g,"");
        // Cada produto vira uma consulta ao banco: no máximo 20, e só ids válidos.
        const items=(Array.isArray(req.body?.items)?req.body.items:[])
            .filter(item=>item&&typeof item==="object"&&/^[0-9a-f-]{36}$/i.test(safeString(item.id||item.product_id)))
            .slice(0,20)
            .map(item=>({id:safeString(item.id||item.product_id),quantity:Math.min(20,Math.max(1,Math.floor(Number(item.quantity)||1)))}));
        const city=normalizeCity(req.body?.city||"");
        const state=safeString(req.body?.state||"").toUpperCase();
        if(toCep.length!==8)return res.status(400).json({success:false,message:"CEP de destino inválido."});
        const local=isLocalDeliveryCep(toCep)?localShippingOption(city,state):null;
        if(local)return res.json({success:true,source:"monte",options:[local]});
        const options=await calculateSuperfreteQuotes({toCep,items});
        if(!options.length)return res.status(422).json({success:false,message:"Nenhuma modalidade de frete disponível para este CEP."});
        return res.json({success:true,source:"superfrete",options});
    }catch(error){console.error("❌ Erro na cotação SuperFrete:",error);return res.status(502).json({success:false,message:"Não foi possível calcular o frete agora. Tente novamente em instantes."});}
});

app.post("/api/newsletter", newsletterRateLimit, async (req, res) => {
    try {
        if (!RESEND_API_KEY) {
            return res.status(503).json({ success: false, message: "Newsletter não configurada." });
        }

        const email = safeString(req.body?.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, message: "Informe um e-mail válido." });
        }

        // Cadastra o contato diretamente na lista Geral da MONTÊ.
        const segmentId = "a58fa01c-4292-4ba7-ac63-7928f68567c6";
        const response = await fetch("https://api.resend.com/contacts", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + RESEND_API_KEY,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                email,
                unsubscribed: false,
                segment_ids: [segmentId]
            })
        });

        const responseText = await response.text();
        let data = {};
        try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { raw: responseText }; }

        if (!response.ok && response.status !== 409) {
            throw new Error("Resend Contacts API " + response.status + ": " + JSON.stringify(data));
        }

        const alreadyRegistered = response.status === 409;

        // Envia confirmação de cadastro somente para um novo inscrito.
        if (!alreadyRegistered && RESEND_MARKETING_FROM_EMAIL) {
            const welcomeHtml =
                "<!doctype html><html><body style=\"margin:0;padding:0;background:#f4f2ef;color:#171717;font-family:Arial,Helvetica,sans-serif\">" +
                "<div style=\"max-width:640px;margin:0 auto;padding:34px 18px\">" +
                "<div style=\"background:#111;padding:28px 24px;text-align:center\"><div style=\"color:#fff;font-size:25px;letter-spacing:7px;font-weight:600\">MONTÊ</div><div style=\"color:#cfcac3;font-size:10px;letter-spacing:3px;margin-top:9px\">BOLSAS & ACESSÓRIOS</div></div>" +
                "<div style=\"background:#fff;padding:44px 38px 40px\">" +
                "<p style=\"margin:0 0 14px;color:#8a847d;font-size:10px;letter-spacing:2.5px\">CADASTRO CONFIRMADO</p>" +
                "<h1 style=\"margin:0 0 18px;font-size:30px;line-height:1.2;font-weight:500\">Bem-vinda à MONTÊ.</h1>" +
                "<p style=\"margin:0;color:#555;font-size:15px;line-height:1.8\">Seu cadastro foi realizado com sucesso. A partir de agora, você receberá novidades, lançamentos e conteúdos selecionados da MONTÊ.</p>" +
                "<div style=\"margin:30px 0;border-top:1px solid #e8e5e1;border-bottom:1px solid #e8e5e1;padding:22px 0\"><p style=\"margin:0;color:#777;font-size:13px;line-height:1.7\">Prepare-se para conhecer novas coleções, peças e histórias da marca antes de todo mundo.</p></div>" +
                "<div style=\"text-align:center;margin:30px 0 8px\"><a href=\"https://oficialmontee.com.br\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:15px 28px;font-size:11px;letter-spacing:2px\">VISITAR A MONTÊ</a></div>" +
                "</div><div style=\"padding:22px;text-align:center;color:#999;font-size:10px;line-height:1.6\">MONTÊ — Bolsas & acessórios<br>Você recebeu este e-mail porque se cadastrou para receber novidades da marca.<br>Para sair da lista, use o link de descadastro dos nossos e-mails ou fale com a gente pelo WhatsApp (85) 99216-3305.</div>" +
                "</div></body></html>";

            const welcomeResponse = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + RESEND_API_KEY,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({
                    from: RESEND_FROM_NAME + " <" + RESEND_MARKETING_FROM_EMAIL + ">",
                    to: [email],
                    subject: "MONTÊ — cadastro confirmado",
                    html: welcomeHtml
                })
            });

            const welcomeText = await welcomeResponse.text();
            let welcomeData = {};
            try { welcomeData = welcomeText ? JSON.parse(welcomeText) : {}; } catch { welcomeData = { raw: welcomeText }; }

            if (!welcomeResponse.ok) {
                console.error("Newsletter welcome email:", welcomeResponse.status, welcomeData);
            }
        }

        return res.json({
            success: true,
            status: alreadyRegistered ? "already_registered" : "subscribed",
            email_sent: !alreadyRegistered && Boolean(RESEND_MARKETING_FROM_EMAIL)
        });
    } catch (error) {
        console.error("Newsletter:", error);
        return res.status(500).json({ success: false, message: "Não foi possível concluir o cadastro agora." });
    }
});

/* =====================================================
   CHECKOUT REPETIDO
   Antes, cada toque em FINALIZAR criava um pedido novo (uma cliente gerou
   12 pedidos em 23 minutos). Agora a mesma compra, em até 1 hora, devolve o
   mesmo pedido e o mesmo link de pagamento. Pedido cujo pagamento não abriu
   deixa de ficar "aguardando pagamento" (e não recebe lembrete).
===================================================== */
const CHECKOUT_REUSE_MS = 60 * 60 * 1000;

// Mesma compra = mesma cliente, endereço, peças, frete, forma de pagamento, cupom e presente.
// Qualquer mudança (outra cor, outro e-mail, outro endereço) gera um pedido novo.
function checkoutFingerprint({ customer, items, shippingServiceId, paymentMethod, couponCode, gift }) {
    const text = value => safeString(value).trim().toLowerCase();
    const digits = value => String(value ?? "").replace(/\D/g, "");
    const address = customer?.address || {};
    const lines = (Array.isArray(items) ? items : [])
        .filter(item => String(item.sku || "").toUpperCase() !== "FRETE")
        .map(item => [text(item.id || item.product_id), text(item.variant_id), Number(item.quantity) || 0])
        .sort((a, b) => (a[0] + "|" + a[1]).localeCompare(b[0] + "|" + b[1]));
    const data = {
        name: text(customer?.name),
        email: text(customer?.email),
        phone: digits(customer?.phone),
        cpf: digits(customer?.cpf),
        address: [digits(address.cep), text(address.street), text(address.number), text(address.complement), text(address.neighborhood), text(address.city), text(address.state)],
        lines,
        shipping: text(shippingServiceId),
        payment: text(paymentMethod),
        coupon: text(couponCode),
        gift: gift ? [text(gift.promotion_id), text(gift.product_id), text(gift.variant_id)] : null
    };
    return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

// Pedido da mesma compra, ainda aguardando pagamento, com o link da InfinitePay salvo.
// Se a busca falhar, o checkout segue normalmente (cria um pedido novo).
async function reusablePendingCheckout(fingerprint) {
    if (!/^[0-9a-f]{64}$/.test(String(fingerprint || ""))) return null;
    try {
        const rows = await supabaseRequest(
            "orders?checkout_fingerprint=eq." + fingerprint + "&status=eq.pending&checkout_url=not.is.null" +
            "&created_at=gt." + isoAgo(CHECKOUT_REUSE_MS) +
            "&select=id,order_nsu,order_code,checkout_url,total&order=created_at.desc&limit=1",
            { method: "GET" }
        );
        const order = Array.isArray(rows) ? rows[0] : null;
        if (!order || !infinitePayReceiptUrl(order.checkout_url)) return null;
        return { ...order, checkout_url: infinitePayReceiptUrl(order.checkout_url) };
    } catch (error) {
        console.error("Checkout repetido: busca do pedido anterior falhou:", error.message);
        return null;
    }
}

// Guarda o link de pagamento no pedido (para o mesmo toque devolver o mesmo link).
async function rememberCheckoutUrl(orderId, url) {
    const checkoutUrl = infinitePayReceiptUrl(url);
    if (!orderId || !checkoutUrl) return;
    try {
        await supabaseRequest("orders?id=eq." + encodeURIComponent(orderId), {
            method: "PATCH",
            headers: { "Prefer": "return=minimal" },
            body: JSON.stringify({ checkout_url: checkoutUrl })
        });
    } catch (error) {
        console.error("Checkout: não foi possível guardar o link de pagamento:", error.message);
    }
}

// O pagamento não abriu: o pedido não fica aguardando pagamento nem recebe lembrete.
async function closeFailedCheckoutOrder(orderId, orderNsu) {
    if (!orderId) return;
    const now = new Date().toISOString();
    try {
        await supabaseRequest("orders?id=eq." + encodeURIComponent(orderId) + "&status=eq.pending", {
            method: "PATCH",
            headers: { "Prefer": "return=minimal" },
            body: JSON.stringify({
                status: "expired",
                cancel_reason: "O pagamento não abriu",
                payment_reminder_status: "skipped_checkout_failed",
                payment_reminder_sent_at: now,
                store_followup_status: "skipped_checkout_failed",
                store_followup_sent_at: now,
                updated_at: now
            })
        });
    } catch (error) {
        console.error("Checkout: não foi possível encerrar o pedido sem pagamento", orderNsu, error.message);
    }
}

app.post(
    "/api/criar-checkout",
    checkoutRateLimit,
    async (req, res) => {

        // Pedido com cupom que não chegou ao pagamento: o cupom volta a valer.
        let releaseCoupon = async () => {};
        // Pedido salvo cujo pagamento não abriu: sai de "aguardando pagamento" (sem lembrete).
        let closeFailedOrder = async () => {};

        try {

            console.log(
                "🛒 Solicitação de checkout recebida."
            );

            const {
                items,
                customer,
                shipping_service_id: requestedShippingServiceId,
                payment_method: requestedPaymentMethod,
                coupon_code: requestedCouponCode,
                gift: requestedGift
            } = req.body || {};

            const paymentMethod = safeString(requestedPaymentMethod || "pix").toLowerCase();

            if (!["pix", "credit_card"].includes(paymentMethod)) {
                return res.status(400).json({
                    success: false,
                    message: "Forma de pagamento inválida."
                });
            }

            /* =================================================
               VALIDAÇÃO DO CARRINHO
            ================================================= */

            if (
                !Array.isArray(items) ||
                items.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Carrinho vazio."

                });

            }


            /* =================================================
               VALIDAÇÃO DO CLIENTE
            ================================================= */

            if (
                !customer ||
                !customer.name ||
                !customer.email ||
                !customer.phone ||
                !customer.cpf ||
                !customer.address ||
                !customer.address.cep ||
                !customer.address.street ||
                !customer.address.number ||
                !customer.address.neighborhood ||
                !customer.address.city ||
                !customer.address.state
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Preencha todos os dados do cliente e do endereço: CEP, rua, número, bairro, cidade e estado."

                });

            }


            const customerCpf = String(customer.cpf || "").replace(/\D/g, "");
            const customerEmail = safeString(customer.email).toLowerCase();
            const customerPhone = safeString(customer.phone);
            const customerWhatsapp = safeString(customer.whatsapp_phone).replace(/\D/g, "");
            const customerName = safeString(customer.name);
            const address = customer.address || {};

            // E-mail sem o ponto ("…@gmailcom") ou incompleto: a cliente vê o que corrigir.
            if (customerEmail.length > 160 || !isEmailAddress(customerEmail)) {
                return res.status(400).json({
                    success: false,
                    field: "customerEmail",
                    message: "Confira seu e-mail. Ex.: nome@gmail.com"
                });
            }

            if (
                customerName.length < 2 || customerName.length > 120 ||
                customerPhone.length < 8 || customerPhone.length > 30 ||
                customerCpf.length !== 11 ||
                customerWhatsapp.length > 30 ||
                safeString(address.cep).length > 12 ||
                safeString(address.street).length > 160 ||
                safeString(address.number).length > 30 ||
                safeString(address.complement).length > 120 ||
                safeString(address.neighborhood).length > 120 ||
                safeString(address.city).length > 100 ||
                safeString(address.state).length > 30
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Confira os dados informados no checkout."
                });
            }

            // Cada campo do cliente e do endereço precisa ser texto (um objeto passaria pelos
            // limites de tamanho e iria inteiro para o pedido e para a InfinitePay).
            const customerFields = [customer.name, customer.email, customer.phone, customer.cpf, customer.whatsapp_phone];
            const addressFields = ["cep", "street", "number", "complement", "neighborhood", "city", "state"].map(key => address[key]);
            if ([...customerFields, ...addressFields].some(value => value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number")) {
                return res.status(400).json({
                    success: false,
                    message: "Confira os dados informados no checkout."
                });
            }

            const phoneDigits = brazilMobileDigits(customer.phone);
            if (!phoneDigits) {
                return res.status(400).json({
                    success: false,
                    field: "customerPhone",
                    message: "Informe seu WhatsApp com DDD e 9 dígitos. Ex.: (85) 99999-9999."
                });
            }
            // Mesmo formato dos pedidos que a InfinitePay aceitou: (85) 99999-9999.
            const formattedPhone = `(${phoneDigits.slice(0, 2)}) ${phoneDigits.slice(2, 7)}-${phoneDigits.slice(7)}`;

            if (!isValidCpf(customerCpf)) {
                return res.status(400).json({
                    success: false,
                    field: "customerCpf",
                    message: "CPF inválido. Informe os 11 dígitos."
                });
            }

            const couponCode = normalizeCouponCode(requestedCouponCode);
            if (requestedCouponCode && !isValidCouponCode(couponCode)) {
                return res.status(400).json({
                    success: false,
                    coupon_invalid: true,
                    message: couponMessage("invalid")
                });
            }

            /* =================================================
               NORMALIZA PRODUTOS
            ================================================= */

            if (items.length > 20) {
                return res.status(400).json({
                    success: false,
                    message: "O pedido excede o limite de itens permitido."
                });
            }

            const normalizedItems =
                items
                    .map(
                        (item) => {

                            const quantity =
                                Number(item.quantity);

                            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
                                return null;
                            }


                            const price =
                                Number(item.price);

                            const productId = safeString(item.id || item.product_id);
                            if (!productId || !/^[0-9a-f-]{36}$/i.test(productId)) {
                                return null;
                            }


                            const description =
                                String(
                                    item.description ||
                                    item.name ||
                                    "Produto MONTÊ"
                                );


                            const sku =
                                String(
                                    item.sku ||
                                    ""
                                ).trim();


                            /*
                               Produto normal
                            */

                            if (
                                !Number.isFinite(
                                    price
                                ) ||
                                price <= 0
                            ) {

                                return null;

                            }


                            if (
                                !Number.isFinite(
                                    quantity
                                ) ||
                                quantity <= 0
                            ) {

                                return null;

                            }


                            /*
                               Para o fluxo de venda,
                               produtos precisam ter SKU.
                            */

                            if (
                                !sku
                            ) {

                                console.warn(
                                    "⚠️ Produto sem SKU:",
                                    description
                                );

                            }


                            return {

                                id:
                                    productId,

                                name:
                                    item.name ||
                                    description,

                                description:
                                    description,

                                sku:
                                    sku,

                                variant_id:
                                    item.variant_id ||
                                    null,

                                variant_color:
                                    item.variant_color ||
                                    null,

                                variant_sku:
                                    item.variant_sku ||
                                    null,

                                quantity:
                                    quantity,

                                price:
                                    Number(
                                        price.toFixed(2)
                                    )

                            };

                        }
                    )
                    .filter(
                        Boolean
                    );


            /* =================================================
               MESMA COMPRA TOCADA DE NOVO: MESMO PEDIDO
               A cliente voltou do pagamento ou tocou de novo em FINALIZAR com
               a mesma sacola e os mesmos dados: devolve o pedido e o link de
               pagamento que já existem, em vez de criar outro pedido.
            ================================================= */
            const fingerprint = checkoutFingerprint({
                customer,
                items: normalizedItems,
                shippingServiceId: requestedShippingServiceId,
                paymentMethod,
                couponCode,
                gift: requestedGift
            });
            const reusable = await reusablePendingCheckout(fingerprint);
            if (reusable) {
                console.log("🔁 Checkout repetido: mesmo pedido e mesmo link de pagamento.", reusable.order_nsu);
                return res.status(200).json({
                    success: true,
                    reused: true,
                    ...(paymentMethod === "pix" ? { pix_checkout: true } : {}),
                    url: reusable.checkout_url,
                    amount: Number(reusable.total),
                    order_nsu: reusable.order_nsu,
                    order_code: String(reusable.order_code || ""),
                    status: "pending"
                });
            }


            /* =================================================
               RECALCULA PREÇOS NO SERVIDOR
               Nunca confia no preço salvo no navegador.
            ================================================= */
            // Uma consulta só para todos os produtos: no Cloudflare cada requisição faz
            // no máximo 50 chamadas externas, e a sacola pode ter até 20 itens.
            const priceKey = item => safeString(item.id || item.product_id).toLowerCase();
            const priceIds = [...new Set(normalizedItems.filter(item => String(item.sku || "").toUpperCase() !== "FRETE").map(priceKey))];
            const priceRows = priceIds.length ? await supabaseRequest(
                "products?id=in.(" + priceIds.map(encodeURIComponent).join(",") + ")" +
                "&active=eq.true&select=id,name,price,sale_price,is_sale,is_presale"
            ) : [];
            const pricedProducts = new Map((Array.isArray(priceRows) ? priceRows : []).map(row => [String(row.id).toLowerCase(), row]));
            for (const item of normalizedItems) {
                if (String(item.sku || "").toUpperCase() === "FRETE") continue;
                const product = pricedProducts.get(priceKey(item)) || null;
                if (!product) {
                    return res.status(400).json({success:false,message:"Produto inválido ou indisponível."});
                }
                const serverPrice = product.is_sale && product.sale_price != null ? Number(product.sale_price) : Number(product.price);
                if (!Number.isFinite(serverPrice) || serverPrice <= 0) {
                    return res.status(400).json({success:false,message:"Produto sem preço válido."});
                }
                item.price = Number(serverPrice.toFixed(2));
                item.presale = product.is_presale === true;
                item.name = product.name || item.name;
                item.description = product.name || item.description;
            }

            /* =================================================
               CONFIRMA PRODUTOS VÁLIDOS
            ================================================= */

            if (
                normalizedItems.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Nenhum produto válido foi encontrado."

                });

            }


            /* =================================================
               FRETE
            ================================================= */

            // Frete: Fortaleza capital R$ 15,00.
            // O backend calcula novamente para não confiar no navegador.
            const productItems =
                normalizedItems.filter(
                    item =>
                        String(item.sku || "").toUpperCase() !== "FRETE"
                );

            const deliveryCity = normalizeCity(customer.address.city);
            const deliveryState = safeString(customer.address.state).toUpperCase();
            const localShipping = localShippingOption(deliveryCity, deliveryState);
            // A entrega MONTÊ (e o frete grátis dela) vale só para CEP de Fortaleza e região.
            if (localShipping && !isLocalDeliveryCep(customer.address.cep)) {
                return res.status(400).json({
                    success: false,
                    message: "O CEP informado não é de Fortaleza ou da região metropolitana. Confira o CEP e a cidade."
                });
            }
            let shippingOption = null;

            if (localShipping) {
                shippingOption = localShipping;
            } else {
                const shippingServiceId = safeString(requestedShippingServiceId);
                if (!shippingServiceId) {
                    return res.status(400).json({
                        success: false,
                        message: "Selecione uma modalidade de frete."
                    });
                }

                const quotes = await calculateSuperfreteQuotes({
                    toCep: customer.address.cep,
                    items: productItems
                });

                shippingOption = quotes.find(option => option.id === shippingServiceId) || null;

                if (!shippingOption) {
                    return res.status(409).json({
                        success: false,
                        message: "A modalidade de frete selecionada não está mais disponível. Calcule o frete novamente."
                    });
                }
            }

            // Pedido com peça em pré-venda: entrega em PRESALE_MIN_BUSINESS_DAYS dias úteis (ou no prazo da transportadora, se maior).
            const hasPresale = productItems.some(item => item.presale);
            const baseDeliveryDays = Number(shippingOption.delivery_days || shippingOption.delivery_max_days) || null;
            const deliveryDays = hasPresale ? Math.max(PRESALE_MIN_BUSINESS_DAYS, baseDeliveryDays || 0) : baseDeliveryDays;

            // Frete grátis em Fortaleza e região a partir do valor do painel, nas peças (preço de tabela).
            const benefits = await storeBenefits();
            const productsSubtotal = productItems.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0);
            const shippingValue = Number(shippingChargeFor(shippingOption, productsSubtotal, benefits).toFixed(2));


            /* =================================================
               VERIFICA SE SOBROU PRODUTO
            ================================================= */

            if (
                productItems.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Nenhum produto foi encontrado no pedido."

                });

            }

            /* =================================================
               PRESENTE DA PROMOÇÃO (cadastrada no painel)
            ================================================= */
            let giftItem = null;
            let giftVariant = null;
            if (requestedGift) {
                const giftProductId = safeString(requestedGift.product_id);
                const giftVariantId = safeString(requestedGift.variant_id);
                const giftError = message => res.status(409).json({ success: false, gift_invalid: true, message });
                if (!/^[0-9a-f-]{36}$/i.test(giftProductId) || !/^[0-9a-f-]{36}$/i.test(giftVariantId)) {
                    return giftError("Escolha o seu presente de novo.");
                }
                // Sem cache: a promoção pode ter sido encerrada no painel agora há pouco.
                const promotion = reachedPromotion(await loadPromotions(), productsSubtotal);
                if (!promotion) {
                    return giftError("A promoção de presente não vale para esta compra agora.");
                }
                if (String(requestedGift.promotion_id) !== String(promotion.id)) {
                    return giftError("Sua compra alcançou outro presente. Escolha de novo.");
                }
                const gift = await loadGiftProduct(promotion, giftProductId, giftVariantId);
                if (!gift) {
                    return giftError("Esse presente acabou de esgotar. Escolha outro.");
                }
                giftItem = gift.item;
                giftVariant = gift.variant;
            }

            /* =================================================
               VALIDA VARIAÇÕES E ESTOQUE NO SUPABASE
            ================================================= */
            const checkedVariants = [];
            for (const item of productItems) {
                const productId = item.id || item.product_id || null;
                if (!productId) {
                    return res.status(400).json({
                        success: false,
                        message: "Produto inválido no pedido."
                    });
                }
                item.id = productId;

                // Se o produto tiver apenas uma variação ativa em estoque,
                // ela é selecionada automaticamente. A cliente não precisa
                // escolher uma cor/variação quando não existe uma escolha real.
                let variant = null;

                if (item.variant_id) {
                    const variants = await supabaseRequest(
                        "product_variants?id=eq." + encodeURIComponent(item.variant_id) +
                        "&product_id=eq." + encodeURIComponent(item.id) +
                        "&active=eq.true&select=id,color,sku,stock,olist_product_id",
                        { method: "GET" }
                    );

                    variant = Array.isArray(variants) ? variants[0] : null;
                } else {
                    const variants = await supabaseRequest(
                        "product_variants?product_id=eq." + encodeURIComponent(item.id) +
                        "&active=eq.true" + (item.presale ? "" : "&stock=gt.0") + "&select=id,color,sku,stock,olist_product_id&order=created_at.asc",
                        { method: "GET" }
                    );

                    if (Array.isArray(variants) && variants.length === 1) {
                        variant = variants[0];
                        item.variant_id = variant.id;
                    }
                }

                if (!variant) {
                    return res.status(400).json({
                        success: false,
                        message: "A variação selecionada não está disponível."
                    });
                }

                // Pré-venda é vendida mesmo sem estoque: a loja aceita ou recusa o pedido no painel.
                if (!item.presale && Number(variant.stock || 0) < Number(item.quantity || 0)) {
                    return res.status(409).json({
                        success: false,
                        message: "Estoque insuficiente para " + item.description +
                            (item.variant_color ? " (" + item.variant_color + ")" : "") + "."
                    });
                }

                item.variant_color = variant.color;
                // O SKU vem do cadastro, nunca do navegador (ele vai para a Olist e para o pedido).
                item.variant_sku = variant.sku || null;
                item.sku = variant.sku || null;
                checkedVariants.push({ item, variant });
            }

            // O presente conta junto: a mesma peça comprada e ganha precisa de 2 em estoque.
            if (giftItem) checkedVariants.push({ item: giftItem, variant: giftVariant });

            // A mesma cor em mais de uma linha da sacola: confere a soma das quantidades.
            const quantityByVariant = new Map();
            for (const { item, variant } of checkedVariants) {
                if (item.presale) continue;
                const total = (quantityByVariant.get(variant.id) || 0) + Number(item.quantity || 0);
                quantityByVariant.set(variant.id, total);
                if (total > Number(variant.stock || 0)) {
                    if (isGiftItem(item)) {
                        return res.status(409).json({
                            success: false,
                            gift_invalid: true,
                            message: "Esse presente acabou de esgotar. Escolha outro."
                        });
                    }
                    return res.status(409).json({
                        success: false,
                        message: "Estoque insuficiente para " + item.description +
                            (item.variant_color ? " (" + item.variant_color + ")" : "") + "."
                    });
                }
            }

            /* =================================================
               CUPOM — confere antes de criar o pedido
            ================================================= */
            let coupon = null;
            if (couponCode) {
                const couponResult = await checkCoupon(couponCode, customerCpf, customerEmail);
                if (!couponResult?.ok) {
                    return res.status(400).json({
                        success: false,
                        coupon_invalid: true,
                        message: couponMessage(couponResult?.reason)
                    });
                }
                coupon = couponResult.coupon;
            }

            // A peça pode ter sido vendida na Olist depois da última sincronização.
            // A conferência usa só as chamadas que sobram na requisição: cada peça já usou
            // 2 (variação e frete) e o resto do pedido usa umas 12 (busca de compra repetida,
            // preços, cotação do frete, número do pedido, pedido, itens, InfinitePay, link
            // salvo e folga) e mais 3 com cupom (conferência, registro do uso e uma possível liberação).
            // Peças em pré-venda ainda não chegaram: o estoque delas é o do site, não o da Olist.
            const olistShortage = await checkCartAgainstOlistStock(
                checkedVariants.filter(entry => !entry.item.presale),
                createCallBudget(WORKER_CALL_LIMIT - (coupon ? 15 : 12) - 2 * checkedVariants.length)
            );
            if (olistShortage) {
                const { item, available } = olistShortage;
                if (isGiftItem(item)) {
                    return res.status(409).json({
                        success: false,
                        gift_invalid: true,
                        message: "Esse presente acabou de esgotar. Escolha outro."
                    });
                }
                const name = item.description + (item.variant_color ? " (" + item.variant_color + ")" : "");
                return res.status(409).json({
                    success: false,
                    stock_changed: true,
                    message: available > 0
                        ? "Restam só " + available + " unidade" + (available > 1 ? "s" : "") + " de " + name + ". Ajuste a quantidade na sacola."
                        : name + " acabou de esgotar. Remova da sacola para continuar."
                });
            }


            /* =================================================
               ORDER NSU
            ================================================= */

            const orderNsu = `MONTE-${Date.now()}-${crypto.randomBytes(12).toString("hex")}`;

            const orderCodeRows = await supabaseRequest("rpc/next_monte_order_code", { method: "POST" });
            const orderCode = Array.isArray(orderCodeRows) ? orderCodeRows[0] : orderCodeRows;
            if (!orderCode || !/^\d{4,8}$/.test(String(orderCode))) {
                throw new Error("Não foi possível gerar o número de pedido da MONTÊ.");
            }


            /* =================================================
               SALVA O PEDIDO ANTES DO PAGAMENTO
            ================================================= */

            // Peças cobradas + o presente da promoção (preço zero, fora da InfinitePay).
            const orderLines = giftItem ? [...productItems, giftItem] : productItems;

            const pendingOrder = {

                order_nsu:
                    orderNsu,

                order_code:
                    String(orderCode),

                customer: {

                    name:
                        customerName,

                    email:
                        customerEmail,

                    phone:
                        formattedPhone,

                    whatsapp_phone:
                        customerWhatsapp,

                    whatsapp_updates:
                        customer.whatsapp_updates === true,

                    cpf:
                        customerCpf,

                    address:
                        customer.address
                            ? {

                                cep:
                                    customer.address.cep ||
                                    "",

                                street:
                                    customer.address.street ||
                                    "",

                                neighborhood:
                                    customer.address.neighborhood ||
                                    "",

                                number:
                                    customer.address.number ||
                                    "",

                                complement:
                                    customer.address.complement ||
                                    "",

                                city:
                                    customer.address.city ||
                                    "",

                                state:
                                    customer.address.state ||
                                    ""

                            }
                            : null

                },

                items:
                    orderLines,

                shipping: {
                    value: Number(shippingValue.toFixed(2)),
                    service_id: shippingOption.id,
                    service_name: shippingOption.name,
                    delivery_days: deliveryDays
                }
            };


            const subtotal = Number(productItems.reduce(
                (sum, item) => sum + Number(item.price) * Number(item.quantity), 0
            ).toFixed(2));

            // O desconto do Pix (percentual do painel) incide somente sobre os produtos.
            // O frete permanece integral.
            // Todos os valores são calculados em centavos a partir do mesmo preço
            // unitário enviado à InfinitePay. Assim o total salvo no pedido é
            // exatamente o valor cobrado e o payment_check do webhook confere.
            const pixPercent = pixPercentOf(benefits);
            const pixUnitCents = item => pixDiscountedUnitCents(item.price, pixPercent);
            const productUnitCents = item => paymentMethod === "pix"
                ? pixUnitCents(item)
                : Math.round(Number(item.price) * 100);
            const checkoutProductCents = productItems.reduce(
                (sum, item) => sum + productUnitCents(item) * Number(item.quantity), 0
            );
            const shippingCents = Math.round(shippingValue * 100);

            // Cupom: desconto nas peças, dividido entre as linhas em centavos inteiros.
            // Cada item guarda o que foi cobrado (charged_units, já com Pix e cupom) para a
            // InfinitePay e a Olist: o percentual do Pix pode mudar no painel depois.
            let couponCents = 0;
            const lines = productItems.map(item => ({ quantity: Number(item.quantity), unitCents: productUnitCents(item) }));
            let split = lines.map(line => [{ quantity: line.quantity, unit_cents: line.unitCents }]);
            if (coupon) {
                const units = productItems.reduce((sum, item) => sum + Number(item.quantity), 0);
                couponCents = couponDiscountCents(coupon, checkoutProductCents, units);
                split = splitCouponDiscount(lines, couponCents);
            }
            productItems.forEach((item, index) => { item.charged_units = split[index]; });
            const chargedLines = item => item.charged_units;

            const checkoutTotal = (checkoutProductCents - couponCents + shippingCents) / 100;

            const savedOrders = await supabaseRequest("orders", {
                method: "POST",
                body: JSON.stringify({
                    order_nsu: orderNsu,
                    order_code: String(orderCode),
                    customer_name: pendingOrder.customer.name,
                    customer_email: pendingOrder.customer.email,
                    customer_phone: pendingOrder.customer.phone,
                    customer_whatsapp: pendingOrder.customer.whatsapp_phone || "",
                    customer_cpf: pendingOrder.customer.cpf,
                    customer_address: pendingOrder.customer.address,
                    subtotal: Number(subtotal.toFixed(2)),
                    shipping: Number(shippingValue.toFixed(2)),
                    shipping_service_id: shippingOption.id,
                    shipping_service_name: shippingOption.name,
                    shipping_delivery_days: deliveryDays,
                    total: checkoutTotal,
                    status: "pending",
                    // Pré-venda: depois de pago, o pedido espera a loja aceitar ou recusar.
                    approval_status: hasPresale ? "pending" : null,
                    payment_method: paymentMethod,
                    whatsapp_tracking_opt_in: customer.whatsapp_updates === true,
                    whatsapp_tracking_status: customer.whatsapp_updates === true ? "pending" : "opted_out",
                    checkout_fingerprint: fingerprint,
                    ...(coupon ? { coupon_code: coupon.code, coupon_discount: couponCents / 100 } : {}),
                    items: orderLines
                })
            });

            const savedOrder = Array.isArray(savedOrders) ? savedOrders[0] : savedOrders;
            closeFailedOrder = () => closeFailedCheckoutOrder(savedOrder?.id, orderNsu);

            await supabaseRequest("order_items", {
                method: "POST",
                body: JSON.stringify(orderLines.map(item => ({
                    order_id: savedOrder.id,
                    product_id: item.id || null,
                    variant_id: item.variant_id || null,
                    variant_color: item.variant_color || null,
                    sku: item.variant_sku || item.sku || null,
                    product_name: item.name,
                    quantity: item.quantity,
                    unit_price: item.price,
                    total_price: Number((item.price * item.quantity).toFixed(2))
                })))
            });

            // Registra o uso do cupom com trava: se outra pessoa usou o cupom único entre a
            // conferência e agora, o pedido é desfeito e a cliente pode seguir sem o cupom.
            if (coupon) {
                const claim = await supabaseRequest("rpc/claim_coupon", {
                    method: "POST",
                    body: JSON.stringify({
                        p_coupon_id: coupon.id,
                        p_order_id: savedOrder.id,
                        p_cpf: customerCpf,
                        p_email: customerEmail,
                        p_name: customerName,
                        p_discount: couponCents / 100
                    })
                });
                if (!claim?.ok) {
                    await supabaseRequest(`orders?id=eq.${encodeURIComponent(savedOrder.id)}`, {
                        method: "DELETE",
                        headers: { "Prefer": "return=minimal" }
                    });
                    return res.status(409).json({
                        success: false,
                        coupon_invalid: true,
                        message: couponMessage(claim?.reason)
                    });
                }
                releaseCoupon = async () => {
                    try {
                        await supabaseRequest(`coupon_redemptions?order_id=eq.${encodeURIComponent(savedOrder.id)}`, {
                            method: "DELETE",
                            headers: { "Prefer": "return=minimal" }
                        });
                    } catch (error) {
                        console.error("Cupom: não foi possível liberar o uso do pedido", orderNsu, error.message);
                    }
                };
            }

            /* =================================================
               PIX — CHECKOUT INDEPENDENTE DA INFINITEPAY
               O Pix usa um checkout próprio da InfinitePay.
               O desconto do Pix incide somente nos produtos;
               o frete permanece com o valor integral.
            ================================================= */
            if (paymentMethod === "pix") {
                const pixItems = productItems.flatMap(item => chargedLines(item).map(line => ({
                    quantity: line.quantity,
                    price: line.unit_cents,
                    description: item.description
                })));

                if (shippingValue > 0) {
                    pixItems.push({
                        quantity: 1,
                        price: shippingCents,
                        description: shippingOption.name
                    });
                }

                const pixPayload = {
                    handle: INFINITEPAY_HANDLE,
                    order_nsu: orderNsu,
                    redirect_url:
                        `${SITE_URL}/pagamento-sucesso?order_nsu=${encodeURIComponent(orderNsu)}&confirmation_token=${encodeURIComponent(createOrderConfirmationToken(orderNsu))}&payment_method=pix`,
                    webhook_url:
                        `${SITE_URL}/webhook-infinitepay`,
                    items: pixItems,
                    customer: {
                        name: String(customer.name),
                        email: String(customer.email),
                        phone_number: formattedPhone
                    },
                    address: {
                        cep: customer.address.cep || "",
                        street: customer.address.street || "",
                        neighborhood: customer.address.neighborhood || "",
                        number: customer.address.number || "",
                        complement: customer.address.complement || ""
                    }
                };

                console.log("PIX — criando checkout independente na InfinitePay:", {
                    order_nsu: orderNsu,
                    amount: checkoutTotal
                });

                const pixResponse = await fetchWithTimeout(
                    INFINITEPAY_API,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Accept": "application/json"
                        },
                        body: JSON.stringify(pixPayload)
                    },
                    15000
                );

                const pixResponseText = await pixResponse.text();
                let pixData;
                try {
                    pixData = pixResponseText ? JSON.parse(pixResponseText) : {};
                } catch {
                    pixData = { raw: pixResponseText };
                }

                if (!pixResponse.ok || !pixData?.url) {
                    console.error("PIX — erro ao criar checkout InfinitePay:", pixResponse.status, pixData);
                    await releaseCoupon();
                    await closeFailedOrder();
                    return res.status(pixResponse.ok ? 502 : pixResponse.status).json({
                        success: false,
                        payment_unavailable: true,
                        message: CHECKOUT_FAILED_MESSAGE
                    });
                }

                await rememberCheckoutUrl(savedOrder.id, pixData.url);
                console.log("PIX — checkout independente criado:", orderNsu);

                return res.status(200).json({
                    success: true,
                    pix_checkout: true,
                    url: pixData.url,
                    amount: checkoutTotal,
                    order_nsu: orderNsu,
                    order_code: String(orderCode),
                    status: "pending"
                });
            }

            /* =================================================
               INFINITEPAY — CHECKOUT DE CARTÃO
            ================================================= */

            const infinitePayItems =
                productItems.flatMap(item => chargedLines(item).map(line => ({
                    quantity: line.quantity,
                    price: line.unit_cents,
                    description: item.description
                })));

            if (shippingValue > 0) {
                infinitePayItems.push({
                    quantity: 1,
                    price: Math.round(shippingValue * 100),
                    description: shippingOption.name
                });
            }

            /* =================================================
               PAYLOAD INFINITEPAY
            ================================================= */

            const payload = {

                handle:
                    INFINITEPAY_HANDLE,

                order_nsu:
                    orderNsu,

                redirect_url:
                    `${SITE_URL}/pagamento-sucesso?order_nsu=${encodeURIComponent(orderNsu)}&confirmation_token=${encodeURIComponent(createOrderConfirmationToken(orderNsu))}`,

                webhook_url:
                    `${SITE_URL}/webhook-infinitepay`,

                items:
                    infinitePayItems,

                customer: {

                    name:
                        String(
                            customer.name
                        ),

                    email:
                        String(
                            customer.email
                        ),

                    phone_number:
                        formattedPhone

                }

            };


            /* =================================================
               ENDEREÇO PARA INFINITEPAY
            ================================================= */

            if (
                customer.address
            ) {

                payload.address = {

                    cep:
                        customer.address.cep ||
                        "",

                    street:
                        customer.address.street ||
                        "",

                    neighborhood:
                        customer.address.neighborhood ||
                        "",

                    number:
                        customer.address.number ||
                        "",

                    complement:
                        customer.address.complement ||
                        ""

                };

            }


            /* =================================================
               LOG
            ================================================= */

            console.log(
                "📦 Pedido salvo:",
                orderNsu
            );

            console.log(
                "💰 Valor do frete:",
                shippingValue
            );

            console.log(
                "🛍️ Quantidade de produtos:",
                productItems.length
            );

            console.log(
                "📤 Enviando checkout para InfinitePay..."
            );


            /* =================================================
               CHAMADA REAL DA INFINITEPAY
            ================================================= */

            const infinitePayStartedAt = Date.now();
            const response = await fetchWithTimeout(
                INFINITEPAY_API,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    },
                    body: JSON.stringify(payload)
                },
                15000
            );
            console.log("📥 InfinitePay respondeu em", Date.now() - infinitePayStartedAt, "ms");


            /* =================================================
               LÊ RESPOSTA
            ================================================= */

            const responseText =
                await response.text();


            let data;


            try {

                data =
                    JSON.parse(
                        responseText
                    );

            } catch {

                data = {

                    raw:
                        responseText

                };

            }


            /* =================================================
               ERRO INFINITEPAY
            ================================================= */

            if (
                !response.ok
            ) {

                console.error(
                    "❌ InfinitePay respondeu com erro."
                );

                console.error(
                    "Status:",
                    response.status
                );

                console.error(
                    "Resposta:",
                    data
                );

                await releaseCoupon();
                await closeFailedOrder();


                return res.status(
                    response.status
                ).json({

                    success:
                        false,

                    payment_unavailable:
                        true,

                    message:
                        CHECKOUT_FAILED_MESSAGE

                });

            }


            /* =================================================
               VERIFICA URL
            ================================================= */

            if (
                !data ||
                !data.url
            ) {

                console.error(
                    "❌ InfinitePay não retornou URL."
                );

                console.error(
                    data
                );

                await releaseCoupon();
                await closeFailedOrder();


                return res.status(502).json({

                    success:
                        false,

                    payment_unavailable:
                        true,

                    message:
                        CHECKOUT_FAILED_MESSAGE

                });

            }


            /* =================================================
               SUCESSO
            ================================================= */

            await rememberCheckoutUrl(savedOrder.id, data.url);

            console.log(
                "✅ Checkout InfinitePay criado."
            );

            console.log(
                "🔑 Order NSU:",
                orderNsu
            );


            return res.status(200).json({

                success:
                    true,

                url:
                    data.url,

                order_nsu:
                    orderNsu

            });


        } catch (error) {

            console.error(
                "❌ ERRO INTERNO NO CHECKOUT:"
            );

            console.error(
                error
            );

            await releaseCoupon();
            await closeFailedOrder();


            return res.status(500).json({

                success:
                    false,

                payment_unavailable:
                    true,

                message:
                    CHECKOUT_FAILED_MESSAGE,

                error:
                    process.env.NODE_ENV ===
                    "development"
                        ? error.message
                        : undefined

            });

        }

    }
);
/* =====================================================
   INFINITEPAY
   WEBHOOK DE PAGAMENTO
===================================================== */

async function verifyInfinitePayPayment({ orderNsu, transactionNsu, invoiceSlug, expectedAmount }) {
    const response = await fetch("https://api.checkout.infinitepay.io/payment_check", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({
            handle: INFINITEPAY_HANDLE,
            order_nsu: orderNsu,
            transaction_nsu: transactionNsu,
            slug: invoiceSlug
        })
    });

    const responseText = await response.text();
    let data;
    try {
        data = responseText ? JSON.parse(responseText) : {};
    } catch {
        data = { raw: responseText };
    }

    if (!response.ok) {
        throw new Error(`InfinitePay payment_check ${response.status}: ${JSON.stringify(data)}`);
    }

    if (data.success !== true || data.paid !== true) {
        return { verified: false, data };
    }

    const returnedAmount = Number(data.amount);
    const expectedCents = Math.round(Number(expectedAmount || 0) * 100);

    if (!Number.isFinite(returnedAmount) || returnedAmount !== expectedCents) {
        throw new Error(
            `Valor do pagamento divergente. Esperado: ${expectedCents} centavos; recebido: ${returnedAmount} centavos.`
        );
    }

    return { verified: true, data };
}

app.post(
    "/webhook-infinitepay",
    infinitePayWebhookRateLimit,
    async (req, res) => {
        try {
            const webhook = req.body || {};
            const orderNsu = safeString(webhook.order_nsu);
            const transactionNsu = safeString(webhook.transaction_nsu);
            const invoiceSlug = safeString(webhook.invoice_slug || webhook.slug);

            console.log("💳 Webhook da InfinitePay recebido:", orderNsu);

            if (!orderNsu || !transactionNsu || !invoiceSlug) {
                return res.status(400).json({
                    success: false,
                    message: "Webhook sem order_nsu, transaction_nsu ou invoice_slug."
                });
            }

            const persistedOrders = await supabaseRequest(
                `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}&select=*`,
                { method: "GET" }
            );
            const order = Array.isArray(persistedOrders) ? persistedOrders[0] : null;

            if (!order) {
                console.error("❌ Pedido não encontrado:", orderNsu);
                return res.status(400).json({
                    success: false,
                    message: "Pedido não encontrado."
                });
            }

            // Pedido recusado pela loja (pré-venda): o estorno é tratado no painel; um aviso
            // repetido não pode reabrir o pedido nem baixar o estoque de novo.
            if (order.status === "cancelled") {
                return res.status(200).json({ success: true, paid: true, cancelled: true });
            }

            // Webhook repetido do mesmo pagamento: nunca refaça a baixa local.
            // Se a Olist ainda estiver pendente/erro, aproveitamos a repetição para tentar
            // novamente sem bloquear a confirmação da compra.
            // Pedidos já em separação/enviados/entregues também contam como pagos:
            // um webhook repetido não pode fazer o status voltar para "paid".
            if (
                ["paid", "processing", "shipped", "delivered"].includes(order.status) &&
                order.transaction_nsu === transactionNsu &&
                order.stock_decremented === true
            ) {
                // A Olist fica com o envio automático (cron a cada minuto, com trava): uma
                // repetição do aviso não dispara outro envio, que poderia duplicar o pedido lá.
                const olistRetry = {status: order.olist_sync_status === "completed" ? "completed" : "queued"};

                const confirmationEmail = await ensureOrderConfirmationEmail(order);
                const adminSaleEmail = await ensureAdminSaleNotificationEmail(order);
                const adminWhatsApp = await ensureWhatsAppAdminNewOrderNotification(order);

                return res.status(200).json({
                    success: true,
                    paid: true,
                    already_processed: true,
                    confirmation_email: confirmationEmail.status,
                    olist_sync: olistRetry.status
                });
            }

            const status = safeString(
                webhook.status ||
                webhook.payment_status ||
                webhook.current_status ||
                webhook.transaction_status
            ).toLowerCase();

            const failedStatuses = [
                "failed", "failure", "cancelled", "canceled",
                "refused", "rejected", "denied", "expired"
            ];

            if (failedStatuses.includes(status)) {
                console.log("ℹ️ Pagamento não aprovado:", orderNsu, status);
                return res.status(200).json({
                    success: true,
                    paid: false,
                    message: "Pagamento não aprovado."
                });
            }

            // A InfinitePay recomenda consultar payment_check para confirmar
            // que o order_nsu/transaction_nsu/slug correspondem a um pagamento pago.
            const verification = await verifyInfinitePayPayment({
                orderNsu,
                transactionNsu,
                invoiceSlug,
                expectedAmount: order.total
            });

            if (!verification.verified) {
                console.warn("⏳ Pagamento ainda não confirmado:", orderNsu);
                return res.status(400).json({
                    success: false,
                    message: "Pagamento ainda não confirmado pela InfinitePay."
                });
            }

            const payment = verification.data;
            const paidAmount = Number(payment.paid_amount ?? 0);
            const resolvedPaymentMethod = payment.capture_method === "pix" ? "pix" : "credit_card";
            // Pedido com o desconto do Pix pago com cartão no link da InfinitePay: a venda vale
            // (o valor pago confere), mas o aviso de venda destaca para a loja decidir.
            const pixPaidByCard = safeString(order.payment_method).toLowerCase() === "pix" && resolvedPaymentMethod !== "pix";
            // Comprovante só do domínio da InfinitePay (o corpo do aviso pode ser forjado).
            const receiptUrl = infinitePayReceiptUrl(payment.receipt_url || webhook.receipt_url);

            // IMPORTANTE: Olist é integração secundária.
            // A confirmação da venda MONTÊ não pode depender do ERP.
            // Primeiro consolidamos pagamento + estoque local; depois tentamos Olist.
            order.payment_method = resolvedPaymentMethod;

            // Baixa atômica e idempotente no estoque local.
            const stockResult = await supabaseRequest("rpc/decrement_order_stock", {
                method: "POST",
                body: JSON.stringify({ p_order_id: order.id })
            });

            console.log("📦 Baixa de estoque local:", stockResult);

            // Persiste o pagamento. Em caso de webhook simultâneo, a restrição
            // UNIQUE de transaction_nsu evita duplicidade.
            const existingPayments = await supabaseRequest(
                `payments?transaction_nsu=eq.${encodeURIComponent(transactionNsu)}&select=id,order_id`,
                { method: "GET" }
            );

            // A mesma transação não pode confirmar dois pedidos.
            if (Array.isArray(existingPayments) && existingPayments[0]?.id && String(existingPayments[0].order_id) !== String(order.id)) {
                console.error("❌ Transação já usada em outro pedido:", orderNsu);
                return res.status(409).json({ success: false, message: "Pagamento já vinculado a outro pedido." });
            }

            if (!Array.isArray(existingPayments) || !existingPayments[0]?.id) {
                try {
                    await supabaseRequest("payments", {
                        method: "POST",
                        body: JSON.stringify({
                            order_id: order.id,
                            order_nsu: orderNsu,
                            transaction_nsu: transactionNsu,
                            invoice_slug: invoiceSlug,
                            amount: Number(payment.amount || 0) / 100,
                            paid_amount: Number.isFinite(paidAmount)
                                ? paidAmount / 100
                                : null,
                            installments: payment.installments || null,
                            capture_method: payment.capture_method || null,
                            receipt_url: receiptUrl,
                            status: "paid",
                            webhook_data: {
                                webhook,
                                payment_check: payment
                            }
                        })
                    });
                } catch (paymentError) {
                    // Se outro webhook inseriu o mesmo transaction_nsu em paralelo,
                    // a restrição UNIQUE torna a operação idempotente.
                    if (!String(paymentError.message || "").includes("409")) {
                        throw paymentError;
                    }
                }
            }

            await supabaseRequest(
                `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        status: "paid",
                        payment_method: resolvedPaymentMethod,
                        invoice_slug: invoiceSlug,
                        transaction_nsu: transactionNsu,
                        receipt_url: receiptUrl,
                        installments: payment.installments || null,
                        capture_method: payment.capture_method || null,
                        paid_amount: Number.isFinite(paidAmount)
                            ? paidAmount / 100
                            : null,
                        paid_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                }
            );

            order.payment_method = resolvedPaymentMethod;

            const confirmationEmail = await ensureOrderConfirmationEmail({
                ...order,
                id: order.id,
                order_nsu: orderNsu,
                customer_name: order.customer_name,
                customer_email: order.customer_email,
                total: order.total
            });

            const adminSaleEmail = await ensureAdminSaleNotificationEmail({
                ...order, id: order.id, order_nsu: orderNsu, order_code: order.order_code,
                customer_name: order.customer_name, customer_email: order.customer_email,
                customer_phone: order.customer_phone, customer_whatsapp: order.customer_whatsapp,
                customer_address: order.customer_address, payment_method: order.payment_method,
                shipping: order.shipping, total: order.total, items: order.items,
                admin_sale_email_sent_at: order.admin_sale_email_sent_at,
                pix_paid_by_card: pixPaidByCard
            });
            if (pixPaidByCard) console.warn("⚠️ Pedido com desconto do Pix pago com cartão:", orderNsu);

            const adminWhatsApp = await ensureWhatsAppAdminNewOrderNotification({
                ...order,
                id: order.id,
                order_nsu: orderNsu,
                customer_name: order.customer_name,
                customer_phone: order.customer_phone,
                customer_whatsapp: order.customer_whatsapp,
                customer_cpf: order.customer_cpf,
                customer_address: order.customer_address,
                payment_method: order.payment_method,
                total: order.total,
                items: order.items,
                whatsapp_admin_notification_sent_at: order.whatsapp_admin_notification_sent_at,
                whatsapp_admin_notification_message_id: order.whatsapp_admin_notification_message_id
            });

            // A venda MONTÊ já está confirmada. A Olist roda em segundo plano.
            // O webhook responde sem esperar a Olist, evitando que uma falha/lentidão
            // do ERP interfira no checkout, no estoque ou na confirmação da compra.
            // No Workers o waitUntil mantém a tarefa viva depois da resposta; se ela
            // não terminar, o cron de cada minuto envia o pedido.
            runInBackground(processPendingOlistOrder({
                ...order,
                status: "paid",
                payment_method: resolvedPaymentMethod,
                transaction_nsu: transactionNsu,
                customer_cpf: order.customer_cpf,
                customer_whatsapp: order.customer_whatsapp
            }));

            console.log(
                "✅ Pagamento confirmado, estoque local baixado e notificações processadas:",
                orderNsu,
                "| Olist: processamento em segundo plano"
            );

            return res.status(200).json({
                success: true,
                paid: true,
                order_nsu: orderNsu,
                confirmation_email: confirmationEmail.status,
                    admin_sale_email: adminSaleEmail.status,
                    whatsapp_admin_notification: adminWhatsApp.status
            });

        } catch (error) {
            console.error("❌ ERRO NO WEBHOOK DA INFINITEPAY:", error);

            return res.status(500).json({
                success: false,
                message: "Erro interno no processamento do pagamento."
            });
        }
    }
);




/* =====================================================
   MINHAS COMPRAS — CONSULTA SEGURA POR PEDIDO + E-MAIL
===================================================== */

// Os números de pedido são curtos e seguidos: quem souber o e-mail de alguém poderia testar
// números até achar. Depois de ORDER_LOOKUP_MAX_FAILURES erros para o mesmo e-mail, a consulta
// fica bloqueada por uma hora (guardado no Supabase, vale para todas as instâncias do Worker).
const ORDER_LOOKUP_MAX_FAILURES = 5;
const ORDER_LOOKUP_LOCK_MS = 60 * 60 * 1000;
function orderLookupKey(email) {
    return "order_lookup:" + crypto.createHash("sha256").update(email).digest("hex").slice(0, 40);
}
async function orderLookupBlocked(email) {
    const rows = await supabaseRequest("kv_store_48db9b7e?key=eq." + orderLookupKey(email) + "&select=value&limit=1", { method: "GET" });
    const value = rows?.[0]?.value || {};
    return Number(value.count) >= ORDER_LOOKUP_MAX_FAILURES && Date.now() - Number(value.first_at || 0) < ORDER_LOOKUP_LOCK_MS;
}
async function recordOrderLookupFailure(email) {
    const key = orderLookupKey(email);
    const rows = await supabaseRequest("kv_store_48db9b7e?key=eq." + key + "&select=value&limit=1", { method: "GET" });
    const value = rows?.[0]?.value || {};
    const fresh = !(Date.now() - Number(value.first_at || 0) < ORDER_LOOKUP_LOCK_MS);
    await supabaseRequest("kv_store_48db9b7e?on_conflict=key", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, value: { count: fresh ? 1 : Number(value.count || 0) + 1, first_at: fresh ? Date.now() : Number(value.first_at) } })
    });
}

app.get("/api/minhas-compras", orderStatusRateLimit, async (req, res) => {
    try {
        const orderNsu = normalizeOrderCode(req.query.order_nsu);
        const email = safeString(req.query.email).toLowerCase();

        if (!orderNsu || !email || orderNsu.length > 80 || email.length > 160) {
            return res.status(400).json({ success: false, message: "Informe o número do pedido e o e-mail usado na compra." });
        }
        if (await orderLookupBlocked(email)) {
            return res.status(429).json({ success: false, message: "Muitas tentativas para este e-mail. Tente de novo em 1 hora ou fale com a MONTÊ pelo WhatsApp." });
        }

        const rows = await supabaseRequest(
            `orders?${/^\d{4,8}$/.test(orderNsu) ? "order_code=eq."+encodeURIComponent(orderNsu) : "order_nsu=eq."+encodeURIComponent(orderNsu)}&customer_email=eq.${encodeURIComponent(email)}&select=id,order_nsu,order_code,customer_name,customer_email,status,approval_status,refund_status,total,subtotal,shipping,shipping_carrier,tracking_code,tracking_url,shipping_service_name,created_at,paid_at,processing_at,shipped_at,delivered_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)`,
            { method: "GET" }
        );

        const order = Array.isArray(rows) ? rows[0] : null;
        if (!order) {
            await recordOrderLookupFailure(email).catch(error => console.warn("Minhas compras — tentativa não registrada:", error.message));
            return res.status(404).json({ success: false, message: "Não encontramos um pedido com esses dados." });
        }

        return res.json({
            success: true,
            order: {
                order_nsu: order.order_nsu,
                order_code: formatOrderCode(order.order_code || order.order_nsu),
                customer_name: order.customer_name,
                status: order.status,
                approval_status: order.approval_status || null,
                refund_status: order.refund_status || null,
                subtotal: Number(order.subtotal || 0),
                shipping: Number(order.shipping || 0),
                total: Number(order.total || 0),
                shipping_carrier: order.shipping_carrier || null,
                tracking_code: order.tracking_code || null,
                tracking_url: order.tracking_url || null,
                shipping_service_name: order.shipping_service_name || null,
                created_at: order.created_at,
                paid_at: order.paid_at,
                processing_at: order.processing_at,
                shipped_at: order.shipped_at,
                delivered_at: order.delivered_at,
                items: (order.order_items || []).map(item => ({
                    product_name: item.product_name,
                    variant_color: item.variant_color,
                    sku: item.sku,
                    quantity: Number(item.quantity || 0),
                    unit_price: Number(item.unit_price || 0),
                    total_price: Number(item.total_price || 0)
                }))
            }
        });
    } catch (error) {
        console.error("❌ Minhas compras:", error);
        return res.status(500).json({ success: false, message: "Não foi possível consultar o pedido." });
    }
});

/* =====================================================
   STATUS DO PEDIDO PARA A PÁGINA DE SUCESSO
===================================================== */
app.get("/api/pedido-confirmacao", orderStatusRateLimit, async (req, res) => {
    try {
        const orderNsu = safeString(req.query.order_nsu);
        const confirmationToken = safeString(req.query.confirmation_token);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        if (!orderNsu || !confirmationToken || !verifyOrderConfirmationToken(confirmationToken, orderNsu)) {
            return res.status(401).json({ success: false, message: "Token de confirmação inválido ou expirado." });
        }

        const rows = await supabaseRequest(
            "orders?order_nsu=eq." + encodeURIComponent(orderNsu) +
            "&select=id,order_nsu,order_code,customer_name,status,total,subtotal,shipping,payment_method,created_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)",
            { method: "GET" }
        );
        const order = Array.isArray(rows) ? rows[0] : null;
        if (!order) return res.status(404).json({ success: false, message: "Pedido não encontrado." });

        return res.json({
            success: true,
            order: {
                order_nsu: order.order_nsu,
                order_code: formatOrderCode(order.order_code || order.order_nsu),
                customer_name: order.customer_name,
                status: order.status,
                payment_method: order.payment_method,
                subtotal: Number(order.subtotal || 0),
                shipping: Number(order.shipping || 0),
                total: Number(order.total || 0),
                created_at: order.created_at,
                items: (order.order_items || []).map(item => ({
                    product_name: item.product_name,
                    variant_color: item.variant_color,
                    sku: item.sku,
                    quantity: Number(item.quantity || 0),
                    unit_price: Number(item.unit_price || 0),
                    total_price: Number(item.total_price || 0)
                }))
            }
        });
    } catch (error) {
        console.error("❌ Erro na confirmação do pedido:", error);
        return res.status(500).json({ success: false, message: "Não foi possível carregar o pedido." });
    }
});

/* =====================================================
   SEO — SITEMAP, ROBOTS E PÁGINAS DE PRODUTO
===================================================== */

function xmlEscape(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function slugify(value) {
    return safeString(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

function publicImageUrl(value) {
    const raw = siteMediaPath(safeString(value));
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    return new URL("/" + raw.replace(/^\/+/, ""), PUBLIC_SITE_URL).href;
}

function productSeoUrl(product) {
    return new URL("/produto/" + encodeURIComponent(product.id) + "/" + encodeURIComponent(slugify(product.name)), PUBLIC_SITE_URL).href;
}

function productAvailabilityForSchema(product) {
    // Pré-venda é vendida mesmo sem estoque.
    if (product.is_presale) return "https://schema.org/PreOrder";
    return Number(product.stock_total || 0) > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
}

async function getPublicProductsForSeo() {
    const rows = await supabaseRequest(
        "products?active=eq.true&select=id,name,category,description,price,sale_price,is_sale,is_presale,images,updated_at,product_variants(stock,active)",
        { method: "GET" }
    );

    return (Array.isArray(rows) ? rows : []).map(product => ({
        ...product,
        stock_total: Array.isArray(product.product_variants)
            ? product.product_variants.filter(v => v.active !== false).reduce((sum, v) => sum + Number(v.stock || 0), 0)
            : 0
    }));
}

function productSchema(product) {
    const price = Number(product.is_sale && product.sale_price != null ? product.sale_price : product.price || 0);
    const image = Array.isArray(product.images) ? product.images.map(publicImageUrl).filter(Boolean) : [];
    const categoryLabel = product.category === "bolsas" ? "Bolsas" : product.category === "cintos" ? "Cintos" : "Acessórios";

    return {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": safeString(product.name),
        "description": safeString(product.description) || safeString(product.name) + " — MONTÊ.",
        "image": image,
        "category": categoryLabel,
        "brand": { "@type": "Brand", "name": "MONTÊ" },
        "url": productSeoUrl(product),
        "offers": {
            "@type": "Offer",
            "url": productSeoUrl(product),
            "priceCurrency": "BRL",
            "price": price.toFixed(2),
            "availability": productAvailabilityForSchema(product),
            "itemCondition": "https://schema.org/NewCondition"
        }
    };
}

app.get("/produto/:id/:slug", async (req, res) => {
    try {
        const id = safeString(req.params.id);
        const rows = await supabaseRequest(
            "products?id=eq." + encodeURIComponent(id) + "&active=eq.true&select=id,name,category,description,price,sale_price,is_sale,is_presale,images,updated_at,product_variants(stock,active)",
            { method: "GET" }
        );
        const product = Array.isArray(rows) ? rows[0] : null;

        // Peça que saiu da loja: o link antigo (Google, Instagram) leva para a loja.
        if (!product) return res.redirect(302, "/");

        const stockTotal = Array.isArray(product.product_variants)
            ? product.product_variants.filter(v => v.active !== false).reduce((sum, v) => sum + Number(v.stock || 0), 0)
            : 0;
        const price = Number(product.is_sale && product.sale_price != null ? product.sale_price : product.price || 0);
        const image = Array.isArray(product.images) && product.images.length ? publicImageUrl(product.images[0]) : "";
        const canonical = productSeoUrl(product);
        const description = safeString(product.description) || safeString(product.name) + " — Bolsa e acessórios MONTÊ.";
        const title = safeString(product.name) + " | MONTÊ";
        const schema = productSchema({ ...product, stock_total: stockTotal });

        const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="/favicon.ico?v=1" sizes="32x32"><link rel="icon" href="/favicon.svg?v=1" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=1">
<title>${xmlEscape(title)}</title>
<meta name="description" content="${xmlEscape(description.slice(0, 160))}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${xmlEscape(canonical)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="MONTÊ">
<meta property="og:locale" content="pt_BR">
<meta property="og:title" content="${xmlEscape(title)}">
<meta property="og:description" content="${xmlEscape(description.slice(0, 200))}">
<meta property="og:url" content="${xmlEscape(canonical)}">
${image ? `<meta property="og:image" content="${xmlEscape(image)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${xmlEscape(title)}">
<meta name="twitter:description" content="${xmlEscape(description.slice(0, 200))}">
${image ? `<meta name="twitter:image" content="${xmlEscape(image)}">` : ""}
<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>
<link rel="stylesheet" href="/produto-seo.css?v=20261016-comprar">
</head>
<body>
<main class="seo-product">
<h1>${xmlEscape(product.name)}</h1>
${image ? `<img src="${xmlEscape(image)}" alt="${xmlEscape(product.name)}">` : ""}
<p>${xmlEscape(description).replace(/\n/g, "<br>")}</p>
<p><strong>Preço: R$ ${price.toFixed(2).replace(".", ",")}</strong></p>
${product.is_sale ? '<p class="seo-sale-notice"><strong>Sale:</strong> produtos da Sale não acompanham dustbag.</p>' : ""}
${product.is_presale ? '<p class="seo-sale-notice"><strong>Pré-venda — garanta a sua!</strong> Peças em produção com estoque limitado. Garanta a sua antecipadamente. Entrega em ' + PRESALE_MIN_BUSINESS_DAYS + ' dias úteis.</p>' : ""}
<p>${product.is_presale ? "Disponível na pré-venda." : stockTotal > 0 ? "Disponível para compra." : "Produto esgotado."}</p>
<p><a class="seo-buy" href="/?produto=${encodeURIComponent(product.id)}">${product.is_presale || stockTotal > 0 ? "COMPRAR NA LOJA" : "VER NA LOJA"}</a></p>
<p><a href="/">Voltar para a MONTÊ</a></p>
</main>
</body>
</html>`;
        return res.status(200).type("html").send(html);
    } catch (error) {
        console.error("❌ SEO produto:", error);
        return res.status(500).send("Não foi possível carregar o produto.");
    }
});

app.get("/sitemap.xml", async (req, res) => {
    try {
        const products = await getPublicProductsForSeo();
        const urls = [
            { loc: new URL("/", PUBLIC_SITE_URL).href },
            { loc: new URL("/trocas-devolucoes.html", PUBLIC_SITE_URL).href },
            { loc: new URL("/politica-privacidade.html", PUBLIC_SITE_URL).href },
            { loc: new URL("/entrega-frete.html", PUBLIC_SITE_URL).href },
            { loc: new URL("/termos-de-compra.html", PUBLIC_SITE_URL).href },
            ...products.map(product => ({ loc: productSeoUrl(product), lastmod: product.updated_at }))
        ];
        const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            ...urls.map(url => '<url><loc>' + xmlEscape(url.loc) + '</loc>' + (url.lastmod ? '<lastmod>' + xmlEscape(new Date(url.lastmod).toISOString()) + '</lastmod>' : "") + '</url>'),
            '</urlset>'
        ].join("");
        res.set("Content-Type", "application/xml; charset=utf-8");
        res.set("Cache-Control", "public, max-age=900");
        return res.status(200).send(xml);
    } catch (error) {
        console.error("❌ Sitemap:", error);
        // Sem acesso ao catálogo, publica ao menos as páginas institucionais.
        const pages = ["/", "/trocas-devolucoes.html", "/politica-privacidade.html", "/entrega-frete.html", "/termos-de-compra.html"];
        res.set("Content-Type", "application/xml; charset=utf-8");
        return res.status(200).send(
            '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
            pages.map(page => '<url><loc>' + xmlEscape(new URL(page, PUBLIC_SITE_URL).href) + '</loc></url>').join("") +
            '</urlset>'
        );
    }
});

// Minhas Compras e a confirmação de pagamento ficam fora do Google pela meta "noindex";
// não entram no Disallow porque o Google precisa abrir a página para ler o noindex.
app.get("/robots.txt", (req, res) => {
    const body = [
        "User-agent: *",
        "Allow: /",
        "Disallow: /admin",
        "Disallow: /admin/",
        "Disallow: /backend/",
        "Sitemap: " + new URL("/sitemap.xml", PUBLIC_SITE_URL).href
    ].join("\n") + "\n";
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(body);
});

/* =====================================================
   PÁGINA DE SUCESSO
===================================================== */
app.get("/pagamento-sucesso", (req, res) => sendSitePage(res, "pagamento-sucesso.html"));


/* =====================================================
   ARQUIVOS DO SITE
   Registrado depois das rotas dinâmicas para que /sitemap.xml e
   /robots.txt gerados pelo servidor tenham prioridade sobre os arquivos
   estáticos. O código do backend não é servido publicamente; apenas as
   imagens em /backend/assets.
===================================================== */

app.use("/backend", (req, res, next) => {
    if (req.path.startsWith("/assets/")) return next();
    return res.status(404).send("Não encontrado.");
});

// Arquivos e pastas ocultos (.git, .env...) e a configuração do Cloudflare nunca são
// públicos (no Workers eles já ficam fora dos assets; aqui vale para o Node).
app.use((req, res, next) => {
    if (/(^|\/)\.(?!well-known\/)/.test(req.path) || /^\/(wrangler\.jsonc|_headers|_redirects)$/i.test(req.path)) {
        return res.status(404).send("Não encontrado.");
    }
    return next();
});

// Só no Node (Render). No Workers os arquivos do site saem dos assets do Cloudflare, e o "disco"
// que o express.static enxergaria é o sistema de arquivos virtual do Worker, onde fica o próprio
// código do servidor (/bundle/worker.js): servir de lá exporia o código.
if (!IS_WORKERS) app.use(
    express.static(
        SITE_DIR,
        {
            dotfiles: "deny",
            maxAge: "1d",
            setHeaders: (res, filePath) => {
                // Páginas sempre revalidadas; CSS, JS e imagens ficam 1 dia no navegador.
                if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
            }
        }
    )
);


/* =====================================================
   LEMBRETES POR E-MAIL E LIMPEZA DOS PEDIDOS SEM PAGAMENTO
   - Pedido aguardando pagamento (Pix gerado ou cartão não concluído):
     um lembrete 30 minutos depois, com um link que refaz a sacola.
   - Sacola abandonada (e-mail preenchido no checkout, sem pedido):
     um lembrete 2 horas depois da última mexida.
   - Nos mesmos momentos, a loja recebe um e-mail interno com o botão para
     chamar a cliente no WhatsApp (mensagem pronta e link da sacola): pedido
     sem pagamento, ou sacola em que a cliente deixou o WhatsApp.
   Só pedidos e sacolas das últimas 24 horas, um único e-mail por pedido
   ou sacola, e só com as peças que ainda têm estoque.
   - Pedido aguardando pagamento há mais de 2 dias vira "expired" e sai
     da lista principal do painel. Se o pagamento chegar depois, o aviso
     da InfinitePay confirma o pedido normalmente.
===================================================== */
const REMINDER_ORDER_AFTER_MS = 30 * 60 * 1000;
const REMINDER_CART_AFTER_MS = 2 * 60 * 60 * 1000;
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const PENDING_ORDER_EXPIRE_MS = 2 * 24 * 60 * 60 * 1000;
// Por lembrete: compras posteriores, estoque, e-mail e marcação = 4 chamadas.
const REMINDER_CALLS_EACH = 5;
const PAID_ORDER_STATUSES = ["paid", "processing", "shipped", "delivered"];
const isEmailAddress = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeString(value));
const isoAgo = ms => encodeURIComponent(new Date(Date.now() - ms).toISOString());

// Mesma regra da loja: "Bag Vienna - preta" aparece como "Preta".
function reminderColorLabel(color, productName) {
    const text = safeString(color);
    const name = safeString(productName);
    const plain = value => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (!text || !name || text.length <= name.length || !plain(text).startsWith(plain(name))) return text;
    const rest = text.slice(name.length).replace(/^[\s\-–—:|]+/, "").trim();
    return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : text;
}

// Peças do pedido ou da sacola que ainda podem ser compradas, com preço e foto atuais.
async function availableReminderItems(items) {
    const uuid = /^[0-9a-f-]{36}$/i;
    const list = (Array.isArray(items) ? items : []).map(item => ({
        productId: safeString(item?.id || item?.product_id),
        variantId: safeString(item?.variant_id),
        quantity: Math.max(1, Math.min(20, Math.floor(Number(item?.quantity) || 1)))
    })).filter(item => uuid.test(item.productId) && (!item.variantId || uuid.test(item.variantId))).slice(0, 20);
    if (!list.length) return [];
    const rows = await supabaseRequest(
        "products?id=in.(" + [...new Set(list.map(item => item.productId))].join(",") + ")" +
        "&active=eq.true&select=id,name,price,sale_price,is_sale,images,product_variants(id,color,stock,active)",
        { method: "GET" }
    );
    const productsById = new Map((Array.isArray(rows) ? rows : []).map(row => [String(row.id).toLowerCase(), row]));
    const result = [];
    list.forEach(item => {
        const product = productsById.get(item.productId.toLowerCase());
        if (!product) return;
        const variants = (Array.isArray(product.product_variants) ? product.product_variants : []).filter(v => v.active !== false);
        const variant = item.variantId ? variants.find(v => String(v.id).toLowerCase() === item.variantId.toLowerCase()) : null;
        if (item.variantId && !variant) return;
        const stock = variant ? Number(variant.stock || 0) : variants.reduce((sum, v) => sum + Number(v.stock || 0), 0);
        if (stock <= 0) return;
        const price = product.is_sale && product.sale_price != null ? Number(product.sale_price) : Number(product.price || 0);
        result.push({
            productId: product.id,
            variantId: variant?.id || null,
            quantity: Math.min(item.quantity, stock),
            name: safeString(product.name),
            color: reminderColorLabel(variant?.color, product.name),
            price,
            image: publicImageUrl(Array.isArray(product.images) ? product.images[0] : "")
        });
    });
    return result;
}

// Link que refaz a sacola no site: ?sacola=[[produto, variação, quantidade], ...] em base64url.
function cartRestoreUrl(items, campaign, medium = "email") {
    const payload = Buffer.from(JSON.stringify(items.map(item => [item.productId, item.variantId, item.quantity]))).toString("base64url");
    return PUBLIC_SITE_URL + "/?sacola=" + payload + "&utm_source=lembrete&utm_medium=" + medium + "&utm_campaign=" + campaign;
}

function formatEmailMoney(value) {
    return "R$ " + Number(value || 0).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function reminderEmailHtml({ eyebrow, title, paragraphs, items, buttonUrl, buttonText, footnote }) {
    const rows = items.map(item =>
        "<tr><td style=\"padding:12px 0;border-bottom:1px solid #eee;width:76px;vertical-align:top;\">" +
        (item.image ? "<img src=\"" + escapeEmailHtml(item.image) + "\" alt=\"\" width=\"64\" height=\"64\" style=\"display:block;width:64px;height:64px;object-fit:cover;background:#fff;border:1px solid #eee;\">" : "") +
        "</td><td style=\"padding:12px 0 12px 12px;border-bottom:1px solid #eee;vertical-align:top;font-size:14px;color:#171717;\"><strong style=\"font-weight:600;\">" + escapeEmailHtml(item.name) + "</strong>" +
        (item.color ? "<br><span style=\"font-size:12px;color:#777;\">" + escapeEmailHtml(item.color) + "</span>" : "") +
        "<br><span style=\"font-size:12px;color:#777;\">" + item.quantity + " × " + formatEmailMoney(item.price) + "</span></td></tr>"
    ).join("");
    return "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
        "<div style=\"max-width:620px;margin:0 auto;padding:40px 20px;\"><div style=\"background:#111;color:#fff;text-align:center;padding:24px 20px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
        "<div style=\"background:#fff;padding:38px 30px;\"><p style=\"margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#777;\">" + escapeEmailHtml(eyebrow) + "</p>" +
        "<h1 style=\"margin:0 0 18px;font-size:28px;font-weight:500;\">" + escapeEmailHtml(title) + "</h1>" +
        paragraphs.map(text => "<p style=\"font-size:15px;line-height:1.7;color:#555;margin:0 0 14px;\">" + escapeEmailHtml(text) + "</p>").join("") +
        "<table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\" style=\"width:100%;margin:22px 0 6px;border-collapse:collapse;\">" + rows + "</table>" +
        "<div style=\"text-align:center;margin:30px 0 8px;\"><a href=\"" + escapeEmailHtml(buttonUrl) + "\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:15px 26px;font-size:13px;letter-spacing:1.5px;\">" + escapeEmailHtml(buttonText) + "</a></div></div>" +
        "<p style=\"text-align:center;font-size:11px;line-height:1.6;color:#999;margin:20px 0;\">" + escapeEmailHtml(footnote) + "<br>MONTÊ — Bolsas e acessórios</p></div></body></html>";
}

async function sendReminderEmail({ to, subject, html, text, idempotencyKey, type }) {
    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json", "Accept": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ from: RESEND_FROM_NAME + " <" + RESEND_FROM_EMAIL + ">", to: [to], subject, text, html, tags: [{ name: "type", value: type }] })
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error("Resend API " + response.status + ": " + responseText.slice(0, 300));
}

async function expireOldPendingOrders(budget) {
    spend(budget);
    const rows = await supabaseRequest(
        "orders?status=eq.pending&created_at=lt." + isoAgo(PENDING_ORDER_EXPIRE_MS) + "&select=order_code",
        { method: "PATCH", body: JSON.stringify({ status: "expired", updated_at: new Date().toISOString() }) }
    );
    const codes = (Array.isArray(rows) ? rows : []).map(row => row.order_code).filter(Boolean);
    if (codes.length) console.log("🧹 Pedidos sem pagamento há mais de 2 dias marcados como expirados:", codes.join(", "));
    return codes.length;
}

// Pedidos da mesma cliente feitos depois deste momento (para não lembrar o que ela já resolveu).
async function laterOrdersOf(email, since, budget) {
    spend(budget);
    const rows = await supabaseRequest(
        "orders?customer_email=eq." + encodeURIComponent(safeString(email).trim().toLowerCase()) + "&created_at=gt." + encodeURIComponent(since) + "&select=id,status&limit=10",
        { method: "GET" }
    );
    return Array.isArray(rows) ? rows : [];
}

async function remindPendingOrders(budget) {
    spend(budget);
    const rows = await supabaseRequest(
        "orders?status=eq.pending&payment_reminder_sent_at=is.null" +
        "&created_at=lt." + isoAgo(REMINDER_ORDER_AFTER_MS) + "&created_at=gt." + isoAgo(REMINDER_WINDOW_MS) +
        "&select=id,order_nsu,order_code,customer_name,customer_email,items,payment_method,created_at&order=created_at.asc&limit=5",
        { method: "GET" }
    );
    let sent = 0;
    for (const order of Array.isArray(rows) ? rows : []) {
        if (!budget.has(REMINDER_CALLS_EACH)) break;
        const mark = status => {
            spend(budget);
            return supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
                method: "PATCH",
                headers: { "Prefer": "return=minimal" },
                body: JSON.stringify({ payment_reminder_sent_at: new Date().toISOString(), payment_reminder_status: status })
            });
        };
        if (!isEmailAddress(order.customer_email)) { await mark("skipped_invalid_email"); continue; }
        const later = await laterOrdersOf(order.customer_email, order.created_at, budget);
        if (later.length) { await mark(later.some(o => PAID_ORDER_STATUSES.includes(o.status)) ? "skipped_paid_later" : "skipped_newer_order"); continue; }
        spend(budget);
        const items = await availableReminderItems(order.items);
        if (!items.length) { await mark("skipped_sold_out"); continue; }
        const code = formatOrderCode(order.order_code || order.order_nsu);
        const firstName = reminderFirstName(order.customer_name);
        const url = cartRestoreUrl(items, "pagamento_pendente");
        const pix = safeString(order.payment_method).toLowerCase() === "pix";
        try {
            spend(budget);
            await sendReminderEmail({
                to: safeString(order.customer_email).toLowerCase(),
                subject: "Seu pedido " + code + " está esperando por você",
                type: "payment_reminder",
                idempotencyKey: "monte-payment-reminder-" + order.id,
                html: reminderEmailHtml({
                    eyebrow: "PAGAMENTO PENDENTE",
                    title: "Sua seleção ainda está aqui" + (firstName ? ", " + firstName : "") + ".",
                    paragraphs: [
                        "O pagamento do pedido " + code + " não foi concluído" + (pix ? " (o Pix gerado não foi pago)" : "") + ". Se ainda quiser as peças, é só voltar: a sacola já está pronta para você.",
                        ("As peças não ficam reservadas e o estoque é limitado. " + benefitsSentence(await storeBenefits())).trim()
                    ],
                    items,
                    buttonUrl: url,
                    buttonText: "FINALIZAR MINHA COMPRA",
                    footnote: "Se você já pagou, desconsidere este e-mail. Dúvidas? É só responder esta mensagem."
                }),
                text: "Seu pedido " + code + " na MONTÊ ainda não foi pago.\n\n" + items.map(i => "- " + i.name + (i.color ? " (" + i.color + ")" : "") + " — " + i.quantity + " × " + formatEmailMoney(i.price)).join("\n") + "\n\nFinalize sua compra: " + url + "\n\nSe você já pagou, desconsidere este e-mail."
            });
            await mark("sent");
            sent++;
            console.log("✉️ Lembrete de pagamento enviado:", code);
        } catch (error) {
            console.error("Lembrete de pagamento —", code, error.message);
            await mark("error").catch(() => {});
        }
    }
    return sent;
}

// Primeiro nome para a saudação, só com letras (o nome vem do que foi digitado no site).
function reminderFirstName(name) {
    const first = safeString(name).trim().split(/\s+/)[0] || "";
    return /^[\p{L}'’-]{1,30}$/u.test(first) ? first : "";
}

async function cartReminderSentRecently(email, budget) {
    spend(budget);
    const rows = await supabaseRequest(
        "cart_snapshots?customer_email=eq." + encodeURIComponent(safeString(email).trim().toLowerCase()) +
        "&reminder_status=eq.sent&reminder_sent_at=gt." + isoAgo(7 * 24 * 60 * 60 * 1000) + "&select=id&limit=1",
        { method: "GET" }
    );
    return Array.isArray(rows) && rows.length > 0;
}

async function remindAbandonedCarts(budget) {
    spend(budget);
    const rows = await supabaseRequest(
        "cart_snapshots?status=eq.active&reminder_sent_at=is.null&customer_email=not.is.null" +
        "&last_activity_at=lt." + isoAgo(REMINDER_CART_AFTER_MS) + "&last_activity_at=gt." + isoAgo(REMINDER_WINDOW_MS) +
        "&select=id,customer_name,customer_email,items,created_at&order=last_activity_at.asc&limit=5",
        { method: "GET" }
    );
    let sent = 0;
    for (const cart of Array.isArray(rows) ? rows : []) {
        if (!budget.has(REMINDER_CALLS_EACH)) break;
        const mark = (status, extra = {}) => {
            spend(budget);
            return supabaseRequest("cart_snapshots?id=eq." + encodeURIComponent(cart.id), {
                method: "PATCH",
                headers: { "Prefer": "return=minimal" },
                body: JSON.stringify({ reminder_sent_at: new Date().toISOString(), reminder_status: status, ...extra })
            });
        };
        if (!isEmailAddress(cart.customer_email)) { await mark("skipped_invalid_email"); continue; }
        // Já virou pedido: se foi pago, a sacola conta como convertida; se não, o lembrete do pedido cuida.
        const orders = await laterOrdersOf(cart.customer_email, cart.created_at, budget);
        const paid = orders.find(o => PAID_ORDER_STATUSES.includes(o.status));
        if (paid) { await mark("skipped_purchased", { status: "converted", converted_order_id: paid.id }); continue; }
        if (orders.length) { await mark("skipped_has_order"); continue; }
        // Um lembrete de sacola por e-mail a cada 7 dias: a sacola é salva sem login, então
        // alguém poderia cadastrar o e-mail de outra pessoa várias vezes.
        if (await cartReminderSentRecently(cart.customer_email, budget)) { await mark("skipped_recent_reminder"); continue; }
        spend(budget);
        const items = await availableReminderItems(cart.items);
        if (!items.length) { await mark("skipped_sold_out"); continue; }
        const firstName = reminderFirstName(cart.customer_name);
        const url = cartRestoreUrl(items, "sacola_abandonada");
        try {
            spend(budget);
            await sendReminderEmail({
                to: safeString(cart.customer_email).toLowerCase(),
                subject: "Você deixou peças na sacola da MONTÊ",
                type: "cart_reminder",
                idempotencyKey: "monte-cart-reminder-" + cart.id,
                html: reminderEmailHtml({
                    eyebrow: "SUA SACOLA",
                    title: "Esqueceu alguma coisa" + (firstName ? ", " + firstName : "") + "?",
                    paragraphs: [
                        "Guardamos as peças que você escolheu. Elas ainda estão disponíveis, mas o estoque é limitado.",
                        benefitsSentence(await storeBenefits())
                    ].filter(Boolean),
                    items,
                    buttonUrl: url,
                    buttonText: "VOLTAR PARA A SACOLA",
                    footnote: "Você recebeu este lembrete único porque começou uma compra em oficialmontee.com.br."
                }),
                text: "Você deixou peças na sacola da MONTÊ.\n\n" + items.map(i => "- " + i.name + (i.color ? " (" + i.color + ")" : "") + " — " + i.quantity + " × " + formatEmailMoney(i.price)).join("\n") + "\n\nVolte para a sacola: " + url
            });
            await mark("sent");
            sent++;
            console.log("✉️ Lembrete de sacola enviado.");
        } catch (error) {
            console.error("Lembrete de sacola —", error.message);
            await mark("error").catch(() => {});
        }
    }
    return sent;
}

/* =====================================================
   LOJA CHAMA A CLIENTE NO WHATSAPP
   A API oficial do WhatsApp não está configurada, então a mensagem sai do
   WhatsApp da própria loja: a loja recebe um e-mail interno com o botão que
   abre a conversa com a cliente e o texto pronto (com o link da sacola).
   - Pedido sem pagamento há 30 minutos (o telefone é obrigatório no checkout).
   - Sacola parada há 2 horas em que a cliente deixou o WhatsApp para o lembrete.
===================================================== */
const STORE_FOLLOWUP_ORDER_AFTER_MS = 30 * 60 * 1000;
const STORE_FOLLOWUP_CART_AFTER_MS = REMINDER_CART_AFTER_MS;

function storeFollowupRecipients() {
    return ORDER_NOTIFICATION_EMAILS.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
}

function formatBrazilMobile(digits) {
    return "(" + digits.slice(0, 2) + ") " + digits.slice(2, 7) + "-" + digits.slice(7);
}

function storeFollowupPieces(items) {
    return items.map(item => item.name + (item.color ? " (" + item.color + ")" : "")).join(", ");
}

function storeFollowupEmailHtml({ eyebrow, title, details, items, whatsappUrl, message, cartUrl }) {
    const rows = items.map(item =>
        "<li style=\"margin:0 0 6px;\">" + item.quantity + "x " + escapeEmailHtml(item.name) +
        (item.color ? " (" + escapeEmailHtml(item.color) + ")" : "") + " — " + formatEmailMoney(item.price) + "</li>"
    ).join("");
    return "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
        "<div style=\"max-width:620px;margin:0 auto;padding:32px 18px;\">" +
        "<div style=\"background:#111;color:#fff;text-align:center;padding:22px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
        "<div style=\"background:#fff;padding:30px;\">" +
        "<p style=\"margin:0 0 8px;font-size:11px;letter-spacing:2px;color:#777;\">" + escapeEmailHtml(eyebrow) + "</p>" +
        "<h1 style=\"margin:0 0 18px;font-size:26px;font-weight:500;\">" + escapeEmailHtml(title) + "</h1>" +
        "<p style=\"font-size:14px;line-height:1.7;color:#555;margin:0 0 16px;\">" + details.map(escapeEmailHtml).join("<br>") + "</p>" +
        "<ul style=\"font-size:14px;line-height:1.6;padding-left:18px;margin:0 0 22px;\">" + rows + "</ul>" +
        "<div style=\"text-align:center;margin:26px 0 18px;\"><a href=\"" + escapeEmailHtml(whatsappUrl) + "\" style=\"display:inline-block;background:#1f7a4d;color:#fff;text-decoration:none;padding:16px 28px;font-size:13px;letter-spacing:1.5px;border-radius:999px;\">CHAMAR NO WHATSAPP</a></div>" +
        "<p style=\"font-size:12px;color:#777;margin:0 0 6px;\">Mensagem que já vai escrita (dá para editar antes de enviar):</p>" +
        "<p style=\"font-size:14px;line-height:1.7;background:#f7f5f2;padding:14px;margin:0 0 18px;\">" + escapeEmailHtml(message) + "</p>" +
        "<p style=\"font-size:12px;color:#777;margin:0;\">Link da sacola pronta: <a href=\"" + escapeEmailHtml(cartUrl) + "\" style=\"color:#171717;\">abrir</a></p>" +
        "</div><p style=\"text-align:center;font-size:11px;color:#999;margin:18px 0;\">MONTÊ — Aviso interno para a loja</p></div></body></html>";
}

async function sendStoreFollowupEmail({ subject, html, text, idempotencyKey }) {
    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json", "Accept": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ from: RESEND_FROM_NAME + " <" + RESEND_FROM_EMAIL + ">", to: storeFollowupRecipients(), subject, text, html, tags: [{ name: "type", value: "store_followup" }] })
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error("Resend API " + response.status + ": " + responseText.slice(0, 300));
}

async function storeFollowupPendingOrders(budget) {
    spend(budget);
    const rows = await supabaseRequest(
        "orders?status=eq.pending&store_followup_sent_at=is.null" +
        "&created_at=lt." + isoAgo(STORE_FOLLOWUP_ORDER_AFTER_MS) + "&created_at=gt." + isoAgo(REMINDER_WINDOW_MS) +
        "&select=id,order_nsu,order_code,customer_name,customer_email,customer_phone,customer_whatsapp,items,total,payment_method,created_at&order=created_at.asc&limit=5",
        { method: "GET" }
    );
    let sent = 0;
    for (const order of Array.isArray(rows) ? rows : []) {
        if (!budget.has(REMINDER_CALLS_EACH)) break;
        const mark = status => {
            spend(budget);
            return supabaseRequest("orders?id=eq." + encodeURIComponent(order.id), {
                method: "PATCH",
                headers: { "Prefer": "return=minimal" },
                body: JSON.stringify({ store_followup_sent_at: new Date().toISOString(), store_followup_status: status })
            });
        };
        const phone = brazilMobileDigits(order.customer_whatsapp) || brazilMobileDigits(order.customer_phone);
        if (!phone) { await mark("skipped_invalid_phone"); continue; }
        const later = await laterOrdersOf(order.customer_email, order.created_at, budget);
        if (later.length) { await mark(later.some(o => PAID_ORDER_STATUSES.includes(o.status)) ? "skipped_paid_later" : "skipped_newer_order"); continue; }
        spend(budget);
        const items = await availableReminderItems(order.items);
        if (!items.length) { await mark("skipped_sold_out"); continue; }
        const code = formatOrderCode(order.order_code || order.order_nsu);
        const firstName = reminderFirstName(order.customer_name);
        const cartUrl = cartRestoreUrl(items, "pagamento_pendente", "whatsapp");
        const message = "Oi" + (firstName ? ", " + firstName : "") + "! Aqui é da MONTÊ. Vi que o pagamento do seu pedido " + code +
            " (" + storeFollowupPieces(items) + ") não foi concluído. Aconteceu algum problema? Posso te ajudar a finalizar. " +
            "Sua sacola está pronta neste link: " + cartUrl;
        const whatsappUrl = "https://wa.me/55" + phone + "?text=" + encodeURIComponent(message);
        const name = safeString(order.customer_name) || "Cliente";
        const pix = safeString(order.payment_method).toLowerCase() === "pix";
        try {
            spend(budget);
            await sendStoreFollowupEmail({
                subject: "Chame no WhatsApp: " + name + " não concluiu o pagamento (" + code + ")",
                idempotencyKey: "monte-store-followup-order-" + order.id,
                html: storeFollowupEmailHtml({
                    eyebrow: "PAGAMENTO PENDENTE HÁ 30 MINUTOS",
                    title: name + " não concluiu o pagamento",
                    details: [
                        "Pedido: " + code,
                        "WhatsApp: " + formatBrazilMobile(phone),
                        "Pagamento escolhido: " + (pix ? "Pix" : "Cartão de crédito"),
                        "Total: " + formatEmailMoney(order.total)
                    ],
                    items,
                    whatsappUrl,
                    message,
                    cartUrl
                }),
                text: name + " não concluiu o pagamento do pedido " + code + ".\nWhatsApp: " + formatBrazilMobile(phone) +
                    "\n\nChamar no WhatsApp (mensagem pronta): " + whatsappUrl
            });
            await mark("sent");
            sent++;
            console.log("📲 Aviso para a loja chamar no WhatsApp (pagamento pendente):", code);
        } catch (error) {
            console.error("Aviso de WhatsApp para a loja —", code, error.message);
            await mark("error").catch(() => {});
        }
    }
    return sent;
}

async function storeFollowupAbandonedCarts(budget) {
    spend(budget);
    const rows = await supabaseRequest(
        "cart_snapshots?status=eq.active&store_followup_sent_at=is.null&customer_phone=not.is.null" +
        "&last_activity_at=lt." + isoAgo(STORE_FOLLOWUP_CART_AFTER_MS) + "&last_activity_at=gt." + isoAgo(REMINDER_WINDOW_MS) +
        "&select=id,customer_name,customer_phone,items,subtotal,created_at&order=last_activity_at.asc&limit=5",
        { method: "GET" }
    );
    let sent = 0;
    for (const cart of Array.isArray(rows) ? rows : []) {
        if (!budget.has(REMINDER_CALLS_EACH)) break;
        const mark = (status, extra = {}) => {
            spend(budget);
            return supabaseRequest("cart_snapshots?id=eq." + encodeURIComponent(cart.id), {
                method: "PATCH",
                headers: { "Prefer": "return=minimal" },
                body: JSON.stringify({ store_followup_sent_at: new Date().toISOString(), store_followup_status: status, ...extra })
            });
        };
        const phone = brazilMobileDigits(cart.customer_phone);
        if (!phone) { await mark("skipped_invalid_phone"); continue; }
        // Já virou pedido (o WhatsApp do pedido é o mesmo): pago conta como convertida; sem
        // pagamento, o aviso do pedido cuida.
        spend(budget);
        const orders = await supabaseRequest(
            "orders?customer_whatsapp=eq." + phone + "&created_at=gt." + encodeURIComponent(cart.created_at) + "&select=id,status&limit=10",
            { method: "GET" }
        );
        const orderList = Array.isArray(orders) ? orders : [];
        const paid = orderList.find(o => PAID_ORDER_STATUSES.includes(o.status));
        if (paid) { await mark("skipped_purchased", { status: "converted", converted_order_id: paid.id }); continue; }
        if (orderList.length) { await mark("skipped_has_order"); continue; }
        // Um aviso por WhatsApp a cada 7 dias para o mesmo número.
        spend(budget);
        const recent = await supabaseRequest(
            "cart_snapshots?customer_phone=eq." + encodeURIComponent(formatBrazilMobile(phone)) +
            "&store_followup_status=eq.sent&store_followup_sent_at=gt." + isoAgo(7 * 24 * 60 * 60 * 1000) + "&select=id&limit=1",
            { method: "GET" }
        );
        if (Array.isArray(recent) && recent.length) { await mark("skipped_recent_reminder"); continue; }
        spend(budget);
        const items = await availableReminderItems(cart.items);
        if (!items.length) { await mark("skipped_sold_out"); continue; }
        const firstName = reminderFirstName(cart.customer_name);
        const cartUrl = cartRestoreUrl(items, "sacola_guardada", "whatsapp");
        const message = "Oi" + (firstName ? ", " + firstName : "") + "! Aqui é da MONTÊ. Você guardou sua sacola com " +
            storeFollowupPieces(items) + ". As peças ainda estão disponíveis, mas o estoque é limitado. " +
            "Se quiser finalizar, sua sacola está aqui: " + cartUrl;
        const whatsappUrl = "https://wa.me/55" + phone + "?text=" + encodeURIComponent(message);
        const total = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0);
        try {
            spend(budget);
            await sendStoreFollowupEmail({
                subject: "Chame no WhatsApp: sacola guardada de " + formatEmailMoney(total),
                idempotencyKey: "monte-store-followup-cart-" + cart.id,
                html: storeFollowupEmailHtml({
                    eyebrow: "SACOLA PARADA HÁ 2 HORAS",
                    title: "Uma cliente deixou o WhatsApp na sacola",
                    details: [
                        (safeString(cart.customer_name) ? "Nome: " + safeString(cart.customer_name) : "Nome: não informado"),
                        "WhatsApp: " + formatBrazilMobile(phone),
                        "Peças: " + formatEmailMoney(total)
                    ],
                    items,
                    whatsappUrl,
                    message,
                    cartUrl
                }),
                text: "Sacola guardada com o WhatsApp " + formatBrazilMobile(phone) + " (" + formatEmailMoney(total) + ").\n\nChamar no WhatsApp (mensagem pronta): " + whatsappUrl
            });
            await mark("sent");
            sent++;
            console.log("📲 Aviso para a loja chamar no WhatsApp (sacola guardada).");
        } catch (error) {
            console.error("Aviso de WhatsApp para a loja (sacola) —", error.message);
            await mark("error").catch(() => {});
        }
    }
    return sent;
}

// Roda a cada 5 minutos no cron. Devolve quantas chamadas externas usou.
async function runCustomerUpkeep(calls) {
    const limit = Math.max(0, Math.floor(Number(calls) || 0));
    const budget = createCallBudget(limit);
    const steps = [expireOldPendingOrders];
    // Sem o Resend configurado não há como enviar: os lembretes esperam (nada é marcado).
    if (RESEND_API_KEY && RESEND_FROM_EMAIL) steps.push(remindPendingOrders);
    if (RESEND_API_KEY && RESEND_FROM_EMAIL && storeFollowupRecipients().length) steps.push(storeFollowupPendingOrders);
    if (RESEND_API_KEY && RESEND_FROM_EMAIL) steps.push(remindAbandonedCarts);
    if (RESEND_API_KEY && RESEND_FROM_EMAIL && storeFollowupRecipients().length) steps.push(storeFollowupAbandonedCarts);
    for (const step of steps) {
        if (!budget.has(2)) break;
        try {
            await step(budget);
        } catch (error) {
            if (!error?.budget) console.error("Lembretes/limpeza de pedidos:", error.message);
        }
    }
    return limit - budget.left;
}

/* =====================================================
   INICIAR SERVIDOR
===================================================== */

// Olist catalog synchronization is intentionally disabled.

// Renova o acesso à Olist mesmo sem vendas: o refresh token vence se ficar sem uso.
async function refreshOlistAccess() {
    if (!OLIST_SYNC_ENABLED || !OLIST_CLIENT_ID || !OLIST_CLIENT_SECRET) return;
    olistAccessToken = null;
    olistAccessTokenExpiresAt = 0;
    try {
        await getOlistAccessToken(false, true);
        console.log("🔑 Acesso Olist renovado.");
    } catch (error) {
        console.warn("Olist: renovação periódica falhou:", error.message);
    }
}

// Tarefas periódicas. No Render rodam em timers; no Cloudflare, pelos Cron Triggers
// do wrangler.jsonc ("* * * * *" = um pedido pago pendente e um lote da conferência
// Olist → site (estoque, preço e cores); a cada 3 horas = acesso Olist). Cada execução tem 50 chamadas externas:
// o pedido vai primeiro e o lote de estoque usa o que sobrar.
// Prazo de guarda (Política de Privacidade): estatísticas da loja por 13 meses e sacolas salvas
// (com o contato digitado no checkout) por 6 meses. Os eventos saem junto com a sessão (cascata).
const ANALYTICS_RETENTION_MS = 395 * 24 * 60 * 60 * 1000;
const CART_SNAPSHOT_RETENTION_MS = 183 * 24 * 60 * 60 * 1000;
async function purgeExpiredAnalytics() {
    const minimal = { method: "DELETE", headers: { Prefer: "return=minimal" } };
    await supabaseRequest("cart_snapshots?updated_at=lt." + isoAgo(CART_SNAPSHOT_RETENTION_MS), minimal);
    await supabaseRequest("site_sessions?last_seen_at=lt." + isoAgo(ANALYTICS_RETENTION_MS), minimal);
}

async function runScheduledTask(cron) {
    if (cron === "* * * * *") {
        const orders = await runPendingOlistSync().catch(() => ({ calls: 25 }));
        let used = orders?.calls || 0;
        // A cada 5 minutos: pedidos sem pagamento antigos expiram e saem os lembretes por e-mail.
        // Sobram pelo menos 17 chamadas para o lote de estoque.
        if (new Date().getUTCMinutes() % 5 === 2) {
            used += await runCustomerUpkeep(Math.min(25, WORKER_CALL_LIMIT - 4 - used - 17)).catch(() => 25);
        }
        return syncOlistStockBatch({ calls: WORKER_CALL_LIMIT - 4 - used })
            .catch(error => console.error("Estoque Olist:", error.message));
    }
    await purgeExpiredAnalytics().catch(error => console.error("Limpeza de estatísticas antigas:", error.message));
    return refreshOlistAccess();
}

function startNodeServer() {
    app.listen(
        PORT,
        () => {

            console.log(
                `🚀 Backend MONTÊ rodando na porta ${PORT}`
            );

            console.log(
                `💳 InfinitePay configurada para: ${INFINITEPAY_HANDLE}`
            );

            // Worker de segurança: pedidos pagos que não chegaram à Olist
            // são processados automaticamente, sem tocar no fluxo do pagamento.
            setTimeout(() => runPendingOlistSync().catch(() => {}), 10000);
            setInterval(() => runPendingOlistSync().catch(() => {}), 60000);

            // O refresh token da Olist vence se ficar sem uso; renova a cada 3 horas
            // enquanto o servidor estiver no ar, mesmo sem vendas.
            setInterval(refreshOlistAccess, 3 * 60 * 60 * 1000);

            // Olist → site (estoque, preço e cores), um lote por minuto.
            setInterval(() => syncOlistStockBatch().catch(() => {}), 60000);

            // Pedidos sem pagamento antigos e lembretes por e-mail, a cada 5 minutos.
            setInterval(() => runCustomerUpkeep(40).catch(() => {}), 5 * 60 * 1000);
        }
    );
}

// Último tratamento de erro: sem ele o Express devolve a pilha (stack) com caminhos do servidor.
// JSON inválido ou grande demais vira uma resposta simples; o resto, erro genérico.
// Páginas digitadas sem ".html" (/minhas-compras) levam à página certa; qualquer outro endereço
// que não existe leva para a loja, em vez do "Cannot GET" do Express.
const PAGES_WITHOUT_EXTENSION = new Set(["minhas-compras", "trocas-devolucoes", "termos-de-compra", "politica-privacidade", "entrega-frete"]);
app.use((req, res) => {
    const page = req.path.replace(/^\/+|\/+$/g, "").toLowerCase();
    if ((req.method === "GET" || req.method === "HEAD") && PAGES_WITHOUT_EXTENSION.has(page)) {
        const query = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
        return res.redirect(301, "/" + page + ".html" + query);
    }
    if (req.path.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) return res.status(404).json({ success: false, message: "Não encontrado." });
    return res.redirect(302, "/");
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error?.status || error?.statusCode) || 500;
    if (status >= 500) console.error("Erro não tratado:", req.method, req.path, error?.message || error);
    const message = status === 413 ? "Conteúdo grande demais." : status >= 400 && status < 500 ? "Requisição inválida." : "Erro interno.";
    return res.status(status >= 400 && status < 600 ? status : 500).json({ success: false, message });
});

// "node server.js" (Render) sobe o servidor; o Worker importa o app (backend/worker.js).
if (!IS_WORKERS && require.main === module) startNodeServer();

module.exports = { app, runScheduledTask, runCustomerUpkeep, setSiteAssets, setBackgroundRunner, serveMediaRequest };
