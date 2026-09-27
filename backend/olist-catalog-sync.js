// Olist -> MONTÊ catalog synchronization.
// Read-only on Olist; writes only to the MONTÊ Supabase catalog.
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function text(value) {
    return value === undefined || value === null ? "" : String(value).trim();
}

function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function firstNumber(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function itemsFrom(data) {
    if (Array.isArray(data?.itens)) return data.itens;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data)) return data;
    return [];
}

function normalizeImages(value) {
    const source = Array.isArray(value)
        ? value
        : (value && typeof value === "object" ? Object.values(value) : []);

    return source.map(item => {
        if (typeof item === "string") return item.trim();
        if (!item || typeof item !== "object") return "";
        return text(item.url || item.link || item.imagem || item.src || item.urlImagem);
    }).filter(Boolean);
}

function normalizeComparableName(value) {
    return text(value)
        .normalize("NFD")
        .replace(/[\\u0300-\\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\\s+/g, " ")
        .trim();
}

function findNameCandidate(existingProducts, name) {
    const target = normalizeComparableName(name);
    if (!target) return null;

    const candidates = (Array.isArray(existingProducts) ? existingProducts : []).filter(product => {
        const current = normalizeComparableName(product?.name);
        if (!current || current === target) return true;
        if (current.length < 8 || target.length < 8) return false;
        return target.startsWith(current + " ") || current.startsWith(target + " ");
    });

    if (candidates.length === 1) return candidates[0];
    return null;
}

function normalizeCategory(product) {
    const raw = text(
        product?.categoria?.nome ||
        product?.categoria ||
        product?.categoriaNome ||
        product?.category
    ).toLowerCase();

    if (raw.includes("cinto")) return "cintos";
    if (raw.includes("acess")) return "acessorios";
    return "bolsas";
}

function productPrice(product) {
    return firstNumber(
        product?.precos?.preco,
        product?.preco,
        product?.precoVenda,
        product?.precoVendaUnitario
    ) || 0;
}

function productSalePrice(product) {
    const value = firstNumber(
        product?.precos?.precoPromocional,
        product?.precoPromocional,
        product?.precoPromocionalVenda
    );
    return value && value > 0 ? value : null;
}

function stockFromObject(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "number" || typeof value === "string") {
        const n = Number(value);
        return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
    }
    if (typeof value === "object") {
        const n = firstNumber(
            value.disponivel,
            value.saldo,
            value.estoque,
            value.quantidade,
            value.qtd,
            value.fisico
        );
        return n === null ? null : Math.max(0, Math.floor(n));
    }
    return null;
}

function variationRows(detail) {
    const candidates = [
        detail?.variacoes,
        detail?.variations,
        detail?.grade?.variacoes,
        detail?.grade
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length) return candidate;
        if (candidate && Array.isArray(candidate.itens) && candidate.itens.length) return candidate.itens;
    }

    return [];
}

function variationSku(variation, fallback) {
    return text(
        variation?.sku ||
        variation?.codigo ||
        variation?.codigoVariacao ||
        variation?.codigoSku ||
        fallback
    );
}

function variationColor(variation) {
    const direct = text(
        variation?.cor ||
        variation?.color ||
        variation?.nome ||
        variation?.descricao ||
        variation?.descricaoVariacao
    );
    if (direct) return direct;

    const attrs = Array.isArray(variation?.atributos) ? variation.atributos : [];
    const color = attrs.find(a => text(a?.nome || a?.chave).toLowerCase().includes("cor"));
    return text(color?.valor || color?.value) || "Única";
}

function variationStock(variation) {
    return stockFromObject(
        variation?.estoque ??
        variation?.saldoEstoque ??
        variation?.quantidadeEstoque ??
        variation?.saldo
    );
}

function shippingValue(detail, keys) {
    for (const key of keys) {
        const value = detail?.[key];
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

function mapProductPayload(detail, summary, existing) {
    const name = text(detail?.descricao || detail?.nome || summary?.descricao || summary?.nome) || "Produto MONTÊ";
    const sku = text(detail?.sku || detail?.codigo || summary?.sku || summary?.codigo) || null;
    const price = productPrice(detail?.precos ? detail : summary);
    const salePrice = productSalePrice(detail?.precos ? detail : summary);
    const images = normalizeImages(
        detail?.imagens ||
        detail?.images ||
        detail?.fotos ||
        summary?.imagens ||
        summary?.images
    );

    const payload = {
        name,
        sku,
        price,
        sale_price: salePrice,
        is_sale: Boolean(salePrice && salePrice < price),
        description: text(detail?.descricaoComplementar || detail?.descricaoComplementarProduto || detail?.descricao || summary?.descricao),
        images,
        active: true,
        olist_product_id: Number(detail?.id || summary?.id),
        olist_updated_at: text(detail?.dataAlteracao || summary?.dataAlteracao) || null
    };

    if (!existing) {
        payload.category = normalizeCategory(detail || summary);
        payload.is_new = false;
        payload.shipping_weight_kg = shippingValue(detail, ["pesoBruto", "peso", "peso_bruto"]);
        payload.shipping_height_cm = shippingValue(detail?.dimensoes || detail, ["altura", "alturaCm", "altura_cm"]);
        payload.shipping_width_cm = shippingValue(detail?.dimensoes || detail, ["largura", "larguraCm", "largura_cm"]);
        payload.shipping_length_cm = shippingValue(detail?.dimensoes || detail, ["comprimento", "comprimentoCm", "comprimento_cm"]);
        if (!payload.images.length) payload.images = [];
    } else {
        // Never overwrite MONTÊ's merchandising fields (category, sale/new flags,
        // active state or shipping dimensions) during automatic Olist sync.
        delete payload.category;
        delete payload.is_new;
        delete payload.shipping_weight_kg;
        delete payload.shipping_height_cm;
        delete payload.shipping_width_cm;
        delete payload.shipping_length_cm;
        if (!payload.images.length) payload.images = Array.isArray(existing.images) ? existing.images : [];
    }

    return payload;
}

async function fetchAllOlistProducts(olistRequest, maxProducts = 500) {
    const all = [];
    const limit = 100;

    for (let page = 1; page <= 20 && all.length < maxProducts; page++) {
        const data = await olistRequest("/produtos?limit=" + limit + "&pagina=" + page);
        const batch = itemsFrom(data);
        if (!batch.length) break;

        all.push(...batch);

        if (batch.length < limit) break;
        await sleep(250);
    }

    return all.slice(0, maxProducts);
}

async function getOlistProductDetail(olistRequest, summary) {
    const id = Number(summary?.id);
    if (!id) return summary;
    try {
        return await olistRequest("/produtos/" + encodeURIComponent(id));
    } catch (error) {
        // Some accounts expose enough fields in the list endpoint. Keep the
        // catalog sync resilient if the detail endpoint is unavailable.
        console.warn("Olist product detail unavailable:", id, error.message);
        return summary;
    }
}

async function getOlistStock(olistRequest, productId) {
    try {
        const data = await olistRequest("/estoque/" + encodeURIComponent(productId));
        return stockFromObject(data?.disponivel ?? data?.saldo ?? data?.estoque ?? data);
    } catch (error) {
        console.warn("Olist stock unavailable:", productId, error.message);
        return null;
    }
}

async function findExistingProduct(supabaseRequest, summary, detail, existingProducts = []) {
    const olistId = Number(detail?.id || summary?.id);
    if (olistId) {
        const byOlist = await supabaseRequest(
            "products?olist_product_id=eq." + encodeURIComponent(olistId) + "&select=*&limit=1"
        );
        if (Array.isArray(byOlist) && byOlist[0]) return byOlist[0];
    }

    const sku = text(detail?.sku || detail?.codigo || summary?.sku || summary?.codigo);
    if (sku) {
        const bySku = await supabaseRequest(
            "products?sku=eq." + encodeURIComponent(sku) + "&select=*&limit=1"
        );
        if (Array.isArray(bySku) && bySku[0]) return bySku[0];
    }

    // Safety guard: if an Olist product has the same base name as an existing
    // MONTÊ product but a different SKU, do not create a duplicate automatically.
    // The Olist documentation recommends SKU as the primary relationship key.
    const nameCandidate = findNameCandidate(
        existingProducts,
        detail?.descricao || detail?.nome || summary?.descricao || summary?.nome
    );
    if (nameCandidate) return {...nameCandidate, _name_candidate:true};

    return null;
}

async function upsertVariant(supabaseRequest, productId, variant, parentProductId, stock) {
    const sku = variationSku(variant, "");
    if (!sku) return {action:"skipped",reason:"variant_without_sku"};

    const existingRows = await supabaseRequest(
        "product_variants?product_id=eq." + encodeURIComponent(productId) +
        "&sku=eq." + encodeURIComponent(sku) +
        "&select=id,color,sku,stock,active,olist_product_id&limit=1"
    );
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;

    const payload = {
        product_id: productId,
        color: variationColor(variant),
        sku,
        active: true,
        olist_product_id: Number(parentProductId)
    };

    if (stock !== null) payload.stock = stock;

    if (existing?.id) {
        await supabaseRequest(
            "product_variants?id=eq." + encodeURIComponent(existing.id),
            {method:"PATCH", body:JSON.stringify(payload)}
        );
        return {action:"updated",sku};
    }

    await supabaseRequest("product_variants", {method:"POST", body:JSON.stringify(payload)});
    return {action:"created",sku};
}

async function syncOneOlistProduct({olistRequest, supabaseRequest, summary, dryRun = false, existingProducts = []}) {
    const detail = await getOlistProductDetail(olistRequest, summary);
    const id = Number(detail?.id || summary?.id);
    if (!id) return {action:"skipped",reason:"missing_id"};

    const situation = text(detail?.situacao || summary?.situacao).toUpperCase();
    if (situation && situation !== "A") {
        return {action:"skipped",reason:"inactive",olist_product_id:id};
    }

    const existing = await findExistingProduct(supabaseRequest, summary, detail, existingProducts);
    const sku = text(detail?.sku || detail?.codigo || summary?.sku || summary?.codigo);

    if (existing?._name_candidate && !existing.olist_product_id) {
        return {
            action:"conflict",
            reason:"similar_name_different_sku",
            sku,
            olist_product_id:id,
            product_id:existing.id,
            existing_sku:existing.sku || null,
            existing_name:existing.name || null
        };
    }

    // Safety rule: never merge two different products just because the SKU
    // collides. Report the collision and leave the MONTÊ product untouched.
    if (existing && existing.olist_product_id && Number(existing.olist_product_id) !== id) {
        return {action:"conflict",sku,olist_product_id:id,product_id:existing.id};
    }

    const payload = mapProductPayload(detail, summary, existing);

    if (dryRun) {
        return {
            action: existing ? "would_update" : "would_create",
            sku,
            olist_product_id:id,
            name:payload.name,
            price:payload.price,
            stock:null
        };
    }

    let product = existing;

    if (product) {
        const updated = await supabaseRequest(
            "products?id=eq." + encodeURIComponent(product.id),
            {method:"PATCH", body:JSON.stringify(payload)}
        );
        product = Array.isArray(updated) ? updated[0] : product;
    } else {
        const created = await supabaseRequest(
            "products",
            {method:"POST", body:JSON.stringify({...payload, category:payload.category || "bolsas"})}
        );
        product = Array.isArray(created) ? created[0] : created;
    }

    if (!product?.id) throw new Error("MONTÊ_PRODUCT_CREATE_FAILED");

    const variations = variationRows(detail);
    const variantResults = [];

    if (variations.length) {
        for (const variation of variations) {
            let stock = variationStock(variation);
            if (stock === null) {
                const variationId = Number(variation?.id || variation?.idVariacao);
                stock = variationId ? await getOlistStock(olistRequest, variationId) : null;
            }
            variantResults.push(await upsertVariant(
                supabaseRequest,
                product.id,
                variation,
                id,
                stock
            ));
            await sleep(250);
        }
    } else {
        let stock = stockFromObject(detail?.estoque || summary?.estoque);
        if (stock === null) stock = await getOlistStock(olistRequest, id);

        variantResults.push(await upsertVariant(
            supabaseRequest,
            product.id,
            {sku, cor:"Única", estoque:stock},
            id,
            stock
        ));
    }

    return {
        action: existing ? "updated" : "created",
        product_id:product.id,
        olist_product_id:id,
        sku,
        name:product.name,
        variants:variantResults
    };
}

async function syncOlistCatalog({olistRequest, supabaseRequest, dryRun = false, maxProducts = 500} = {}) {
    const startedAt = Date.now();
    const summaries = await fetchAllOlistProducts(olistRequest, maxProducts);
    const existingProducts = await supabaseRequest(
        "products?select=id,name,sku,olist_product_id,images&limit=1000"
    );
    const results = [];
    const errors = [];

    for (const summary of summaries) {
        try {
            const result = await syncOneOlistProduct({
                olistRequest,
                supabaseRequest,
                summary,
                dryRun,
                existingProducts
            });
            results.push(result);
        } catch (error) {
            console.error("Olist catalog product sync:", summary?.id, error);
            errors.push({
                olist_product_id:Number(summary?.id || 0) || null,
                sku:text(summary?.sku || summary?.codigo),
                error:String(error.message || error)
            });
        }

        // Keep API calls comfortably below the documented rate limit.
        await sleep(700);
    }

    return {
        dryRun,
        total:summaries.length,
        created:results.filter(r => r.action === "created").length,
        updated:results.filter(r => r.action === "updated").length,
        conflicts:results.filter(r => r.action === "conflict").length,
        skipped:results.filter(r => r.action === "skipped").length,
        errors,
        results,
        duration_ms:Date.now() - startedAt
    };
}

module.exports = {
    syncOlistCatalog
};
