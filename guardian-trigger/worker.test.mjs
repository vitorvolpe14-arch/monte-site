// Testes do Worker que aciona o guardião (guardian-trigger/worker.mjs).
// Rodam contra um "GitHub" simulado em http local, sem tocar na API de verdade:
//   node --test guardian-trigger/worker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import worker from "./worker.mjs";

const TOKEN = "github_pat_SEGREDO_DE_TESTE";

// GitHub simulado: guarda cada chamada recebida e responde com o status pedido.
async function startGithub(status = 204, responseBody = "") {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(responseBody);
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  return { api, calls, close };
}

async function withGithub(status, responseBody, fn) {
  const github = await startGithub(status, responseBody);
  try { return await fn(github); } finally { await github.close(); }
}

test("a cada disparo, pede ao GitHub para rodar o guardião na branch main", async () => {
  await withGithub(204, "", async github => {
    await worker.scheduled({}, { GITHUB_TOKEN: TOKEN, GITHUB_API: github.api });

    assert.equal(github.calls.length, 1);
    const call = github.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/repos/vitorvolpe14-arch/monte-site/actions/workflows/guardian.yml/dispatches");
    assert.deepEqual(JSON.parse(call.body), { ref: "main" });
  });
});

test("autentica com o token e usa a versão da API que o GitHub exige", async () => {
  await withGithub(204, "", async github => {
    await worker.scheduled({}, { GITHUB_TOKEN: TOKEN, GITHUB_API: github.api });

    const { headers } = github.calls[0];
    assert.equal(headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(headers.accept, "application/vnd.github+json");
    assert.equal(headers["x-github-api-version"], "2022-11-28");
    assert.equal(headers["content-type"], "application/json");
    // O GitHub recusa chamadas sem user-agent; o do Node ("node") existe mesmo se o Worker esquecer,
    // então o teste exige o nome próprio, que também identifica o Worker nos registros do GitHub.
    assert.equal(headers["user-agent"], "monte-guardian-trigger");
  });
});

test("GitHub recusou (401): falha em voz alta, com o status, sem vazar o token", async () => {
  await withGithub(401, '{"message":"Bad credentials"}', async github => {
    await assert.rejects(
      worker.scheduled({}, { GITHUB_TOKEN: TOKEN, GITHUB_API: github.api }),
      error => {
        assert.match(error.message, /401/);
        assert.match(error.message, /Bad credentials/);
        assert.doesNotMatch(error.message, new RegExp(TOKEN));
        return true;
      }
    );
  });
});

test("qualquer resposta diferente de 204 conta como falha (ex.: 200 não dispara nada)", async () => {
  await withGithub(200, "{}", async github => {
    await assert.rejects(worker.scheduled({}, { GITHUB_TOKEN: TOKEN, GITHUB_API: github.api }), /200/);
  });
});

test("corpo de erro enorme é cortado na mensagem", async () => {
  await withGithub(500, "x".repeat(5000), async github => {
    await assert.rejects(
      worker.scheduled({}, { GITHUB_TOKEN: TOKEN, GITHUB_API: github.api }),
      error => {
        assert.match(error.message, /500/);
        assert.ok(error.message.length < 400, `mensagem com ${error.message.length} caracteres`);
        return true;
      }
    );
  });
});

test("sem token configurado: falha com mensagem clara e nem chega a chamar o GitHub", async () => {
  await withGithub(204, "", async github => {
    await assert.rejects(worker.scheduled({}, { GITHUB_API: github.api }), /GITHUB_TOKEN não configurado/);
    assert.equal(github.calls.length, 0);
  });
});

test("segurança: o Worker não atende requisições da internet (só o relógio o aciona)", () => {
  assert.equal(worker.fetch, undefined);
});
