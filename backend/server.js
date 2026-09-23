const express = require("express");
const crypto = require("crypto");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

/* =====================================================
   CONFIGURAÇÕES
   Fluxo atual: MONTÊ → InfinitePay → Supabase → painel admin.
===================================================== */

const SITE_URL =
    process.env.SITE_URL ||
    "https://monte-site-itjk.onrender.com";

const INFINITEPAY_API =
    "https://api.checkout.infinitepay.io/links";

const INFINITEPAY_HANDLE =
    process.env.INFINITEPAY_HANDLE ||
    "monte-64839705-0z9";

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

async function sendWhatsAppTrackingNotification(order) {
    if (!order?.whatsapp_tracking_opt_in) {
        return { sent: false, status: "opted_out", message_id: null };
    }

    if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
        return { sent: false, status: "not_configured", message_id: null };
    }

    const phone = String(order.customer_phone || "").replace(/\D/g, "");
    const trackingCode = safeString(order.tracking_code);
    const trackingUrl = safeString(order.tracking_url);
    if (phone.length < 10 || !trackingCode) {
        return { sent: false, status: "invalid_recipient_or_tracking", message_id: null };
    }

    const firstName = safeString(order.customer_name).split(/\s+/)[0] || "cliente";
    const orderCode = safeString(order.order_nsu);
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

async function supabaseRequest(path, options = {}) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
    }

    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
            ...(options.headers || {})
        }
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
        throw new Error(`Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }

    return data;
}



/* =====================================================


/* =====================================================
   FRETE — REGRAS LOCAIS + SUPERFRETE
===================================================== */

const METROPOLITAN_CITIES = new Set(["AQUIRAZ","CAUCAIA","EUSEBIO","GUAIUBA","ITAITINGA","MARACANAU"]);

function localShippingOption(city, state) {
    const normalized = normalizeCity(city);
    const normalizedState = safeString(state).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    if (normalizedState !== "CE") return null;
    if (normalized === "FORTALEZA") return { id:"monte-fortaleza", name:"Entrega MONTÊ — Fortaleza", price:15, delivery_days:2 };
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
   MIDDLEWARES
===================================================== */

const allowedOrigins = new Set([
    SITE_URL.replace(/\/$/, "")
]);

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
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

app.use(express.json({ limit: "100kb" }));

/* =====================================================
   RATE LIMITING — proteção contra abuso de endpoints
===================================================== */
function createRateLimiter({ windowMs, max, keyFn = req => req.ip || "unknown" }) {
    const buckets = new Map();

    const cleanup = () => {
        const now = Date.now();
        for (const [key, bucket] of buckets.entries()) {
            if (now - bucket.startedAt >= windowMs) buckets.delete(key);
        }
    };

    setInterval(cleanup, Math.min(windowMs, 5 * 60 * 1000)).unref();

    return (req, res, next) => {
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

/* =====================================================
   MONTÊ ADMIN AUTH — acesso exclusivo do administrador
===================================================== */
const ADMIN_EMAIL = safeString(process.env.ADMIN_EMAIL);
const ADMIN_PASSWORD_HASH = safeString(process.env.ADMIN_PASSWORD_HASH);
const ADMIN_SESSION_TTL = 1000 * 60 * 60 * 8;
const adminSessions = new Map();
const adminLoginAttempts = new Map();
function parseCookies(req){const h=req.headers.cookie||"";const o={};h.split(";").filter(Boolean).forEach(p=>{const i=p.indexOf("=");if(i>=0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())});return o}
function getAdminSession(req){const t=parseCookies(req).monte_admin_session;if(!t)return null;const s=adminSessions.get(t);if(!s)return null;if(Date.now()>s.expiresAt){adminSessions.delete(t);return null}return {token:t,...s}}
function requireAdmin(req,res,next){const s=getAdminSession(req);if(!s)return res.status(401).json({success:false,message:"Acesso administrativo não autorizado."});req.adminSession=s;next()}
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
function loginKey(req,email){return `${req.ip||"unknown"}:${safeString(email).toLowerCase()}`}
function loginAllowed(req,email){const r=adminLoginAttempts.get(loginKey(req,email));if(!r)return true;if(r.lockedUntil&&Date.now()<r.lockedUntil)return false;if(r.lockedUntil)adminLoginAttempts.delete(loginKey(req,email));return true}
function failedLogin(req,email){const k=loginKey(req,email);const r=adminLoginAttempts.get(k)||{count:0,lockedUntil:0};r.count++;if(r.count>=5){r.count=0;r.lockedUntil=Date.now()+15*60*1000}adminLoginAttempts.set(k,r)}
function clearLoginFailures(req,email){adminLoginAttempts.delete(loginKey(req,email))}
function setAdminCookie(res,t){res.setHeader("Set-Cookie",`monte_admin_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL/1000)}`)}
function clearAdminCookie(res){res.setHeader("Set-Cookie","monte_admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")}
app.post("/api/admin/login",adminLoginRateLimit,(req,res)=>{const email=safeString(req.body?.email).toLowerCase(),password=req.body?.password;if(!ADMIN_EMAIL||!ADMIN_PASSWORD_HASH)return res.status(503).json({success:false,message:"Acesso administrativo não configurado no servidor."});if(!loginAllowed(req,email))return res.status(429).json({success:false,message:"Muitas tentativas. Tente novamente em 15 minutos."});if(email!==ADMIN_EMAIL.toLowerCase()||!passwordMatches(password)){failedLogin(req,email);return res.status(401).json({success:false,message:"E-mail ou senha incorretos."})}clearLoginFailures(req,email);const token=crypto.randomBytes(32).toString("hex");adminSessions.set(token,{email:ADMIN_EMAIL,expiresAt:Date.now()+ADMIN_SESSION_TTL});setAdminCookie(res,token);return res.json({success:true,email:ADMIN_EMAIL})});
app.post("/api/admin/logout",(req,res)=>{const t=parseCookies(req).monte_admin_session;if(t)adminSessions.delete(t);clearAdminCookie(res);return res.json({success:true})});
app.get("/api/admin/session",(req,res)=>{const s=getAdminSession(req);if(!s)return res.status(401).json({success:false});return res.json({success:true,email:s.email})});
app.get("/api/admin/products",requireAdmin,async(req,res)=>{try{const data=await supabaseRequest("products?select=*,product_variants(*)&order=created_at.desc");return res.json({success:true,products:data||[]})}catch(e){console.error("Admin products GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar os produtos."})}});
function sanitizeProductPayload(b={}){return{name:safeString(b.name),sku:safeString(b.sku)||null,category:safeString(b.category)||"bolsas",price:Number(b.price||0),sale_price:b.sale_price===null||b.sale_price===""||b.sale_price===undefined?null:Number(b.sale_price),description:safeString(b.description),images:Array.isArray(b.images)?b.images:[],shipping_weight_kg:b.shipping_weight_kg===null||b.shipping_weight_kg===""||b.shipping_weight_kg===undefined?null:Number(b.shipping_weight_kg),shipping_height_cm:b.shipping_height_cm===null||b.shipping_height_cm===""||b.shipping_height_cm===undefined?null:Number(b.shipping_height_cm),shipping_width_cm:b.shipping_width_cm===null||b.shipping_width_cm===""||b.shipping_width_cm===undefined?null:Number(b.shipping_width_cm),shipping_length_cm:b.shipping_length_cm===null||b.shipping_length_cm===""||b.shipping_length_cm===undefined?null:Number(b.shipping_length_cm),is_new:Boolean(b.is_new),is_sale:Boolean(b.is_sale),active:b.active!==false}}
app.post("/api/admin/products",requireAdmin,async(req,res)=>{try{const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest("products",{method:"POST",body:JSON.stringify(p)});return res.status(201).json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products POST:",e);return res.status(500).json({success:false,message:e.message})}});
app.put("/api/admin/products/:id",requireAdmin,async(req,res)=>{try{const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest(`products?id=eq.${encodeURIComponent(req.params.id)}`,{method:"PATCH",body:JSON.stringify(p)});return res.json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products PUT:",e);return res.status(500).json({success:false,message:e.message})}});
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
        const allowed=["pending","paid","processing","shipped","delivered"];
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
        if (status === "shipped" && savedOrder.tracking_code && savedOrder.whatsapp_tracking_opt_in && !savedOrder.whatsapp_tracking_sent_at) {
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
                });
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
        if(!order.whatsapp_tracking_opt_in) return res.status(400).json({success:false,message:"A cliente não autorizou atualizações por WhatsApp."});
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
   ARQUIVOS DO SITE
===================================================== */

app.use(
    express.static(
        path.join(
            __dirname,
            ".."
        )
    )
);


/* =====================================================
   TESTE DO SERVIDOR
===================================================== */

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "..",
                "index.html"
            )
        );

    }
);


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

setInterval(
    cleanupPendingOrders,
    1000 * 60 * 60
);

/* =====================================================
   CRIAR CHECKOUT
   COM PEDIDO SALVO ANTES DO PAGAMENTO
===================================================== */

app.post("/api/frete/cotacao", async (req,res)=>{
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
    }catch(error){console.error("❌ Erro na cotação SuperFrete:",error);return res.status(502).json({success:false,message:error.message||"Não foi possível calcular o frete."});}
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
                payment_method: requestedPaymentMethod,
                shipping_service_id: requestedShippingServiceId
            } = req.body || {};

            const paymentMethod = String(requestedPaymentMethod || "pix").toLowerCase();

            if (!["pix", "card"].includes(paymentMethod)) {
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
            const customerName = safeString(customer.name);
            const address = customer.address || {};

            if (
                customerName.length < 2 || customerName.length > 120 ||
                customerEmail.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) ||
                customerPhone.length < 8 || customerPhone.length > 30 ||
                customerCpf.length !== 11 ||
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
            for (const item of normalizedItems) {
                if (String(item.sku || "").toUpperCase() === "FRETE") continue;
                const productRows = await supabaseRequest(
                    "products?id=eq." + encodeURIComponent(item.id || item.product_id || "") +
                    "&active=eq.true&select=id,name,price,sale_price,is_sale"
                );
                const product = Array.isArray(productRows) ? productRows[0] : null;
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
                        "&active=eq.true&select=id,color,sku,stock",
                        { method: "GET" }
                    );

                    variant = Array.isArray(variants) ? variants[0] : null;
                } else {
                    const variants = await supabaseRequest(
                        "product_variants?product_id=eq." + encodeURIComponent(item.id) +
                        "&active=eq.true&stock=gt.0&select=id,color,sku,stock&order=created_at.asc",
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
            }


            /* =================================================
               ORDER NSU
            ================================================= */

            const orderNsu =
                `MONTE-${Date.now()}`;


            /* =================================================
               SALVA O PEDIDO ANTES DO PAGAMENTO
            ================================================= */

            const pendingOrder = {

                order_nsu:
                    orderNsu,

                customer: {

                    name:
                        customerName,

                    email:
                        customerEmail,

                    phone:
                        customerPhone,

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

            // Pix: 5% de desconto somente nos produtos. O frete permanece integral.
            const discountedProductSubtotal = paymentMethod === "pix"
                ? Number((subtotal * 0.95).toFixed(2))
                : subtotal;

            const checkoutTotal = Number(
                (discountedProductSubtotal + shippingValue).toFixed(2)
            );

            const savedOrders = await supabaseRequest("orders", {
                method: "POST",
                body: JSON.stringify({
                    order_nsu: orderNsu,
                    customer_name: pendingOrder.customer.name,
                    customer_email: pendingOrder.customer.email,
                    customer_phone: pendingOrder.customer.phone,
                    customer_cpf: pendingOrder.customer.cpf,
                    customer_address: pendingOrder.customer.address,
                    subtotal: Number(subtotal.toFixed(2)),
                    shipping: Number(shippingValue.toFixed(2)),
                    shipping_service_id: shippingOption.id,
                    shipping_service_name: shippingOption.name,
                    shipping_delivery_days: shippingOption.delivery_days || shippingOption.delivery_max_days || null,
                    total: checkoutTotal,
                    status: "pending",
                    payment_method: paymentMethod === "pix" ? "pix" : "credit_card",
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
               CONVERTE PRODUTOS PARA INFINITEPAY
            ================================================= */

            const infinitePayItems =
                productItems.map((item) => {
                    const checkoutUnitPrice = paymentMethod === "pix"
                        ? Number((item.price * 0.95).toFixed(2))
                        : item.price;

                    return {
                        quantity: item.quantity,
                        price: Math.round(checkoutUnitPrice * 100),
                        description: item.description
                    };
                });

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
                    `${SITE_URL}/pagamento-sucesso`,

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

            const response =
                await fetch(
                    INFINITEPAY_API,
                    {

                        method:
                            "POST",

                        headers: {

                            "Content-Type":
                                "application/json",

                            "Accept":
                                "application/json"

                        },

                        body:
                            JSON.stringify(
                                payload
                            )

                    }
                );


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
                        "A InfinitePay recusou a criação do checkout.",

                    error:
                        data

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
                        "A InfinitePay não retornou o link de pagamento.",

                    error:
                        data

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

            // Webhook repetido do mesmo pagamento: já está conciliado.
            if (
                order.status === "paid" &&
                order.transaction_nsu === transactionNsu &&
                order.stock_decremented === true
            ) {
                processedPayments.add(orderNsu);
                return res.status(200).json({ success: true, already_processed: true });
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

            // Baixa atômica e idempotente. A função bloqueia o pedido e usa
            // stock_decremented para impedir duas baixas do mesmo pedido.
            const stockResult = await supabaseRequest("rpc/decrement_order_stock", {
                method: "POST",
                body: JSON.stringify({ p_order_id: order.id })
            });

            console.log("📦 Baixa de estoque:", stockResult);

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

            processedPayments.add(orderNsu);

            console.log("✅ Pagamento confirmado, estoque baixado e pedido conciliado:", orderNsu);

            return res.status(200).json({
                success: true,
                paid: true,
                order_nsu: orderNsu
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

app.get("/api/minhas-compras", orderStatusRateLimit, async (req, res) => {
    try {
        const orderNsu = safeString(req.query.order_nsu);
        const email = safeString(req.query.email).toLowerCase();

        if (!orderNsu || !email || orderNsu.length > 80 || email.length > 160) {
            return res.status(400).json({ success: false, message: "Informe o número do pedido e o e-mail usado na compra." });
        }

        const rows = await supabaseRequest(
            `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}&customer_email=eq.${encodeURIComponent(email)}&select=id,order_nsu,customer_name,customer_email,status,total,subtotal,shipping,shipping_carrier,tracking_code,tracking_url,shipping_service_name,created_at,paid_at,processing_at,shipped_at,delivered_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)`,
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
            `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}&transaction_nsu=eq.${encodeURIComponent(transactionNsu)}&select=id,order_nsu,status,total,shipping,receipt_url,created_at,paid_at,order_items(product_name,variant_color,sku,quantity,unit_price,total_price)`,
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
   PÁGINA DE SUCESSO
===================================================== */
app.get(
    "/pagamento-sucesso",
    (req, res) => {
        res.sendFile(
            path.join(
                __dirname,
                "..",
                "pagamento-sucesso.html"
            )
        );
    }
);


/* =====================================================
   INICIAR SERVIDOR
===================================================== */

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 Backend MONTÊ rodando na porta ${PORT}`
        );

        console.log(
            `💳 InfinitePay configurada para: ${INFINITEPAY_HANDLE}`
        );
}
);
