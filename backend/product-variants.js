// Cores (variações) de um produto salvas pelo painel (PUT /api/admin/products/:id/variants).
//
// Cor tirada no painel (o × do produto) sai do site na hora, mesmo com estoque: o estoque vai
// a zero e fica registrado no histórico. Com SKU, ligação com a Olist ou venda, a cor fica
// guardada como inativa em vez de apagada:
// - a sincronização com a Olist não mexe em cor inativa e, como o SKU continua no site, não a
//   cria de novo como "cor nova da Olist" (antes, o estoque que a Olist ainda marcava voltava
//   para o site e o painel não deixava remover uma cor com estoque);
// - os pedidos antigos continuam ligados a ela (o banco não deixa apagar uma cor vendida).
// Sem nada disso (cor digitada à toa), é apagada. As inativas não aparecem no painel para
// editar; cadastrar de novo a mesma cor traz a guardada de volta (o banco não aceita duas
// cores com o mesmo nome no produto).

const MAX_VARIANTS = 50;

class VariantsError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function text(value) {
    return value === undefined || value === null ? "" : String(value).trim();
}

// Nome da cor para comparar: sem acento, caixa ou pontuação ("Off-white" = "off white").
function colorKey(value) {
    return text(value).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Valida tudo antes de gravar qualquer coisa: um erro não deixa o produto pela metade.
function readVariants(variants) {
    const list = Array.isArray(variants) ? variants : [];
    if (list.length > MAX_VARIANTS) throw new VariantsError(400, "Quantidade de variações excede o limite.");
    const ids = new Set(list.map(v => text(v?.id)).filter(Boolean));
    const rows = [];
    for (const v of list) {
        const color = text(v?.color);
        if (!color) continue;
        const sku = text(v.sku) || null;
        const stock = Number(v.stock);
        if (color.length > 80 || (sku && sku.length > 80) || !Number.isInteger(stock) || stock < 0 || stock > 100000) {
            throw new VariantsError(400, "Dados de variação ou estoque inválidos.");
        }
        rows.push({ id: text(v.id) || null, color, sku, stock, active: v.active !== false });
    }
    return { ids, rows };
}

// db(path, options) é o supabaseRequest do servidor (REST do Supabase).
async function saveProductVariants({ productId, variants, adminEmail, db, now = () => new Date().toISOString() }) {
    const { ids, rows } = readVariants(variants);
    const loaded = await db(
        "product_variants?product_id=eq." + encodeURIComponent(productId) + "&select=id,color,sku,stock,active,olist_product_id"
    );
    const existing = Array.isArray(loaded) ? loaded : [];
    for (const row of rows) {
        if (row.id && !existing.some(x => x.id === row.id)) throw new VariantsError(404, "Variação não encontrada.");
    }

    const adjustStock = (id, delta, type, reason) => db("rpc/adjust_product_variant_stock", {
        method: "POST",
        body: JSON.stringify({ p_variant_id: id, p_delta: delta, p_movement_type: type, p_reason: reason, p_created_by: adminEmail })
    });
    const patch = (id, body) => db("product_variants?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "Prefer": "return=minimal" },
        body: JSON.stringify(body)
    });
    const result = { archived: [], deleted: [], restored: [] };

    // 1. Cores tiradas no painel.
    for (const old of existing) {
        if (ids.has(old.id) || old.active === false) continue;
        let keep = Boolean(text(old.sku) || old.olist_product_id);
        if (!keep) {
            const sold = await db("order_items?variant_id=eq." + encodeURIComponent(old.id) + "&select=id&limit=1");
            keep = Array.isArray(sold) && sold.length > 0;
        }
        if (!keep) {
            await db("product_variants?id=eq." + encodeURIComponent(old.id), { method: "DELETE", headers: { "Prefer": "return=minimal" } });
            old.deleted = true;
            result.deleted.push(old.color);
            continue;
        }
        await patch(old.id, { active: false, updated_at: now() });
        old.active = false;
        const stock = Number(old.stock || 0);
        if (stock > 0) {
            await adjustStock(old.id, -stock, "adjustment", "Cor removida pelo painel administrativo");
            old.stock = 0;
        }
        result.archived.push(old.color);
    }

    // 2. Cores do painel: as que já existem, as que voltam e as novas.
    for (const row of rows) {
        if (row.id) {
            const current = existing.find(x => x.id === row.id);
            await db("product_variants?id=eq." + encodeURIComponent(row.id), {
                method: "PATCH",
                body: JSON.stringify({ color: row.color, sku: row.sku, active: row.active })
            });
            const delta = row.stock - Number(current.stock || 0);
            if (delta !== 0) await adjustStock(row.id, delta, "adjustment", "Atualização de estoque pelo painel administrativo");
            continue;
        }

        const saved = existing.find(x => x.active === false && !x.deleted && colorKey(x.color) === colorKey(row.color));
        if (saved) {
            const sameSku = text(saved.sku).toUpperCase() === text(row.sku).toUpperCase();
            await patch(saved.id, {
                color: row.color, sku: row.sku, active: row.active,
                ...(sameSku ? {} : { olist_product_id: null }),
                updated_at: now()
            });
            saved.active = row.active;
            const delta = row.stock - Number(saved.stock || 0);
            if (delta !== 0) await adjustStock(saved.id, delta, delta > 0 ? "restock" : "adjustment", "Cor de volta pelo painel administrativo");
            result.restored.push(row.color);
            continue;
        }

        const created = await db("product_variants", {
            method: "POST",
            body: JSON.stringify({ product_id: productId, color: row.color, sku: row.sku, stock: 0, active: row.active })
        });
        const createdVariant = Array.isArray(created) ? created[0] : created;
        if (row.stock > 0) await adjustStock(createdVariant.id, row.stock, "restock", "Estoque inicial pelo painel administrativo");
    }
    return result;
}

module.exports = { VariantsError, colorKey, readVariants, saveProductVariants };
