const express = require("express");
const crypto = require("crypto");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();

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
   OLIST API V3
===================================================== */

const OLIST_API_BASE =
    process.env.OLIST_API_BASE ||
    "https://api.tiny.com.br/public-api/v3";

const OLIST_CLIENT_ID =
    process.env.OLIST_CLIENT_ID;

const OLIST_CLIENT_SECRET =
    process.env.OLIST_CLIENT_SECRET;

const OLIST_AUTH_URL =
    "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth";

const OLIST_TOKEN_URL =
    "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token";

const OLIST_REDIRECT_URI =
    `${SITE_URL}/olist/oauth/callback`;

const OLIST_SCOPE =
    "openid";


/* =====================================================
   TOKEN OLIST
===================================================== */

let olistAccessToken = null;

let olistRefreshToken =
    process.env.OLIST_REFRESH_TOKEN || null;

let olistTokenExpiresAt = 0;


/* =====================================================
   MIDDLEWARES
===================================================== */

app.use(
    cors({
        origin: true,
        methods: [
            "GET",
            "POST",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
    })
);

app.options(
    "*",
    cors()
);

app.use(
    express.json()
);

function safeString(value){if(value===undefined||value===null)return "";return String(value).trim()}

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
app.post("/api/admin/login",(req,res)=>{const email=safeString(req.body?.email).toLowerCase(),password=req.body?.password;if(!ADMIN_EMAIL||!ADMIN_PASSWORD_HASH)return res.status(503).json({success:false,message:"Acesso administrativo não configurado no servidor."});if(!loginAllowed(req,email))return res.status(429).json({success:false,message:"Muitas tentativas. Tente novamente em 15 minutos."});if(email!==ADMIN_EMAIL.toLowerCase()||!passwordMatches(password)){failedLogin(req,email);return res.status(401).json({success:false,message:"E-mail ou senha incorretos."})}clearLoginFailures(req,email);const token=crypto.randomBytes(32).toString("hex");adminSessions.set(token,{email:ADMIN_EMAIL,expiresAt:Date.now()+ADMIN_SESSION_TTL});setAdminCookie(res,token);return res.json({success:true,email:ADMIN_EMAIL})});
app.post("/api/admin/logout",(req,res)=>{const t=parseCookies(req).monte_admin_session;if(t)adminSessions.delete(t);clearAdminCookie(res);return res.json({success:true})});
app.get("/api/admin/session",(req,res)=>{const s=getAdminSession(req);if(!s)return res.status(401).json({success:false});return res.json({success:true,email:s.email})});
app.get("/api/admin/products",requireAdmin,async(req,res)=>{try{const data=await supabaseRequest("products?select=*,product_variants(*)&order=created_at.desc");return res.json({success:true,products:data||[]})}catch(e){console.error("Admin products GET:",e);return res.status(500).json({success:false,message:"Não foi possível carregar os produtos."})}});
function sanitizeProductPayload(b={}){return{name:safeString(b.name),sku:safeString(b.sku)||null,category:safeString(b.category)||"bolsas",price:Number(b.price||0),sale_price:b.sale_price===null||b.sale_price===""||b.sale_price===undefined?null:Number(b.sale_price),description:safeString(b.description),images:Array.isArray(b.images)?b.images:[],is_new:Boolean(b.is_new),is_sale:Boolean(b.is_sale),active:b.active!==false}}
app.post("/api/admin/products",requireAdmin,async(req,res)=>{try{const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest("products",{method:"POST",body:JSON.stringify(p)});return res.status(201).json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products POST:",e);return res.status(500).json({success:false,message:e.message})}});
app.put("/api/admin/products/:id",requireAdmin,async(req,res)=>{try{const p=sanitizeProductPayload(req.body);if(!p.name)return res.status(400).json({success:false,message:"Informe o nome do produto."});const d=await supabaseRequest(`products?id=eq.${encodeURIComponent(req.params.id)}`,{method:"PATCH",body:JSON.stringify(p)});return res.json({success:true,product:d?.[0]||d})}catch(e){console.error("Admin products PUT:",e);return res.status(500).json({success:false,message:e.message})}});
app.put("/api/admin/products/:id/variants",requireAdmin,async(req,res)=>{try{const id=safeString(req.params.id),vs=Array.isArray(req.body?.variants)?req.body.variants:[],ex=await supabaseRequest(`product_variants?product_id=eq.${encodeURIComponent(id)}&select=id`),ids=new Set(vs.map(v=>safeString(v.id)).filter(Boolean));for(const old of(ex||[])){if(!ids.has(old.id))await supabaseRequest(`product_variants?id=eq.${encodeURIComponent(old.id)}`,{method:"DELETE",headers:{"Prefer":"return=minimal"}})}for(const v of vs){const p={product_id:id,color:safeString(v.color),sku:safeString(v.sku)||null,stock:Math.max(0,Number(v.stock||0)),active:v.active!==false};if(!p.color)continue;if(v.id)await supabaseRequest(`product_variants?id=eq.${encodeURIComponent(v.id)}`,{method:"PATCH",body:JSON.stringify(p)});else await supabaseRequest("product_variants",{method:"POST",body:JSON.stringify(p)})}return res.json({success:true})}catch(e){console.error("Admin variants PUT:",e);return res.status(500).json({success:false,message:e.message})}});
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
            patch.shipped_at=new Date().toISOString();
        }
        if(status==="delivered") patch.delivered_at=new Date().toISOString();
        const d=await supabaseRequest(`orders?id=eq.${id}`,{method:"PATCH",body:JSON.stringify(patch)});
        if(!Array.isArray(d)||!d[0]) return res.status(404).json({success:false,message:"Pedido não encontrado."});
        return res.json({success:true,order:d[0]});
    }catch(e){console.error("Admin order status PATCH:",e);return res.status(500).json({success:false,message:"Não foi possível atualizar o pedido."})}
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
        console.log(`🚀 Backend MONTÊ rodando na porta ${PORT}`);
        console.log(`💳 InfinitePay configurada para: ${INFINITEPAY_HANDLE}`);
        console.log(`🔗 Olist API V3: ${OLIST_API_BASE}`);
        console.log(`🔐 Olist OAuth callback: ${OLIST_REDIRECT_URI}`);
    }
);
