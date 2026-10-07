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

// Preço unitário com o desconto de 5% do Pix, em centavos. É o mesmo valor
// cobrado pela InfinitePay no checkout e enviado à Olist.
function pixDiscountedUnitCents(price) {
    return Math.round(Math.round(Number(price || 0) * 100) * 0.95);
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
        orderItems.push({
            produto: {id:Number(product.id), tipo:"P"},
            quantidade: Math.max(1, Number(item.quantity || 1)),
            // No Pix a cliente pagou 5% a menos nos produtos; a Olist recebe o valor real.
            valorUnitario: isPix ? pixDiscountedUnitCents(item.price) / 100 : Number(item.price || 0),
            infoAdicional: safeString(item.variant_color || item.color)
                ? "Cor: " + safeString(item.variant_color || item.color)
                : null
        });
    }

    if (!orderItems.length) throw new Error("OLIST_ORDER_WITHOUT_ITEMS");

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
            "orders?status=eq.paid&or=(olist_sync_status.is.null,olist_sync_status.neq.completed)&select=*&order=paid_at.asc&limit=10",
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

app.get("/api/olist/auth", (req, res) => {
    // Só quem está logado no painel pode trocar a conta Olist que recebe os pedidos.
    if (!getAdminSession(req)) {
        return res.status(401).send("<p>Entre no painel da MONTÊ (<a href=\"/admin\">/admin</a>) e use o botão <strong>Reconectar Olist</strong> na aba Estoque.</p>");
    }
    if (!OLIST_CLIENT_ID || !OLIST_CLIENT_SECRET) {
        return res.status(503).send("Olist OAuth não está configurado no servidor.");
    }
    // Estado assinado (vale 10 minutos): funciona mesmo se a volta da Olist cair em outra instância.
    const state = createSignedToken({purpose:"olist-oauth"}, 10 * 60 * 1000);
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

    if (oauthError) return res.status(400).send("Autorização Olist não concluída.");
    if (!state || !expiresAt || expiresAt < Date.now()) return res.status(400).send("Solicitação de autorização expirada.");
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
                    (oauthDescription ? "Detalhe: " + oauthDescription : "")
                );
            }

            return res.status(502).send(
                "Falha OAuth da Olist (HTTP " + response.status + "). " +
                (oauthCode ? oauthCode + ". " : "") +
                (oauthDescription || "A Olist não retornou um token OAuth válido.")
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
        return res.status(502).json({success:false,configured:true,reachable:false,message:String(error.message || "Olist indisponível")});
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
                message,
                details
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



const SUPABASE_URL = process.env.SUPABASE_URL || "https://uvrhougaurupvkxmezwy.supabase.co";
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
const PIX_KEY = safeString(process.env.PIX_KEY).replace(/[^0-9A-Za-z@._+\-]/g, "");
const PIX_MERCHANT_NAME = safeString(process.env.PIX_MERCHANT_NAME || "MONTE").slice(0, 25);
const PIX_MERCHANT_CITY = safeString(process.env.PIX_MERCHANT_CITY || "FORTALEZA").slice(0, 15);
function pixField(id, value) { const str = String(value ?? ""); return String(id).padStart(2, "0") + String(str.length).padStart(2, "0") + str; }
function crc16Pix(payload) {
    let crc = 0xFFFF;
    for (let i = 0; i < payload.length; i++) {
        crc ^= payload.charCodeAt(i) << 8;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, "0");
}
function buildPixPayload(amount, txid = "***") {
    if (!PIX_KEY) throw new Error("PIX_KEY não configurada no servidor.");
    const merchantAccount = pixField(0, "BR.GOV.BCB.PIX") + pixField(1, PIX_KEY);
    const additionalData = pixField(5, String(txid).replace(/[^A-Za-z0-9*]/g, "").slice(0, 25) || "***");
    const body = [
        pixField(0, "01"), pixField(26, merchantAccount), pixField(52, "0000"),
        pixField(53, "986"), pixField(54, Number(amount).toFixed(2)), pixField(58, "BR"),
        pixField(59, PIX_MERCHANT_NAME), pixField(60, PIX_MERCHANT_CITY), pixField(62, additionalData)
    ].join("") + "6304";
    return body + crc16Pix(body);
}


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
            return qty + "x " + name + (variant ? " (" + variant + ")" : "") + " — " + formatWhatsAppCurrency(unit);
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
    if (/^\d{4}$/.test(raw)) return "MONTÊ-" + raw;
    if (/^MONTÊ-\d{4}$/i.test(raw)) return "MONTÊ-" + raw.slice(-4);
    return raw;
}

function normalizeOrderCode(value) {
    const raw = safeString(value).trim();
    const match = raw.match(/^MONT[EÊ]-?(\d{4})$/i);
    return match ? match[1] : raw;
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
    const html = "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
      "<div style=\"max-width:620px;margin:0 auto;padding:40px 20px;\"><div style=\"background:#111;color:#fff;text-align:center;padding:24px 20px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
      "<div style=\"background:#fff;padding:38px 30px;\"><p style=\"margin:0 0 12px;font-size:12px;letter-spacing:2px;color:#777;\">COMPRA CONFIRMADA</p>" +
      "<h1 style=\"margin:0 0 18px;font-size:28px;font-weight:500;\">Obrigada pela sua compra, " + escapeEmailHtml(customerName) + ".</h1>" +
      "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Seu pagamento foi confirmado e seu pedido já está registrado na MONTÊ.</p>" +
      "<div style=\"margin:28px 0;padding:20px;background:#f7f5f2;\"><p style=\"margin:0 0 8px;font-size:11px;letter-spacing:1.5px;color:#777;\">NÚMERO DO PEDIDO</p><strong style=\"font-size:20px;\">" + escapeEmailHtml(orderCode) + "</strong><p style=\"margin:14px 0 0;font-size:14px;color:#555;\">Total: <strong>R$ " + total.toFixed(2).replace(".", ",") + "</strong></p></div>" +
      "<p style=\"font-size:15px;line-height:1.7;color:#555;\">Acompanhe o status do seu pedido e novas atualizações pela área <strong>Minhas Compras</strong>.</p>" +
      "<div style=\"text-align:center;margin:30px 0;\"><a href=\"" + purchasesUrl + "\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:15px 26px;font-size:13px;letter-spacing:1.5px;\">ACESSAR MINHAS COMPRAS</a></div></div>" +
      "<p style=\"text-align:center;font-size:11px;color:#999;margin:20px 0;\">MONTÊ — Bolsas e acessórios</p></div></body></html>";
    const text = "Compra confirmada na MONTÊ\n\nPedido: " + orderCode + "\nTotal: R$ " + total.toFixed(2).replace(".", ",") + "\n\nAcesse: " + purchasesUrl;
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
            return qty + "x " + name + (color ? " (" + color + ")" : "") + " — R$ " + unit.toFixed(2).replace(".", ",");
        }).join("<br>")
        : "Consultar itens do pedido no painel.";
    const html =
        "<html><body style=\"margin:0;background:#f7f5f2;font-family:Arial,Helvetica,sans-serif;color:#171717;\">" +
        "<div style=\"max-width:680px;margin:0 auto;padding:32px 18px;\">" +
        "<div style=\"background:#111;color:#fff;text-align:center;padding:22px;letter-spacing:6px;font-size:24px;\">MONTÊ</div>" +
        "<div style=\"background:#fff;padding:30px;\">" +
        "<p style=\"margin:0 0 8px;font-size:11px;letter-spacing:2px;color:#777;\">NOVA VENDA</p>" +
        "<h1 style=\"margin:0 0 22px;font-size:28px;font-weight:500;\">Pagamento confirmado</h1>" +
        "<div style=\"padding:18px;background:#f7f5f2;margin-bottom:20px;\"><strong style=\"font-size:20px;\">" + escapeEmailHtml(orderCode) + "</strong><br><span style=\"font-size:14px;color:#555;\">Total: <strong>R$ " + total.toFixed(2).replace(".", ",") + "</strong></span></div>" +
        "<h3 style=\"font-size:14px;letter-spacing:1px;\">CLIENTE</h3>" +
        "<p style=\"line-height:1.7;font-size:14px;\">Nome: " + escapeEmailHtml(customerName) + "<br>E-mail: " + escapeEmailHtml(customerEmail) + "<br>Telefone: " + escapeEmailHtml(customerPhone) + "<br>Endereço: " + escapeEmailHtml(address) + "</p>" +
        "<h3 style=\"font-size:14px;letter-spacing:1px;\">PRODUTOS</h3>" +
        "<p style=\"line-height:1.8;font-size:14px;\">" + items + "</p>" +
        "<p style=\"font-size:14px;line-height:1.7;\"><strong>Pagamento:</strong> " + escapeEmailHtml(paymentMethod) + "<br><strong>Frete:</strong> R$ " + Number(order.shipping || 0).toFixed(2).replace(".", ",") + "<br><strong>Total:</strong> R$ " + total.toFixed(2).replace(".", ",") + "</p>" +
        "</div><p style=\"text-align:center;font-size:11px;color:#999;margin:18px 0;\">MONTÊ — Notificação interna de venda</p></div></body></html>";
    const text =
        "NOVA VENDA MONTÊ\n\nPedido: " + orderCode + "\nCliente: " + customerName +
        "\nE-mail: " + customerEmail + "\nTelefone: " + customerPhone +
        "\nProdutos: " + (Array.isArray(order.items) ? order.items.map(i => (i.quantity || 1) + "x " + (i.name || i.product_name || "Produto")).join("; ") : "Consultar pedido") +
        "\nPagamento: " + paymentMethod + "\nTotal: R$ " + total.toFixed(2).replace(".", ",");
    const response = await fetch("https://api.resend.com/emails", {
        method:"POST",
        headers:{"Authorization":"Bearer "+RESEND_API_KEY,"Content-Type":"application/json","Accept":"application/json"},
        body:JSON.stringify({from:RESEND_FROM_NAME+" <"+RESEND_FROM_EMAIL+">",to:recipients,subject:"MONTÊ — NOVA VENDA "+orderCode+" — R$ "+total.toFixed(2).replace(".", ","),text,html})
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

const METROPOLITAN_CITIES = new Set(["AQUIRAZ","CAUCAIA","EUSEBIO","GUAIUBA","ITAITINGA","MARACANAU"]);

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
   REDIRECIONAMENTO INFINITEPAY
   Desktop: navegação direta pelo frontend.
   Mobile: endpoint same-origin com HTTP 302, evitando bloqueios
   de Safari/iOS e navegadores embutidos.
===================================================== */
app.get("/pagamento-infinitepay", (req, res) => {
    try {
        const target = String(req.query?.url || "").trim();
        const parsed = new URL(target);

        if (parsed.protocol !== "https:" || !("checkout.infinitepay.io" === parsed.hostname || "checkout.infinitepay.com.br" === parsed.hostname || "buy.infinitepay.com" === parsed.hostname)) {
            return res.status(400).send("Link de pagamento inválido.");
        }

        res.setHeader("Cache-Control", "no-store");
        return res.redirect(302, parsed.href);
    } catch {
        return res.status(400).send("Link de pagamento inválido.");
    }
});

/* =====================================================
   MIDDLEWARES
===================================================== */

const allowedOrigins = new Set([
    SITE_URL.replace(/\/$/, ""),
    PUBLIC_SITE_URL,
    "https://oficialmontee.com.br",
    "https://www.oficialmontee.com.br",
    "https://monte-site-itjk.onrender.com",
    "https://monte-site.vitorvolpe14.workers.dev",
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
    "script-src 'self' https://*.googletagmanager.com",
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

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    if (IS_WORKERS || req.secure || req.headers["x-forwarded-proto"] === "https") {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (req.path.startsWith("/api/admin/")) {
        res.setHeader("Cache-Control", "no-store");
    }
    next();
});

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) {
                return callback(null, true);
            }
            return callback(new Error("Origem não autorizada."));
        },
        methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: false
    })
);

// Fotos chegam em base64 só nas rotas de upload do painel (até 20 MB por foto). O resto da
// API aceita no máximo 1 MB por requisição: menos espaço para abuso e menos CPU no Cloudflare.
app.use("/api/admin/uploads", express.json({ limit: "30mb" }));
app.use(express.json({ limit: "1mb" }));

/* =====================================================
   RATE LIMITING — proteção contra abuso de endpoints
===================================================== */
// IP real do visitante: no Cloudflare vem no cabeçalho CF-Connecting-IP.
function clientIp(req) {
    return safeString(req.headers["cf-connecting-ip"]) || req.ip || "unknown";
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
function createOrderConfirmationToken(orderNsu){return createSignedToken({purpose:"order-confirmation",order_nsu:String(orderNsu)},30*60*1000)}
function verifyOrderConfirmationToken(token,orderNsu){const data=verifySignedToken(token);return !!(data&&data.purpose==="order-confirmation"&&String(data.order_nsu)===String(orderNsu))}
const adminLoginAttempts = new Map();
function parseCookies(req){const h=req.headers.cookie||"";const o={};h.split(";").filter(Boolean).forEach(p=>{const i=p.indexOf("=");if(i<0)return;const v=p.slice(i+1).trim();try{o[p.slice(0,i).trim()]=decodeURIComponent(v)}catch{o[p.slice(0,i).trim()]=v}});return o}
function getAdminSession(req){const t=parseCookies(req)["monte_admin_session"];if(!t||!ADMIN_EMAIL)return null;const s=verifySignedToken(t);if(!s||s.purpose!=="admin"||s.email!==ADMIN_EMAIL)return null;return {token:t,email:s.email,expiresAt:s.exp}}
function requireAdmin(req,res,next){
    const origin = safeString(req.headers.origin);
    if (origin && !allowedOrigins.has(origin.replace(/\/$/, ""))) {
        return res.status(403).json({success:false,message:"Origem não autorizada."});
    }
    const s=getAdminSession(req);
    if(!s)return res.status(401).json({success:false,message:"Acesso administrativo não autorizado."});
    req.adminSession=s;
    next();
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
        if(email!==ADMIN_EMAIL.toLowerCase()||!passwordMatches(password)){await failedLogin(req,email);return res.status(401).json({success:false,message:"E-mail ou senha incorretos."})}
        await clearLoginFailures(req,email);
        const token=createSignedToken({purpose:"admin",email:ADMIN_EMAIL},ADMIN_SESSION_TTL);
        setAdminCookie(res,token);
        return res.json({success:true,email:ADMIN_EMAIL});
    }catch(error){console.error("Login admin:",error);return res.status(500).json({success:false,message:"Não foi possível entrar agora."})}
});
app.post("/api/admin/logout",(req,res)=>{clearAdminCookie(res);return res.json({success:true})});
app.get("/api/admin/session",(req,res)=>{const s=getAdminSession(req);if(!s)return res.status(401).json({success:false});return res.json({success:true,email:s.email})});
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
async function readCarouselImages(){return (await readCarouselConfig()).images}
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
  return config.images.map(src=>({src,small:smallImageUrl(src),width:sizes[src]?.[0]||null,height:sizes[src]?.[1]||null}));
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
  }catch(e){console.error("Admin carousel PUT:",e);return res.status(500).json({success:false,message:e.message||"Não foi possível salvar o carrossel."})}
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
app.post("/api/analytics/event",analyticsRateLimit,async(req,res)=>{
  try{
    const b=req.body||{}, allowed=["page_view","view_product","add_to_cart","remove_from_cart","begin_checkout","checkout_started","checkout_completed","purchase"];
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
      session_id:session.id,visitor_id,event_name,path:safeString(b.path).slice(0,500),product_id:safeString(b.product_id)||null,
      product_name:safeString(b.product_name).slice(0,160)||null,variant_id:safeString(b.variant_id)||null,
      quantity:Number.isFinite(Number(b.quantity))?Math.max(1,Math.min(100,Number(b.quantity))):null,
      value:Number.isFinite(Number(b.value))?Number(b.value):null,metadata:b.metadata&&typeof b.metadata==="object"?b.metadata:{}
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
    const row={visitor_id,session_id,cart_key:session_key,customer_name:safeString(b.customer_name).slice(0,160)||null,customer_email:safeString(b.customer_email).slice(0,160)||null,customer_phone:safeString(b.customer_phone).slice(0,60)||null,items:Array.isArray(b.items)?b.items.slice(0,50):[],subtotal,shipping,total,status:"active",last_activity_at:new Date().toISOString(),updated_at:new Date().toISOString()};
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

function isAllowedProductImageUrl(value) {
    try {
        const parsed = new URL(String(value || ""));
        const supabaseHost = new URL(SUPABASE_URL).host;
        return parsed.protocol === "https:" &&
            parsed.host === supabaseHost &&
            parsed.pathname.startsWith("/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/");
    } catch {
        return false;
    }
}

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
    if (!response.ok) throw new Error("Upload da imagem falhou (" + response.status + ").");
    return SUPABASE_URL + "/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/" + objectPath;
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
    if (!response.ok) throw new Error("Upload da imagem do carrossel falhou (" + response.status + ").");
    return SUPABASE_URL + "/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/" + objectPath;
}
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
    if (!response.ok) throw new Error("Upload da imagem falhou (" + response.status + ").");
    return SUPABASE_URL + "/storage/v1/object/public/" + PRODUCT_IMAGE_BUCKET + "/" + objectPath;
}
app.post("/api/admin/uploads/optimized-image", requireAdmin, async (req, res) => {
    try {
        if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
        const productId = safeString(req.body?.product_id);
        if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new Error("Produto inválido.");
        const contentType = safeString(req.body?.content_type).toLowerCase();
        if (!["image/webp", "image/jpeg"].includes(contentType)) throw new Error("Formato inválido para a foto otimizada.");
        const decode = value => Buffer.from(String(value || "").replace(/^data:[^;]+;base64,/, ""), "base64");
        const full = decode(req.body?.full_base64), small = decode(req.body?.small_base64);
        const fullInfo = await validateImageBuffer(full, contentType);
        await validateImageBuffer(small, contentType);
        if (full.length > 6 * 1024 * 1024 || small.length > 2 * 1024 * 1024) throw new Error("A foto otimizada ficou grande demais.");
        const ext = contentType === "image/webp" ? "webp" : "jpg";
        const name = Date.now() + "-" + crypto.randomBytes(5).toString("hex");
        const folder = "opt/" + productId + "/";
        const [url, smallUrl] = await Promise.all([
            uploadStorageObject(folder + name + "-full." + ext, contentType, full),
            uploadStorageObject(folder + name + "-small." + ext, contentType, small)
        ]);
        return res.status(201).json({ success: true, url, small: smallUrl, width: fullInfo.width, height: fullInfo.height });
    } catch (e) {
        console.error("Admin optimized image upload:", e);
        return res.status(400).json({ success: false, message: e.message || "Não foi possível enviar a foto." });
    }
});

// Troca as fotos de um produto pelas versões otimizadas. A lista anterior fica guardada
// em images_original (só na primeira vez) para poder voltar atrás.
app.put("/api/admin/products/:id/images", requireAdmin, async (req, res) => {
    try {
        const id = safeString(req.params.id);
        if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, message: "Produto inválido." });
        const images = Array.isArray(req.body?.images) ? req.body.images.map(safeString).filter(Boolean).slice(0, 30) : [];
        if (!images.every(url => isAllowedProductImageUrl(url) || /^\/?assets\//.test(url))) return res.status(400).json({ success: false, message: "Foto inválida na lista." });
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
    return res.status(400).json({success:false,message:e.message||"Não foi possível enviar a imagem."});
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
        return res.status(400).json({ success: false, message: error.message || "Não foi possível enviar a imagem." });
    }
});

function sanitizeProductPayload(b={}){return{name:safeString(b.name),sku:safeString(b.sku)||null,category:safeString(b.category)||"bolsas",price:Number(b.price||0),sale_price:b.sale_price===null||b.sale_price===""||b.sale_price===undefined?null:Number(b.sale_price),description:safeString(b.description),images:Array.isArray(b.images)?b.images:[],shipping_weight_kg:b.shipping_weight_kg===null||b.shipping_weight_kg===""||b.shipping_weight_kg===undefined?null:Number(b.shipping_weight_kg),shipping_height_cm:b.shipping_height_cm===null||b.shipping_height_cm===""||b.shipping_height_cm===undefined?null:Number(b.shipping_height_cm),shipping_width_cm:b.shipping_width_cm===null||b.shipping_width_cm===""||b.shipping_width_cm===undefined?null:Number(b.shipping_width_cm),shipping_length_cm:b.shipping_length_cm===null||b.shipping_length_cm===""||b.shipping_length_cm===undefined?null:Number(b.shipping_length_cm),is_new:Boolean(b.is_new),is_sale:Boolean(b.is_sale),active:b.active!==false}}
app.post("/api/admin/products",requireAdmin,async(req,res)=>{try{publicCache.delete("catalog");const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest("products",{method:"POST",body:JSON.stringify(p)});return res.status(201).json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products POST:",e);return res.status(500).json({success:false,message:e.message})}});
app.put("/api/admin/products/:id",requireAdmin,async(req,res)=>{try{publicCache.delete("catalog");const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest(`products?id=eq.${encodeURIComponent(req.params.id)}`,{method:"PATCH",body:JSON.stringify(p)});return res.json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products PUT:",e);return res.status(500).json({success:false,message:e.message})}});
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
   ESTOQUE — OLIST → SITE (só baixa)
   O site lê o estoque disponível de cada peça na Olist e, quando lá
   houver menos unidades do que no site, baixa o site para o mesmo
   número. Nunca aumenta o estoque do site e nunca escreve na Olist:
   assim uma venda do site que a Olist ainda não processou não faz o
   estoque voltar. Confere em lotes pequenos a cada minuto (o plano gratuito
   do Cloudflare permite 50 chamadas externas por execução), recomeça a
   rodada alguns minutos depois de terminar e confere de novo, na hora da
   compra, as peças do carrinho.
===================================================== */
const OLIST_STOCK_PAUSE_MS = 900;
const OLIST_STOCK_STATUS_KEY = "olist_stock_sync";
// Pior caso de uma peça: achar o SKU de novo (3 chamadas, duas vezes) e baixar com nova tentativa (4).
const OLIST_STOCK_VARIANT_CALLS = 10;
const OLIST_STOCK_PAGE = 60;
const OLIST_STOCK_BATCH_MS = 40 * 1000;
const OLIST_STOCK_LEASE_MS = 90 * 1000;
// Intervalo entre o fim de uma rodada automática e o começo da próxima.
const OLIST_STOCK_CYCLE_GAP_MS = 5 * 60 * 1000;

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

// Baixa o estoque da variação até "target" (nunca aumenta) e registra no histórico.
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

// Estado guardado no Supabase: a rodada em andamento (cycle, com o cursor "after"),
// a última rodada concluída (last) e a trava do lote que está rodando (lease_until).
async function readOlistStockState() {
    const rows = await supabaseRequest("kv_store_48db9b7e?key=eq." + OLIST_STOCK_STATUS_KEY + "&select=value&limit=1", { method: "GET" });
    const value = rows?.[0]?.value || {};
    // Formato antigo (a rodada inteira de uma vez): vira a última rodada concluída.
    if (value.ran_at && !value.version) return { version: 2, last: value, cycle: null, lease_until: 0 };
    return { version: 2, last: value.last || null, cycle: value.cycle || null, lease_until: Number(value.lease_until) || 0 };
}

async function writeOlistStockState(state) {
    await supabaseRequest("kv_store_48db9b7e?on_conflict=key", {
        method: "POST",
        headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: OLIST_STOCK_STATUS_KEY, value: { ...state, version: 2, updated_at: new Date().toISOString() } })
    });
}

// Um lote da rodada: confere as próximas peças até gastar as chamadas ou o tempo.
// restart começa uma rodada nova (botão do painel); cycleId diz qual rodada o painel acompanha.
async function syncOlistStockBatch({ trigger = "agendada", calls = WORKER_CALL_LIMIT - 4, restart = false, cycleId = "", maxMs = OLIST_STOCK_BATCH_MS } = {}) {
    if (!OLIST_SYNC_ENABLED) return { skipped: "disabled" };
    const started = Date.now();
    const budget = createCallBudget(calls);
    // Ler e travar o estado, consultar as peças e gravar no fim: 4 chamadas, mais uma peça.
    if (!budget.has(4 + 3 + OLIST_STOCK_VARIANT_CALLS)) return { skipped: "budget" };

    budget.use();
    const state = await readOlistStockState();
    if (state.lease_until > Date.now()) return { skipped: "running", state };
    // O painel acompanhava uma rodada que já terminou (o lote automático fechou).
    if (cycleId && !restart && state.cycle?.id !== cycleId) return { done: true, state, cycle_id: cycleId };

    let cycle = restart ? null : state.cycle;
    if (!cycle) {
        const lastEnd = Date.parse(state.last?.finished_at || "") || 0;
        if (!restart && Date.now() - lastEnd < OLIST_STOCK_CYCLE_GAP_MS) return { skipped: "rest", state };
        cycle = { id: new Date().toISOString(), started_at: new Date().toISOString(), trigger, after: "", checked: 0, lowered: [], not_found: [], errors: 0 };
    }
    budget.use();
    await writeOlistStockState({ ...state, cycle, lease_until: Date.now() + OLIST_STOCK_LEASE_MS });

    const loweredNow = [];
    let finished = false;
    budget.use(); // gravação final
    try {
        await ensureOlistAccess(budget);
        budget.use();
        // Só peças ativas, com SKU e com estoque no site: as zeradas não têm o que baixar.
        const variants = await supabaseRequest(
            "product_variants?select=id,sku,stock,color,olist_product_id,products!inner(name,active)" +
            "&active=eq.true&stock=gt.0&sku=not.is.null&products.active=eq.true" +
            (cycle.after ? "&id=gt." + encodeURIComponent(cycle.after) : "") +
            "&order=id.asc&limit=" + OLIST_STOCK_PAGE,
            { method: "GET" }
        );
        const list = Array.isArray(variants) ? variants : [];
        let index = 0;
        for (; index < list.length; index++) {
            const variant = list[index];
            if (!budget.has(OLIST_STOCK_VARIANT_CALLS) || Date.now() - started > maxMs) break;
            if (safeString(variant.sku)) {
                const label = { product: safeString(variant.products?.name), color: safeString(variant.color), sku: safeString(variant.sku) };
                try {
                    const { available, found } = await olistAvailableForVariant(variant, budget);
                    cycle.checked++;
                    if (!found) cycle.not_found.push(label);
                    else if (available !== null && available < Number(variant.stock || 0)) {
                        const change = await lowerSiteStock(variant, available, "Estoque da Olist: " + available + " disponível", budget);
                        if (change.changed) loweredNow.push({ ...label, from: change.from, to: change.to });
                    }
                } catch (error) {
                    // Limite da Olist ou das chamadas: a peça fica para o próximo lote.
                    if (error?.status === 429 || error?.budget) break;
                    if (/OLIST_AUTH|OLIST_SYNC_DISABLED/.test(String(error.message))) throw error;
                    cycle.errors++;
                    console.error("Estoque Olist —", variant.sku, error.message);
                }
                await pause(OLIST_STOCK_PAUSE_MS);
            }
            cycle.after = variant.id;
        }
        finished = index >= list.length && list.length < OLIST_STOCK_PAGE;
    } catch (error) {
        // Sem acesso à Olist: encerra a rodada com o aviso para o painel.
        cycle.error = /OLIST_AUTH/.test(String(error.message))
            ? "A conexão com a Olist expirou. Clique em RECONECTAR OLIST."
            : "Não foi possível consultar a Olist agora.";
        console.error("Estoque Olist:", error.message);
        finished = true;
    }

    cycle.lowered = cycle.lowered.concat(loweredNow).slice(-100);
    cycle.not_found = cycle.not_found.slice(0, 60);
    const next = { last: state.last, cycle, lease_until: 0 };
    if (finished) {
        next.last = { ...cycle, ran_at: cycle.started_at, finished_at: new Date().toISOString() };
        next.cycle = null;
    }
    await writeOlistStockState(next).catch(error => console.error("Estoque Olist — status não salvo:", error.message));
    if (loweredNow.length) console.log("📦 Estoque do site baixado pela Olist:", loweredNow);
    return { done: finished, state: next, cycle_id: cycle.id, lowered: loweredNow };
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
    const cycle = state?.cycle ? { id: state.cycle.id, started_at: state.cycle.started_at, trigger: state.cycle.trigger, checked: state.cycle.checked, lowered: state.cycle.lowered, errors: state.cycle.errors } : null;
    return { last: state?.last || null, cycle, running: Number(state?.lease_until || 0) > Date.now() };
}

app.get("/api/admin/olist/stock-sync", requireAdmin, async (req, res) => {
    try {
        const state = await readOlistStockState();
        return res.json({ success: true, enabled: OLIST_SYNC_ENABLED, ...olistStockStatusPayload(state) });
    } catch (error) {
        console.error("Estoque Olist — status:", error);
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
        console.error("Estoque Olist — painel:", error);
        return res.status(500).json({ success: false, message: "Não foi possível conferir o estoque agora." });
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




app.patch("/api/admin/orders/:id/status",requireAdmin,async(req,res)=>{
    try{
        const id=encodeURIComponent(req.params.id);
        const status=safeString(req.body?.status).toLowerCase();
        const allowed=["pending","expired","paid","processing","shipped","delivered"];
        if(!allowed.includes(status)) return res.status(400).json({success:false,message:"Status inválido."});
        const patch={status,updated_at:new Date().toISOString()};
        if(status==="processing") patch.processing_at=new Date().toISOString();
        if(status==="shipped"){
            patch.shipping_carrier=safeString(req.body?.shipping_carrier)||null;
            patch.tracking_code=safeString(req.body?.tracking_code)||null;
            patch.tracking_url=safeString(req.body?.tracking_url)||null;
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
   INSTAGRAM — FEED PROXY
   O frontend consulta este endpoint do próprio domínio.
   A credencial do Instagram permanece somente no Render.
===================================================== */
const INSTAGRAM_GRAPH_API_VERSION = safeString(process.env.INSTAGRAM_GRAPH_API_VERSION || "v23.0");
const INSTAGRAM_ACCESS_TOKEN = safeString(process.env.INSTAGRAM_ACCESS_TOKEN);
const INSTAGRAM_USER_ID = safeString(process.env.INSTAGRAM_USER_ID);
const INSTAGRAM_CACHE_TTL_MS = 10 * 60 * 1000;
let instagramFeedCache = { expiresAt: 0, data: null };

app.get("/api/instagram/feed", async (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    try {
        const now = Date.now();
        if (instagramFeedCache.data && instagramFeedCache.expiresAt > now) {
            return res.json(instagramFeedCache.data);
        }

        if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_USER_ID) {
            return res.status(503).json({
                success: false,
                configured: false,
                message: "Instagram não configurado no Render."
            });
        }

        const fields = [
            "id",
            "caption",
            "media_type",
            "media_url",
            "thumbnail_url",
            "permalink",
            "timestamp"
        ].join(",");

        const graphUrl = new URL(
            `https://graph.facebook.com/${INSTAGRAM_GRAPH_API_VERSION}/${encodeURIComponent(INSTAGRAM_USER_ID)}/media`
        );
        graphUrl.searchParams.set("fields", fields);
        graphUrl.searchParams.set("limit", "12");
        graphUrl.searchParams.set("access_token", INSTAGRAM_ACCESS_TOKEN);

        const response = await fetch(graphUrl, {
            headers: { "Accept": "application/json" }
        });

        const responseText = await response.text();
        let data = {};
        try { data = responseText ? JSON.parse(responseText) : {}; }
        catch { data = { raw: responseText }; }

        if (!response.ok) {
            console.error("Instagram Graph API:", response.status, data);
            return res.status(502).json({
                success: false,
                configured: true,
                message: "Não foi possível consultar o Instagram agora."
            });
        }

        const items = Array.isArray(data?.data)
            ? data.data
                .filter(item => item && (item.media_url || item.thumbnail_url))
                .map(item => ({
                    id: String(item.id || ""),
                    media_type: String(item.media_type || ""),
                    // Em vídeos, media_url aponta para o .mp4; a capa fica em thumbnail_url.
                    image_url: String((item.media_type === "VIDEO" ? item.thumbnail_url : item.media_url) || item.thumbnail_url || item.media_url || ""),
                    permalink: String(item.permalink || "https://www.instagram.com/oficialmonte_/"),
                    caption: String(item.caption || ""),
                    timestamp: item.timestamp || null
                }))
            : [];

        const payload = {
            success: true,
            configured: true,
            items
        };

        instagramFeedCache = {
            expiresAt: now + INSTAGRAM_CACHE_TTL_MS,
            data: payload
        };

        return res.json(payload);
    } catch (error) {
        console.error("Instagram feed:", error);
        return res.status(500).json({
            success: false,
            configured: Boolean(INSTAGRAM_ACCESS_TOKEN && INSTAGRAM_USER_ID),
            message: "Erro ao carregar o Instagram."
        });
    }
});


/* =====================================================
   ÁREA GERENCIAL
   Rota explícita para o painel. O Render executa o backend em /backend,
   enquanto admin.html permanece na raiz do repositório.
===================================================== */
app.get("/admin", (req, res) => sendSitePage(res, "admin.html"));

app.get("/admin/", (req, res) => sendSitePage(res, "admin.html"));


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
        const [html, catalog, slides] = await Promise.all([
            readSitePage("index.html"),
            getPublicCatalog().catch(error => { console.error("Página inicial — catálogo:", error.message); return null; }),
            cachedPublic("carousel", 60 * 1000, carouselSlides).catch(error => { console.error("Página inicial — carrossel:", error.message); return null; })
        ]);
        let page = html;
        if (Array.isArray(slides) && slides.length) {
            page = page
                .replace(/<!-- SLIDES -->[\s\S]*?<!-- FIM DOS SLIDES -->/, heroSlidesHtml(slides))
                .replace('<div id="carouselSlides"', '<div id="carouselSlides" data-ssr="1"');
            const first = slides[0];
            const preload = '<link rel="preload" as="image" href="' + escapeAttribute(first.src) + '"' +
                (first.small ? ' imagesrcset="' + escapeAttribute(first.small) + ' 960w, ' + escapeAttribute(first.src) + ' 2000w" imagesizes="100vw"' : "") + ' fetchpriority="high">';
            page = page.replace("<!-- PRELOAD DO BANNER -->", preload);
        }
        if (Array.isArray(catalog)) {
            page = page.replace("<!-- CATÁLOGO -->", '<script id="catalogData" type="application/json">' + jsonForHtml(catalog) + "</script>");
        }
        res.setHeader("Cache-Control", "no-cache");
        return res.status(200).type("html").send(page);
    } catch (error) {
        console.error("Página inicial:", error);
        return sendSitePage(res, "index.html");
    }
});


/* =====================================================
   MONTÊ → InfinitePay
   MEMÓRIA DOS PEDIDOS AGUARDANDO PAGAMENTO
===================================================== */

const pendingOrders = new Map();
const processedPayments = new Set();

/* =====================================================
   NORMALIZAR VALOR
===================================================== */

function normalizeMoney(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Number(number.toFixed(2));
}

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
   GUARDAR PEDIDO ANTES DO PAGAMENTO
===================================================== */

function savePendingOrder(order) {

    if (!order || !order.order_nsu) {
        throw new Error("Pedido sem order_nsu.");
    }

    pendingOrders.set(
        order.order_nsu,
        {
            ...order,
            created_at: Date.now(),
            payment_confirmed: false,}
    );

    console.log(
        "💾 Pedido salvo aguardando pagamento:",
        order.order_nsu
    );
}

/* =====================================================
   RECUPERAR PEDIDO
===================================================== */

function getPendingOrder(orderNsu) {

    if (!orderNsu) {
        return null;
    }

    return pendingOrders.get(orderNsu) || null;
}

/* =====================================================
   LIMPEZA DE PEDIDOS ANTIGOS
===================================================== */

function cleanupPendingOrders() {

    const expiration =
        1000 *
        60 *
        60 *
        24;

    const now = Date.now();

    for (
        const [orderNsu, order]
        of pendingOrders.entries()
    ) {

        if (
            order.created_at &&
            now - order.created_at > expiration
        ) {

            pendingOrders.delete(orderNsu);

            console.log(
                "🧹 Pedido pendente removido:",
                orderNsu
            );
        }
    }
}

if (!IS_WORKERS) setInterval(
    cleanupPendingOrders,
    1000 * 60 * 60
);

/* =====================================================
   CRIAR CHECKOUT
   COM PEDIDO SALVO ANTES DO PAGAMENTO
===================================================== */

app.post("/api/frete/cotacao", shippingQuoteRateLimit, async (req,res)=>{
    try{
        const toCep=safeString(req.body?.to_cep||req.body?.cep).replace(/\D/g,"");
        const items=Array.isArray(req.body?.items)?req.body.items:[];
        const city=normalizeCity(req.body?.city||"");
        const state=safeString(req.body?.state||"").toUpperCase();
        if(toCep.length!==8)return res.status(400).json({success:false,message:"CEP de destino inválido."});
        const local=localShippingOption(city,state);
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
                "</div><div style=\"padding:22px;text-align:center;color:#999;font-size:10px;line-height:1.6\">MONTÊ — Bolsas & acessórios<br>Você recebeu este e-mail porque se cadastrou para receber novidades da marca.</div>" +
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

app.post(
    "/api/criar-checkout",
    checkoutRateLimit,
    async (req, res) => {

        try {

            console.log(
                "🛒 Solicitação de checkout recebida."
            );

            const {
                items,
                customer,
                shipping_service_id: requestedShippingServiceId,
                payment_method: requestedPaymentMethod
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

            if (
                customerName.length < 2 || customerName.length > 120 ||
                customerEmail.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) ||
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

            if (!isValidCpf(customerCpf)) {
                return res.status(400).json({
                    success: false,
                    message: "CPF inválido. Informe os 11 dígitos."
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
               RECALCULA PREÇOS NO SERVIDOR
               Nunca confia no preço salvo no navegador.
            ================================================= */
            // Uma consulta só para todos os produtos: no Cloudflare cada requisição faz
            // no máximo 50 chamadas externas, e a sacola pode ter até 20 itens.
            const priceKey = item => safeString(item.id || item.product_id).toLowerCase();
            const priceIds = [...new Set(normalizedItems.filter(item => String(item.sku || "").toUpperCase() !== "FRETE").map(priceKey))];
            const priceRows = priceIds.length ? await supabaseRequest(
                "products?id=in.(" + priceIds.map(encodeURIComponent).join(",") + ")" +
                "&active=eq.true&select=id,name,price,sale_price,is_sale"
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

            const shippingValue = Number(shippingOption.price.toFixed(2));


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
                        "&active=eq.true&stock=gt.0&select=id,color,sku,stock,olist_product_id&order=created_at.asc",
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

                if (Number(variant.stock || 0) < Number(item.quantity || 0)) {
                    return res.status(409).json({
                        success: false,
                        message: "Estoque insuficiente para " + item.description +
                            (item.variant_color ? " (" + item.variant_color + ")" : "") + "."
                    });
                }

                item.variant_color = variant.color;
                item.variant_sku = variant.sku || item.sku || null;
                checkedVariants.push({ item, variant });
            }

            // A peça pode ter sido vendida na Olist depois da última sincronização.
            // A conferência usa só as chamadas que sobram na requisição: cada peça já usou
            // 2 (variação e frete) e o resto do pedido usa umas 10 (preços, cotação do frete,
            // número do pedido, pedido, itens, InfinitePay e folga).
            const olistShortage = await checkCartAgainstOlistStock(
                checkedVariants,
                createCallBudget(WORKER_CALL_LIMIT - 10 - 2 * checkedVariants.length)
            );
            if (olistShortage) {
                const { item, available } = olistShortage;
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
            if (!orderCode || !/^\d{4}$/.test(String(orderCode))) {
                throw new Error("Não foi possível gerar o número de pedido da MONTÊ.");
            }


            /* =================================================
               SALVA O PEDIDO ANTES DO PAGAMENTO
            ================================================= */

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
                        customerPhone,

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
                    productItems,

                shipping: {
                    value: Number(shippingValue.toFixed(2)),
                    service_id: shippingOption.id,
                    service_name: shippingOption.name,
                    delivery_days: shippingOption.delivery_days || shippingOption.delivery_max_days || null
                },

                created_at:
                    Date.now(),

                payment_confirmed:
                    false,};


            const subtotal = Number(productItems.reduce(
                (sum, item) => sum + Number(item.price) * Number(item.quantity), 0
            ).toFixed(2));

            // O desconto de 5% do Pix incide somente sobre os produtos.
            // O frete permanece integral.
            // Todos os valores são calculados em centavos a partir do mesmo preço
            // unitário enviado à InfinitePay. Assim o total salvo no pedido é
            // exatamente o valor cobrado e o payment_check do webhook confere.
            const pixUnitCents = item => pixDiscountedUnitCents(item.price);
            const productUnitCents = item => paymentMethod === "pix"
                ? pixUnitCents(item)
                : Math.round(Number(item.price) * 100);
            const checkoutProductCents = productItems.reduce(
                (sum, item) => sum + productUnitCents(item) * Number(item.quantity), 0
            );
            const shippingCents = Math.round(shippingValue * 100);

            const checkoutTotal = (checkoutProductCents + shippingCents) / 100;

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
                    shipping_delivery_days: shippingOption.delivery_days || shippingOption.delivery_max_days || null,
                    total: checkoutTotal,
                    status: "pending",
                    payment_method: paymentMethod,
                    whatsapp_tracking_opt_in: customer.whatsapp_updates === true,
                    whatsapp_tracking_status: customer.whatsapp_updates === true ? "pending" : "opted_out",
                    items: productItems
                })
            });

            const savedOrder = Array.isArray(savedOrders) ? savedOrders[0] : savedOrders;

            await supabaseRequest("order_items", {
                method: "POST",
                body: JSON.stringify(productItems.map(item => ({
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

            savePendingOrder(
                pendingOrder
            );

            /* =================================================
               PIX — CHECKOUT INDEPENDENTE DA INFINITEPAY
               O Pix usa um checkout próprio da InfinitePay.
               O desconto de 5% incide somente nos produtos;
               o frete permanece com o valor integral.
            ================================================= */
            if (paymentMethod === "pix") {
                const pixItems = productItems.map((item) => ({
                    quantity: item.quantity,
                    price: pixUnitCents(item),
                    description: item.description
                }));

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
                        phone_number: String(customer.phone)
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
                    return res.status(pixResponse.ok ? 502 : pixResponse.status).json({
                        success: false,
                        message: "A InfinitePay não conseguiu criar o checkout Pix."
                    });
                }

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
                productItems.map((item) => ({
                    quantity: item.quantity,
                    price: Math.round(item.price * 100),
                    description: item.description
                }));

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
                        String(
                            customer.phone
                        )

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

                /*
                   Se o checkout falhar, removemos o pedido
                   temporário para não deixar lixo na memória.
                */

                pendingOrders.delete(
                    orderNsu
                );


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


                return res.status(
                    response.status
                ).json({

                    success:
                        false,

                    message:
                        "A InfinitePay recusou a criação do checkout."

                });

            }


            /* =================================================
               VERIFICA URL
            ================================================= */

            if (
                !data ||
                !data.url
            ) {

                pendingOrders.delete(
                    orderNsu
                );


                console.error(
                    "❌ InfinitePay não retornou URL."
                );

                console.error(
                    data
                );


                return res.status(502).json({

                    success:
                        false,

                    message:
                        "A InfinitePay não retornou o link de pagamento."

                });

            }


            /* =================================================
               SUCESSO
            ================================================= */

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


            return res.status(500).json({

                success:
                    false,

                message:
                    "Erro interno ao criar checkout.",

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
                let olistRetry = {status:"skipped"};
                if (order.status === "paid" && order.olist_sync_status !== "completed") {
                    try {
                        const result = await syncPaidOrderToOlist({
                            ...order,
                            payment_method: order.payment_method || "credit_card",
                            transaction_nsu: transactionNsu,
                            customer_cpf: order.customer_cpf,
                            customer_whatsapp: order.customer_whatsapp
                        });
                        olistRetry = {status:"completed", result};
                    } catch (olistError) {
                        olistRetry = {
                            status:"error",
                            error:String(olistError.message || olistError)
                        };
                        await supabaseRequest(
                            "orders?id=eq." + encodeURIComponent(order.id),
                            {method:"PATCH",body:JSON.stringify({
                                olist_sync_status:"error",
                                olist_sync_error:olistRetry.error
                            })}
                        ).catch(()=>{});
                    }
                }

                processedPayments.add(orderNsu);
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
            const paidAmount = Number(payment.paid_amount ?? webhook.paid_amount ?? 0);
            const resolvedPaymentMethod = payment.capture_method === "pix" ? "pix" : "credit_card";

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
                `payments?transaction_nsu=eq.${encodeURIComponent(transactionNsu)}&select=id`,
                { method: "GET" }
            );

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
                            installments: payment.installments || webhook.installments || null,
                            capture_method: payment.capture_method || webhook.capture_method || null,
                            receipt_url: webhook.receipt_url || null,
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
                        receipt_url: webhook.receipt_url || null,
                        installments: payment.installments || webhook.installments || null,
                        capture_method: payment.capture_method || webhook.capture_method || null,
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
                admin_sale_email_sent_at: order.admin_sale_email_sent_at
            });

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

            processedPayments.add(orderNsu);

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
   WEBHOOK PIX — CHECKOUT INDEPENDENTE INFINITEPAY
   Recebe somente pagamentos Pix do checkout independente.
   A confirmação é validada pelo payment_check da InfinitePay.
===================================================== */
app.post("/webhook-pix", infinitePayWebhookRateLimit, async (req, res) => {
    try {
        const webhook = req.body || {};
        const orderNsu = safeString(webhook.order_nsu);
        const transactionNsu = safeString(webhook.transaction_nsu);
        const invoiceSlug = safeString(webhook.invoice_slug || webhook.slug);
        const captureMethod = safeString(webhook.capture_method).toLowerCase();

        console.log("PIX — Webhook InfinitePay recebido:", orderNsu);

        if (!orderNsu || !transactionNsu || !invoiceSlug) {
            return res.status(400).json({
                success: false,
                paid: false,
                message: "Webhook Pix sem order_nsu, transaction_nsu ou invoice_slug."
            });
        }

        if (captureMethod && captureMethod !== "pix") {
            return res.status(400).json({
                success: false,
                paid: false,
                message: "Este endpoint aceita somente pagamentos Pix."
            });
        }

        const webhookAmount = Number(webhook.amount);
        if (!Number.isFinite(webhookAmount) || webhookAmount <= 0) {
            return res.status(400).json({
                success: false,
                paid: false,
                message: "Valor do pagamento não informado."
            });
        }

        const verification = await verifyInfinitePayPayment({
            orderNsu,
            transactionNsu,
            invoiceSlug,
            expectedAmount: webhookAmount / 100
        });

        if (!verification.verified) {
            console.warn("PIX — pagamento ainda não confirmado:", orderNsu);
            return res.status(400).json({
                success: false,
                paid: false,
                message: "Pagamento Pix ainda não confirmado pela InfinitePay."
            });
        }

        const payment = verification.data;
        if (safeString(payment.capture_method).toLowerCase() !== "pix") {
            return res.status(400).json({
                success: false,
                paid: false,
                message: "A confirmação da InfinitePay não corresponde a Pix."
            });
        }

        console.log("PIX — pagamento confirmado pela InfinitePay:", {
            order_nsu: orderNsu,
            transaction_nsu: transactionNsu,
            amount: Number(payment.amount || 0) / 100
        });

        return res.status(200).json({
            success: true,
            paid: true,
            payment_method: "pix",
            order_nsu: orderNsu,
            transaction_nsu: transactionNsu,
            invoice_slug: invoiceSlug,
            amount: Number(payment.amount || 0) / 100,
            paid_amount: Number(payment.paid_amount || 0) / 100
        });
    } catch (error) {
        console.error("PIX — erro no webhook independente:", error);
        return res.status(500).json({
            success: false,
            paid: false,
            message: "Erro interno na confirmação do Pix."
        });
    }
});

/* =====================================================
   MINHAS COMPRAS — CONSULTA SEGURA POR PEDIDO + E-MAIL
===================================================== */

app.get("/api/minhas-compras", orderStatusRateLimit, async (req, res) => {
    try {
        const orderNsu = normalizeOrderCode(req.query.order_nsu);
        const email = safeString(req.query.email).toLowerCase();

        if (!orderNsu || !email || orderNsu.length > 80 || email.length > 160) {
            return res.status(400).json({ success: false, message: "Informe o número do pedido e o e-mail usado na compra." });
        }

        const rows = await supabaseRequest(
            `orders?${/^\d{4}$/.test(orderNsu) ? "order_code=eq."+encodeURIComponent(orderNsu) : "order_nsu=eq."+encodeURIComponent(orderNsu)}&customer_email=eq.${encodeURIComponent(email)}&select=id,order_nsu,order_code,customer_name,customer_email,status,total,subtotal,shipping,shipping_carrier,tracking_code,tracking_url,shipping_service_name,created_at,paid_at,processing_at,shipped_at,delivered_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)`,
            { method: "GET" }
        );

        const order = Array.isArray(rows) ? rows[0] : null;
        if (!order) {
            return res.status(404).json({ success: false, message: "Não encontramos um pedido com esses dados." });
        }

        return res.json({
            success: true,
            order: {
                order_nsu: order.order_nsu,
                order_code: formatOrderCode(order.order_code || order.order_nsu),
                customer_name: order.customer_name,
                status: order.status,
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

app.get("/api/pedido-status", orderStatusRateLimit, async (req, res) => {
    try {
        const orderNsu = safeString(req.query.order_nsu);
        const transactionNsu = safeString(req.query.transaction_nsu);

        if (!orderNsu || !transactionNsu) {
            return res.status(400).json({
                success: false,
                message: "Identificadores do pedido não informados."
            });
        }

        const rows = await supabaseRequest(
            `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}&transaction_nsu=eq.${encodeURIComponent(transactionNsu)}&select=id,order_nsu,order_code,status,total,shipping,receipt_url,created_at,paid_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)`,
            { method: "GET" }
        );

        const order = Array.isArray(rows) ? rows[0] : null;

        if (!order || order.status !== "paid") {
            return res.status(404).json({
                success: false,
                message: "Pedido pago não encontrado."
            });
        }

        return res.json({
            success: true,
            order: {
                order_nsu: order.order_nsu,
                order_code: formatOrderCode(order.order_code || order.order_nsu),
                status: order.status,
                total: Number(order.total || 0),
                shipping: Number(order.shipping || 0),
                receipt_url: order.receipt_url || null,
                created_at: order.created_at,
                paid_at: order.paid_at,
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
        console.error("❌ Erro ao consultar pedido:", error);
        return res.status(500).json({
            success: false,
            message: "Não foi possível consultar o pedido."
        });
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
    const raw = safeString(value);
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    return new URL("/" + raw.replace(/^\/+/, ""), PUBLIC_SITE_URL).href;
}

function productSeoUrl(product) {
    return new URL("/produto/" + encodeURIComponent(product.id) + "/" + encodeURIComponent(slugify(product.name)), PUBLIC_SITE_URL).href;
}

function productAvailabilityForSchema(product) {
    return Number(product.stock_total || 0) > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
}

async function getPublicProductsForSeo() {
    const rows = await supabaseRequest(
        "products?active=eq.true&select=id,name,category,description,price,sale_price,is_sale,images,updated_at,product_variants(stock,active)",
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
            "products?id=eq." + encodeURIComponent(id) + "&active=eq.true&select=id,name,category,description,price,sale_price,is_sale,images,updated_at,product_variants(stock,active)",
            { method: "GET" }
        );
        const product = Array.isArray(rows) ? rows[0] : null;

        if (!product) return res.status(404).send("Produto não encontrado.");

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
<link rel="stylesheet" href="/produto-seo.css?v=20261007-seguranca">
</head>
<body>
<main class="seo-product">
<h1>${xmlEscape(product.name)}</h1>
${image ? `<img src="${xmlEscape(image)}" alt="${xmlEscape(product.name)}">` : ""}
<p>${xmlEscape(description).replace(/\n/g, "<br>")}</p>
<p><strong>Preço: R$ ${price.toFixed(2).replace(".", ",")}</strong></p>
<p>${stockTotal > 0 ? "Disponível para compra." : "Produto esgotado."}</p>
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

app.use(
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
     um lembrete 1 hora depois, com um link que refaz a sacola.
   - Sacola abandonada (e-mail preenchido no checkout, sem pedido):
     um lembrete 2 horas depois da última mexida.
   Só pedidos e sacolas das últimas 24 horas, um único e-mail por pedido
   ou sacola, e só com as peças que ainda têm estoque.
   - Pedido aguardando pagamento há mais de 2 dias vira "expired" e sai
     da lista principal do painel. Se o pagamento chegar depois, o aviso
     da InfinitePay confirma o pedido normalmente.
===================================================== */
const REMINDER_ORDER_AFTER_MS = 60 * 60 * 1000;
const REMINDER_CART_AFTER_MS = 2 * 60 * 60 * 1000;
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const PENDING_ORDER_EXPIRE_MS = 2 * 24 * 60 * 60 * 1000;
// Por lembrete: compras posteriores, estoque, e-mail e marcação = 4 chamadas.
const REMINDER_CALLS_EACH = 4;
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
function cartRestoreUrl(items, campaign) {
    const payload = Buffer.from(JSON.stringify(items.map(item => [item.productId, item.variantId, item.quantity]))).toString("base64url");
    return PUBLIC_SITE_URL + "/?sacola=" + payload + "&utm_source=lembrete&utm_medium=email&utm_campaign=" + campaign;
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
        "orders?customer_email=ilike." + encodeURIComponent(safeString(email)) + "&created_at=gt." + encodeURIComponent(since) + "&select=id,status&limit=10",
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
        const firstName = safeString(order.customer_name).split(/\s+/)[0] || "";
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
                        "As peças não ficam reservadas e o estoque é limitado. No Pix, você ganha 5% de desconto."
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
        spend(budget);
        const items = await availableReminderItems(cart.items);
        if (!items.length) { await mark("skipped_sold_out"); continue; }
        const firstName = safeString(cart.customer_name).split(/\s+/)[0] || "";
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
                        "No Pix, você ganha 5% de desconto."
                    ],
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

// Roda a cada 5 minutos no cron. Devolve quantas chamadas externas usou.
async function runCustomerUpkeep(calls) {
    const limit = Math.max(0, Math.floor(Number(calls) || 0));
    const budget = createCallBudget(limit);
    const steps = [expireOldPendingOrders];
    // Sem o Resend configurado não há como enviar: os lembretes esperam (nada é marcado).
    if (RESEND_API_KEY && RESEND_FROM_EMAIL) steps.push(remindPendingOrders, remindAbandonedCarts);
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
// do wrangler.jsonc ("* * * * *" = um pedido pago pendente e um lote do estoque
// Olist → site; a cada 3 horas = acesso Olist). Cada execução tem 50 chamadas externas:
// o pedido vai primeiro e o lote de estoque usa o que sobrar.
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

            // Estoque Olist → site (só baixa), um lote por minuto.
            setInterval(() => syncOlistStockBatch().catch(() => {}), 60000);

            // Pedidos sem pagamento antigos e lembretes por e-mail, a cada 5 minutos.
            setInterval(() => runCustomerUpkeep(40).catch(() => {}), 5 * 60 * 1000);
        }
    );
}

// "node server.js" (Render) sobe o servidor; o Worker importa o app (backend/worker.js).
if (!IS_WORKERS && require.main === module) startNodeServer();

module.exports = { app, runScheduledTask, runCustomerUpkeep, setSiteAssets, setBackgroundRunner };
