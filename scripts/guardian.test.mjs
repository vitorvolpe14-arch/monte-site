// Testes do guardião da loja (scripts/guardian.mjs).
// Rodam contra uma loja simulada em http local, sem tocar no site de verdade:
//   node --test scripts/guardian.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "guardian.mjs");

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const html = (res, text = "<html><body>MONTÊ</body></html>") => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(text);
};

// Loja saudável: cada rota pode ser trocada por um defeito via `overrides`.
function healthyRoutes() {
  return {
    "GET /": (req, res) => html(res),
    "GET /api/catalogo": (req, res) => json(res, 200, { success: true, products: [{ id: 1, images: ["/media/p/1.jpg"] }] }),
    "GET /api/carousel": (req, res) => json(res, 200, { success: true, slides: [{ src: "/media/c/1.jpg" }] }),
    "GET /sitemap.xml": (req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      // O sitemap real aponta para o domínio de produção; o guardião deve testar o endereço que recebeu.
      res.end('<urlset><url><loc>https://oficialmontee.com.br/produto/1/bolsa</loc></url></urlset>');
    },
    "GET /produto/1/bolsa": (req, res) => html(res),
    "GET /media/p/1.jpg": (req, res) => { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); },
    "GET /style.css": (req, res) => { res.writeHead(200, { "content-type": "text/css" }); res.end("body{}"); },
    "GET /script.js": (req, res) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end("1"); },
    "GET /pagamento-sucesso": (req, res) => html(res),
    "GET /termos-de-compra.html": (req, res) => html(res),
    "GET /entrega-frete.html": (req, res) => html(res),
    "POST /api/criar-checkout": (req, res) => json(res, 400, { success: false, message: "Carrinho vazio." }),
    "POST /webhook-infinitepay": (req, res) => json(res, 400, { success: false, message: "Webhook sem order_nsu." }),
  };
}

async function startSite(overrides = {}) {
  const routes = { ...healthyRoutes(), ...overrides };
  const counts = {};
  const posts = [];
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${new URL(req.url, "http://x").pathname}`;
    counts[key] = (counts[key] || 0) + 1;
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST") posts.push({ key, body });
      const handler = routes[key];
      if (!handler) { res.writeHead(404); res.end("nao encontrado"); return; }
      handler(req, res, counts[key]);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  return { url, close, posts };
}

// Roda o guardião e devolve { code, report }.
function runGuardian(baseUrl, env = {}) {
  const reportPath = join(mkdtempSync(join(tmpdir(), "guardian-")), "report.md");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        GUARDIAN_BASE_URL: baseUrl,
        GUARDIAN_REPORT: reportPath,
        GUARDIAN_RETRY_DELAY_MS: "0",
        GUARDIAN_TIMEOUT_MS: "2000",
        ...env,
      },
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", code => {
      let report = "";
      try { report = readFileSync(reportPath, "utf8"); } catch {}
      resolve({ code, report });
    });
  });
}

async function withSite(overrides, fn, env) {
  const site = await startSite(overrides);
  try { return await fn(site, await runGuardian(site.url, env)); } finally { await site.close(); }
}

test("loja saudável: sai com código 0 e marca tudo como ok", async () => {
  await withSite({}, (site, { code, report }) => {
    assert.equal(code, 0, report);
    assert.match(report, /✅ Página inicial/);
    assert.match(report, /✅ Checkout/);
    assert.doesNotMatch(report, /❌/);
  });
});

test("catálogo com erro 500: alerta no Catálogo e não acusa a foto do produto", async () => {
  await withSite({ "GET /api/catalogo": (req, res) => json(res, 500, { success: false }) }, (site, { code, report }) => {
    assert.equal(code, 1);
    assert.match(report, /❌ Catálogo/);
    assert.doesNotMatch(report, /❌ Foto do produto/);
    assert.match(report, /⏭️ Foto do produto/);
  });
});

test("catálogo vazio conta como falha", async () => {
  await withSite({ "GET /api/catalogo": (req, res) => json(res, 200, { success: true, products: [] }) }, (site, { code, report }) => {
    assert.equal(code, 1);
    assert.match(report, /❌ Catálogo/);
  });
});

test("página inicial sem a marca MONTÊ conta como falha", async () => {
  await withSite({ "GET /": (req, res) => html(res, "<html>Application error</html>") }, (site, { code, report }) => {
    assert.equal(code, 1);
    assert.match(report, /❌ Página inicial/);
  });
});

test("rota de checkout fora do ar conta como falha", async () => {
  await withSite({ "POST /api/criar-checkout": (req, res) => json(res, 500, { success: false }) }, (site, { code, report }) => {
    assert.equal(code, 1);
    assert.match(report, /❌ Checkout/);
  });
});

test("webhook de pagamento inexistente (404) conta como falha", async () => {
  await withSite({ "POST /webhook-infinitepay": (req, res) => { res.writeHead(404); res.end(); } }, (site, { code, report }) => {
    assert.equal(code, 1);
    assert.match(report, /❌ Webhook de pagamento/);
  });
});

test("foto do produto que não carrega (404) conta como falha", async () => {
  await withSite({ "GET /media/p/1.jpg": (req, res) => { res.writeHead(404); res.end(); } }, (site, { code, report }) => {
    assert.equal(code, 1);
    assert.match(report, /❌ Foto do produto/);
  });
});

test("sitemap sem produtos (modo de emergência do servidor) conta como falha", async () => {
  await withSite({
    "GET /sitemap.xml": (req, res) => { res.writeHead(200, { "content-type": "application/xml" }); res.end("<urlset><url><loc>https://oficialmontee.com.br/</loc></url></urlset>"); },
  }, (site, { code, report }) => {
    assert.equal(code, 1);
    assert.match(report, /❌ Sitemap/);
  });
});

test("falha passageira: se a segunda checagem passa, não alerta", async () => {
  await withSite({
    "GET /api/catalogo": (req, res, n) => n === 1
      ? json(res, 500, { success: false })
      : json(res, 200, { success: true, products: [{ id: 1, images: ["/media/p/1.jpg"] }] }),
  }, (site, { code, report }) => {
    assert.equal(code, 0, report);
    assert.doesNotMatch(report, /❌/);
  });
});

test("resposta que trava além do limite conta como falha", async () => {
  await withSite({ "GET /": () => { /* nunca responde */ } }, (site, { code, report }) => {
    assert.equal(code, 1);
    assert.match(report, /❌ Página inicial/);
  }, { GUARDIAN_TIMEOUT_MS: "300" });
});

test("site fora do ar (conexão recusada) falha em todas as checagens", async () => {
  const site = await startSite();
  const url = site.url;
  await site.close();
  const { code, report } = await runGuardian(url);
  assert.equal(code, 1);
  assert.match(report, /❌ Página inicial/);
  assert.match(report, /❌ Checkout/);
});

test("segurança: as sondas de checkout e webhook nunca enviam itens nem criam pedido", async () => {
  await withSite({}, (site, { code }) => {
    assert.equal(code, 0);
    assert.ok(site.posts.length >= 2, "esperava pelo menos duas sondas POST");
    for (const post of site.posts) assert.equal(post.body, "{}", `${post.key} enviou corpo inesperado`);
  });
});
