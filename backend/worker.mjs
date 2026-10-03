// Entrada da loja no Cloudflare Workers: o mesmo app Express do Render (server.js),
// atendido pelo httpServerHandler, e as tarefas periódicas pelos Cron Triggers.
// As páginas, o CSS, o JS e as fotos saem direto dos assets (veja wrangler.jsonc).
import { env } from "cloudflare:workers";
import * as cloudflareWorkers from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import server from "./server.js";

const { app, runScheduledTask, setSiteAssets, setBackgroundRunner } = server;

// Páginas sem ".html" no endereço (/, /admin, /pagamento-sucesso) são lidas dos assets.
setSiteAssets(env.ASSETS);

// Tarefas que seguem depois da resposta (ex.: enviar o pedido pago à Olist) usam o
// waitUntil da requisição em andamento; sem ele o Cloudflare as cancela.
setBackgroundRunner(cloudflareWorkers.waitUntil);

app.listen(3000);
const http = httpServerHandler({ port: 3000 });

// www e o endereço de teste (*.workers.dev) levam ao domínio da loja. Só GET/HEAD:
// os avisos de pagamento (POST) de checkouts antigos continuam sendo atendidos.
const SITE_HOST = "oficialmontee.com.br";

function redirectToSite(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    const url = new URL(request.url);
    if (url.hostname !== "www." + SITE_HOST && !url.hostname.endsWith(".workers.dev")) return null;
    return Response.redirect("https://" + SITE_HOST + url.pathname + url.search, 301);
}

export default {
    fetch: (request, env, ctx) => redirectToSite(request) || http.fetch(request, env, ctx),
    scheduled(controller, env, ctx) {
        ctx.waitUntil(runScheduledTask(controller.cron));
    }
};
