// Entrada da loja no Cloudflare Workers: o mesmo app Express do Render (server.js),
// atendido pelo httpServerHandler, e as tarefas periódicas pelos Cron Triggers.
// As páginas, o CSS, o JS e as fotos saem direto dos assets (veja wrangler.jsonc).
import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import server from "./server.js";

const { app, runScheduledTask, setSiteAssets } = server;

// Páginas sem ".html" no endereço (/, /admin, /pagamento-sucesso) são lidas dos assets.
setSiteAssets(env.ASSETS);

app.listen(3000);
const http = httpServerHandler({ port: 3000 });

export default {
    fetch: (request, env, ctx) => http.fetch(request, env, ctx),
    scheduled(controller, env, ctx) {
        ctx.waitUntil(runScheduledTask(controller.cron));
    }
};
