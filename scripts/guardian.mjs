#!/usr/bin/env node
// Guardião da loja MONTÊ: varredura sem IA, só requisições HTTP.
//
// Testa o que um cliente precisa para comprar: página inicial, catálogo, fotos, páginas
// de produto, rotas de checkout e de aviso de pagamento. Nada aqui cria pedido nem exige
// senha: as sondas de checkout e webhook enviam "{}" e esperam ser recusadas com 400.
//
// Se algo falhar, espera um pouco e refaz tudo. Só conta como falha o que falhou nas duas
// rodadas, para um tropeço passageiro não gerar alarme falso.
//
// Saída: relatório em markdown (GUARDIAN_REPORT) e código 1 se houver falha persistente.
// Variáveis: GUARDIAN_BASE_URL, GUARDIAN_REPORT, GUARDIAN_TIMEOUT_MS, GUARDIAN_RETRY_DELAY_MS.
import { writeFileSync, appendFileSync } from "node:fs";
import tls from "node:tls";

const envNumber = (name, fallback) => (process.env[name] !== undefined ? Number(process.env[name]) : fallback);

const BASE = (process.env.GUARDIAN_BASE_URL || "https://oficialmontee.com.br").replace(/\/+$/, "");
const REPORT = process.env.GUARDIAN_REPORT || "guardian-report.md";
const TIMEOUT_MS = envNumber("GUARDIAN_TIMEOUT_MS", 15000);
const RETRY_DELAY_MS = envNumber("GUARDIAN_RETRY_DELAY_MS", 60000);
const MIN_CERT_DAYS = 10;

// Lançada por uma checagem que não tem como rodar (falta o dado de outra checagem).
class Skip extends Error {}

async function request(path, init = {}) {
  const started = Date.now();
  const res = await fetch(path.startsWith("http") ? path : BASE + path, {
    redirect: "manual",
    ...init,
    headers: { "user-agent": "monte-guardian/1.0", ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = Buffer.from(await res.arrayBuffer());
  return {
    path,
    status: res.status,
    type: res.headers.get("content-type") || "",
    body,
    text: () => body.toString("utf8"),
    ms: Date.now() - started,
  };
}

function expectStatus(r, expected) {
  if (r.status !== expected) throw new Error(`HTTP ${r.status} em ${r.path} (esperado ${expected})`);
}

function jsonOf(r) {
  try {
    return JSON.parse(r.text());
  } catch {
    throw new Error(`${r.path} não devolveu JSON (HTTP ${r.status})`);
  }
}

function describeError(error) {
  if (error.name === "TimeoutError") return `sem resposta em ${TIMEOUT_MS} ms`;
  if (error.cause?.code) return `falha de conexão (${error.cause.code})`;
  return error.message;
}

function certificateDaysLeft(url) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, timeout: TIMEOUT_MS },
      () => {
        const validTo = socket.getPeerCertificate().valid_to;
        socket.end();
        if (!validTo) return reject(new Error("certificado sem data de validade"));
        resolve(Math.floor((new Date(validTo) - Date.now()) / 86_400_000));
      }
    );
    socket.on("timeout", () => { socket.destroy(); reject(new Error(`sem resposta em ${TIMEOUT_MS} ms`)); });
    socket.on("error", reject);
  });
}

const checks = [
  {
    name: "Página inicial",
    run: async () => {
      const r = await request("/");
      expectStatus(r, 200);
      if (!r.text().includes("MONTÊ")) throw new Error("a página abriu, mas não contém \"MONTÊ\"");
      return `${r.ms} ms`;
    },
  },
  {
    name: "Catálogo",
    run: async ctx => {
      const r = await request("/api/catalogo");
      expectStatus(r, 200);
      const data = jsonOf(r);
      if (data.success !== true || !Array.isArray(data.products) || data.products.length === 0) {
        throw new Error("/api/catalogo não trouxe nenhum produto");
      }
      ctx.productImage = data.products.map(p => p.images?.[0]).find(src => typeof src === "string");
      return `${data.products.length} produtos, ${r.ms} ms`;
    },
  },
  {
    name: "Carrossel",
    run: async () => {
      const r = await request("/api/carousel");
      expectStatus(r, 200);
      const data = jsonOf(r);
      if (data.success !== true || !Array.isArray(data.slides) || data.slides.length === 0) {
        throw new Error("/api/carousel não trouxe nenhuma foto");
      }
      return `${data.slides.length} fotos`;
    },
  },
  {
    name: "Sitemap",
    run: async ctx => {
      const r = await request("/sitemap.xml");
      expectStatus(r, 200);
      // O sitemap aponta para o domínio de produção; testamos o mesmo caminho no endereço recebido.
      const locs = [...r.text().matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(/&amp;/g, "&"));
      const product = locs.find(loc => new URL(loc).pathname.startsWith("/produto/"));
      if (!product) throw new Error("o sitemap não lista nenhum produto (o servidor pode estar sem acesso ao catálogo)");
      const { pathname } = new URL(product);
      ctx.productPath = pathname;
      return `${locs.length} endereços`;
    },
  },
  {
    name: "Página de produto",
    run: async ctx => {
      if (!ctx.productPath) throw new Skip("sem produto no sitemap");
      const r = await request(ctx.productPath);
      expectStatus(r, 200);
      return `${r.ms} ms`;
    },
  },
  {
    name: "Foto do produto",
    run: async ctx => {
      if (!ctx.productImage) throw new Skip("sem produto no catálogo");
      const r = await request(ctx.productImage);
      expectStatus(r, 200);
      if (!r.type.startsWith("image/") || r.body.length === 0) throw new Error(`${r.path} não devolveu uma imagem`);
      return `${r.ms} ms`;
    },
  },
  {
    name: "Arquivos do site",
    run: async () => {
      for (const path of ["/style.css", "/script.js"]) expectStatus(await request(path), 200);
    },
  },
  {
    name: "Páginas institucionais",
    run: async () => {
      for (const path of ["/pagamento-sucesso", "/termos-de-compra.html", "/entrega-frete.html"]) {
        expectStatus(await request(path), 200);
      }
    },
  },
  {
    name: "Checkout",
    run: async () => {
      // Sem itens, o servidor recusa com 400 antes de gravar qualquer pedido.
      const r = await request("/api/criar-checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expectStatus(r, 400);
      if (jsonOf(r).success !== false) throw new Error("/api/criar-checkout não respondeu como esperado");
      return `${r.ms} ms`;
    },
  },
  {
    name: "Webhook de pagamento",
    run: async () => {
      // Sem order_nsu, o servidor recusa com 400 antes de consultar o banco.
      const r = await request("/webhook-infinitepay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expectStatus(r, 400);
      if (jsonOf(r).success !== false) throw new Error("/webhook-infinitepay não respondeu como esperado");
      return `${r.ms} ms`;
    },
  },
  {
    name: "Certificado HTTPS",
    run: async () => {
      const url = new URL(BASE);
      if (url.protocol !== "https:") throw new Skip("só vale para https");
      const days = await certificateDaysLeft(url);
      if (days < MIN_CERT_DAYS) throw new Error(`o certificado vence em ${days} dias`);
      return `vence em ${days} dias`;
    },
  },
];

async function runSuite() {
  const ctx = {};
  const results = [];
  for (const check of checks) {
    try {
      results.push({ name: check.name, status: "ok", note: (await check.run(ctx)) || "" });
    } catch (error) {
      if (error instanceof Skip) results.push({ name: check.name, status: "skip", note: `pulado: ${error.message}` });
      else results.push({ name: check.name, status: "fail", note: describeError(error) });
    }
  }
  return results;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const first = await runSuite();
let results = first;
if (first.some(r => r.status === "fail")) {
  await sleep(RETRY_DELAY_MS);
  const failedBefore = new Set(first.filter(r => r.status === "fail").map(r => r.name));
  results = (await runSuite()).map(r => {
    if (r.status === "ok" && failedBefore.has(r.name)) return { ...r, note: `passou na 2ª tentativa (${r.note || "ok"})` };
    if (r.status === "fail" && !failedBefore.has(r.name)) return { ...r, status: "warn", note: `${r.note} (falhou só na 2ª rodada)` };
    return r;
  });
}

const icon = { ok: "✅", fail: "❌", skip: "⏭️", warn: "⚠️" };
const failures = results.filter(r => r.status === "fail");
const lines = [
  `# Guardião MONTÊ — ${new Date().toISOString()}`,
  "",
  `Site: ${BASE}`,
  `Resultado: ${failures.length ? `❌ ${failures.length} falha(s)` : "✅ tudo certo"}`,
  "",
  ...results.map(r => `- ${icon[r.status]} ${r.name}${r.note ? ` — ${r.note}` : ""}`),
  "",
];
const report = lines.join("\n");

writeFileSync(REPORT, report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(report);
process.exit(failures.length ? 1 : 0);
