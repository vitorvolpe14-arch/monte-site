// Testes da política de segurança das páginas (CSP): backend/server.js e _headers.
// Rodar: node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = name => readFileSync(new URL("../" + name, import.meta.url), "utf8");

// A CSP do servidor são duas constantes no meio do server.js: avalia só esse trecho.
function serverPolicies() {
    const source = read("backend/server.js");
    const start = source.indexOf("const CONTENT_SECURITY_POLICY = [");
    const adminStart = source.indexOf("const ADMIN_CONTENT_SECURITY_POLICY =", start);
    const end = source.indexOf(";\n", adminStart);
    assert.ok(start > -1 && adminStart > start && end > adminStart, "não achei a CSP em backend/server.js");
    return vm.runInNewContext(source.slice(start, end + 1) + "\n({ site: CONTENT_SECURITY_POLICY, admin: ADMIN_CONTENT_SECURITY_POLICY })");
}

// _headers: uma linha com o caminho e, abaixo dela, as linhas "  Nome: valor".
function headersFile() {
    const rules = {};
    let current = null;
    for (const line of read("_headers").split("\n")) {
        if (!line.trim() || line.startsWith("#")) continue;
        if (!/^\s/.test(line)) { current = rules[line.trim()] = {}; continue; }
        const at = line.indexOf(":");
        if (current && at > -1) current[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return rules;
}

const sources = (policy, name) => (policy.split("; ").find(part => part.startsWith(name + " ")) || "").split(" ").slice(1);

test("servidor e _headers aplicam a mesma política", () => {
    const { site, admin } = serverPolicies();
    const file = headersFile();
    assert.equal(file["/*"]["Content-Security-Policy"], site);
    assert.equal(file["/admin.html"]["Content-Security-Policy"], admin);
});

test("nenhum script ou estilo dentro do HTML", () => {
    for (const policy of Object.values(serverPolicies())) {
        assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
        assert.ok(policy.includes("script-src-attr 'none'"));
    }
});

test("estatísticas da Cloudflare: só o endereço fixo do script é liberado", () => {
    const { site } = serverPolicies();
    const scripts = sources(site, "script-src");
    // Endereço que a loja carrega depois da permissão de estatísticas (script.js, loadCloudflareAnalytics).
    assert.ok(scripts.includes("https://static.cloudflareinsights.com/beacon.min.js"), "script-src: " + scripts.join(" "));
    // A Cloudflare coloca a chamada dela em toda página, em beacon.min.js/v<versão>. Liberar o
    // domínio inteiro (ou a pasta) deixaria essa chamada rodar sem a permissão da visitante.
    for (const source of scripts.filter(source => source.includes("cloudflareinsights"))) {
        assert.equal(source, "https://static.cloudflareinsights.com/beacon.min.js");
    }
    // Os dados vão para /cdn-cgi/rum, na própria loja.
    assert.ok(sources(site, "connect-src").includes("'self'"));
    assert.ok(!sources(site, "connect-src").some(source => source.includes("cloudflareinsights")));
});

test("painel: sem estatísticas de terceiros e sem moldura", () => {
    const { admin } = serverPolicies();
    assert.doesNotMatch(admin, /cloudflareinsights|google/);
    assert.deepEqual(sources(admin, "script-src"), ["'self'"]);
    assert.deepEqual(sources(admin, "frame-ancestors"), ["'none'"]);
});
