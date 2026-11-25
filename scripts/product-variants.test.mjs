// Testes das cores salvas pelo painel (backend/product-variants.js): cor tirada no painel
// sai do site mesmo com estoque e não volta pela sincronização com a Olist.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { VariantsError, saveProductVariants } = require("../backend/product-variants.js");

const PRODUCT = "1b88d9b5-b213-431f-b28a-b7c8fa9e8fd6";

// Banco de mentira: devolve as cores do produto e as vendas, e anota cada chamada.
function fakeDb({ variants = [], sold = [] } = {}) {
    const calls = [];
    const db = async (path, options = {}) => {
        const method = options.method || "GET";
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ method, path, body });
        if (method === "GET" && path.startsWith("product_variants?product_id=")) return variants.map(v => ({ ...v }));
        if (method === "GET" && path.startsWith("order_items?")) {
            const id = decodeURIComponent(path.match(/variant_id=eq\.([^&]+)/)[1]);
            return sold.includes(id) ? [{ id: 1 }] : [];
        }
        if (method === "POST" && path === "product_variants") return [{ id: "nova", ...body }];
        return null;
    };
    return { db, calls };
}

const writes = calls => calls.filter(c => c.method !== "GET");
const stockMoves = calls => calls.filter(c => c.path === "rpc/adjust_product_variant_stock").map(c => c.body);
const save = (db, variants) => saveProductVariants({ productId: PRODUCT, variants, adminEmail: "painel", db, now: () => "2026-11-25T00:00:00.000Z" });

const preto = { id: "preto", color: "Preto", sku: "GERMAN-1", stock: 3, active: true, olist_product_id: 371863453 };
const marrom = { id: "marrom", color: "Marrom", sku: "Germmarr", stock: 1, active: true, olist_product_id: 363863340 };

test("cor da Olist com estoque tirada no painel: fica inativa, estoque a zero, sem apagar", async () => {
    const { db, calls } = fakeDb({ variants: [preto, marrom] });
    const result = await save(db, [{ id: "preto", color: "Preto", sku: "GERMAN-1", stock: 3 }]);
    assert.deepEqual(result.archived, ["Marrom"]);
    assert.ok(!calls.some(c => c.method === "DELETE"));
    const off = calls.find(c => c.method === "PATCH" && c.path === "product_variants?id=eq.marrom");
    assert.equal(off.body.active, false);
    assert.deepEqual(stockMoves(calls), [{
        p_variant_id: "marrom", p_delta: -1, p_movement_type: "adjustment",
        p_reason: "Cor removida pelo painel administrativo", p_created_by: "painel"
    }]);
});

test("cor vendida sem SKU fica inativa (o pedido continua ligado a ela)", async () => {
    const { db, calls } = fakeDb({ variants: [preto, { id: "bege", color: "Bege", sku: null, stock: 0, active: true }], sold: ["bege"] });
    const result = await save(db, [{ id: "preto", color: "Preto", sku: "GERMAN-1", stock: 3 }]);
    assert.deepEqual(result.archived, ["Bege"]);
    assert.ok(!calls.some(c => c.method === "DELETE"));
});

test("cor digitada à toa (sem SKU, Olist ou venda) é apagada", async () => {
    const { db, calls } = fakeDb({ variants: [preto, { id: "x", color: "Azull", sku: "", stock: 2, active: true }] });
    const result = await save(db, [{ id: "preto", color: "Preto", sku: "GERMAN-1", stock: 3 }]);
    assert.deepEqual(result.deleted, ["Azull"]);
    assert.deepEqual(writes(calls).map(c => c.method + " " + c.path), [
        "DELETE product_variants?id=eq.x",
        "PATCH product_variants?id=eq.preto"
    ]);
});

test("cor já inativa não é mexida de novo", async () => {
    const { db, calls } = fakeDb({ variants: [preto, { ...marrom, active: false, stock: 0 }] });
    await save(db, [{ id: "preto", color: "Preto", sku: "GERMAN-1", stock: 3 }]);
    assert.ok(!calls.some(c => c.path.includes("marrom")));
});

test("cadastrar de novo a mesma cor traz a guardada de volta", async () => {
    const { db, calls } = fakeDb({ variants: [preto, { ...marrom, active: false, stock: 0 }] });
    const result = await save(db, [
        { id: "preto", color: "Preto", sku: "GERMAN-1", stock: 3 },
        { color: "marrom", sku: "Germmarr", stock: 2 }
    ]);
    assert.deepEqual(result.restored, ["marrom"]);
    assert.ok(!calls.some(c => c.method === "POST" && c.path === "product_variants"));
    const back = calls.find(c => c.method === "PATCH" && c.path === "product_variants?id=eq.marrom");
    assert.equal(back.body.active, true);
    assert.equal("olist_product_id" in back.body, false, "mesmo SKU: mantém a ligação com a Olist");
    assert.deepEqual(stockMoves(calls).map(m => [m.p_variant_id, m.p_delta, m.p_movement_type]), [["marrom", 2, "restock"]]);
});

test("tirar e pôr a mesma cor no mesmo salvamento com outro SKU desliga da peça antiga da Olist", async () => {
    const { db, calls } = fakeDb({ variants: [preto, marrom] });
    await save(db, [
        { id: "preto", color: "Preto", sku: "GERMAN-1", stock: 3 },
        { color: "Marrom", sku: "GERMAN-2", stock: 1 }
    ]);
    const patches = calls.filter(c => c.method === "PATCH" && c.path === "product_variants?id=eq.marrom").map(c => c.body);
    assert.equal(patches[0].active, false);
    assert.equal(patches[1].active, true);
    assert.equal(patches[1].olist_product_id, null);
    assert.deepEqual(stockMoves(calls).map(m => m.p_delta), [-1, 1]);
});

test("cor nova: cria e lança o estoque inicial", async () => {
    const { db, calls } = fakeDb({ variants: [preto] });
    await save(db, [{ id: "preto", color: "Preto", sku: "GERMAN-1", stock: 3 }, { color: "Caramelo", sku: "GERMAN-3", stock: 4 }]);
    const created = calls.find(c => c.method === "POST" && c.path === "product_variants");
    assert.equal(created.body.stock, 0);
    assert.deepEqual(stockMoves(calls).map(m => [m.p_variant_id, m.p_delta, m.p_movement_type]), [["nova", 4, "restock"]]);
});

test("estoque alterado de uma cor que fica: ajuste pela diferença", async () => {
    const { db, calls } = fakeDb({ variants: [preto] });
    await save(db, [{ id: "preto", color: "Preto", sku: "GERMAN-1", stock: 5 }]);
    assert.deepEqual(stockMoves(calls).map(m => [m.p_delta, m.p_reason]), [[2, "Atualização de estoque pelo painel administrativo"]]);
});

test("dados inválidos ou cor desconhecida: nada é gravado", async () => {
    let fake = fakeDb({ variants: [preto, marrom] });
    await assert.rejects(save(fake.db, [{ color: "Preto", stock: -1 }]), e => e instanceof VariantsError && e.status === 400);
    assert.equal(fake.calls.length, 0);

    fake = fakeDb({ variants: [preto, marrom] });
    await assert.rejects(save(fake.db, [{ id: "outra", color: "Preto", stock: 1 }]), e => e instanceof VariantsError && e.status === 404);
    assert.deepEqual(writes(fake.calls), []);

    fake = fakeDb();
    await assert.rejects(save(fake.db, Array.from({ length: 51 }, (_, i) => ({ color: "C" + i, stock: 0 }))), e => e.status === 400);
});

test("o servidor usa o módulo e não barra mais a cor com estoque", () => {
    const server = readFileSync(new URL("../backend/server.js", import.meta.url), "utf8");
    assert.match(server, /require\("\.\/product-variants\.js"\)/);
    assert.ok(!/Zere o estoque antes de removê-la/.test(server));
});
