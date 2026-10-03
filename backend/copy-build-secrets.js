// Cópia única: passa para o Worker (como Secret) as variáveis cadastradas em
// Cloudflare → monte-site → Settings → Build → Variables and secrets, que o
// Worker não enxerga quando está no ar. Roda no "npm install" do Workers Builds
// (branch main); no Render e no computador não faz nada. Nunca mostra valores
// e nunca interrompe o build.
const { execFileSync } = require("child_process");
const path = require("path");

// SITE_URL e OLIST_SYNC_ENABLED ficam no wrangler.jsonc; as OLIST_* entram só
// na troca do domínio; SUPABASE_SERVICE_ROLE_KEY, SUPERFRETE_TOKEN, ADMIN_EMAIL
// e ADMIN_PASSWORD_HASH já foram cadastradas direto no painel.
const NAMES = [
    "SUPABASE_URL",
    "SUPERFRETE_API_URL", "SUPERFRETE_ORIGIN_CEP", "SUPERFRETE_USER_AGENT",
    "ADMIN_SESSION_SECRET",
    "RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_MARKETING_FROM_EMAIL", "RESEND_FROM_NAME",
    "ORDER_NOTIFICATION_EMAILS",
    "PIX_KEY", "PIX_MERCHANT_NAME", "PIX_MERCHANT_CITY",
    "WHATSAPP_API_VERSION", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_TEMPLATE_NAME", "WHATSAPP_TEMPLATE_LANGUAGE", "WHATSAPP_ADMIN_PHONE",
    "WHATSAPP_ADMIN_TEMPLATE_NAME", "WHATSAPP_ADMIN_TEMPLATE_LANGUAGE",
    "INSTAGRAM_GRAPH_API_VERSION", "INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID",
    "INFINITEPAY_HANDLE", "PUBLIC_SITE_URL", "ALLOWED_ORIGINS"
];

if (process.env.WORKERS_CI !== "1" || process.env.WORKERS_CI_BRANCH !== "main") process.exit(0);

try {
    const secrets = {};
    for (const name of NAMES) {
        const value = process.env[name];
        if (value && value.trim()) secrets[name] = value.trim();
    }
    const names = Object.keys(secrets);
    if (!names.length) {
        console.log("copy-build-secrets: nenhuma variável para copiar");
    } else {
        execFileSync("npx", ["--yes", "wrangler@4", "secret", "bulk", "--name", "monte-site"], {
            cwd: path.join(__dirname, ".."),
            input: JSON.stringify(secrets),
            stdio: ["pipe", "inherit", "inherit"]
        });
        console.log("copy-build-secrets: copiadas " + names.join(", "));
    }
} catch (error) {
    console.log("copy-build-secrets: não foi possível copiar (" + (error.status ?? error.code ?? "erro") + ")");
}
