let products = [];

// Fotos otimizadas pelo painel (".../opt/...-full.webp") têm uma versão menor (-small)
// para cards, miniaturas e sacola; as demais fotos são usadas como estão.
function smallImage(url) {
    const text = String(url || "");
    return /\/opt\/[^?#]+-full\.(webp|jpg)$/.test(text) ? text.replace(/-full\.(webp|jpg)$/, "-small.$1") : text;
}

// Catálogo: na primeira carga vem dentro da própria página (o servidor já manda os
// produtos no HTML); depois, ou se não vier, é lido em /api/catalogo.
let embeddedCatalogUsed = false;
async function fetchCatalog() {
    if (!embeddedCatalogUsed) {
        embeddedCatalogUsed = true;
        const embedded = document.getElementById("catalogData");
        if (embedded) {
            try {
                const data = JSON.parse(embedded.textContent);
                if (Array.isArray(data)) return data;
            } catch {}
        }
    }
    const response = await fetch("/api/catalogo", { cache: "no-store", headers: { "Accept": "application/json" } });
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.products)) throw new Error(body?.message || "Não foi possível carregar os produtos.");
    return body.products;
}

// Mostra o que vem depois do banner (fica invisível até as vitrines serem montadas).
function revealCatalogSections() {
    document.documentElement.classList.remove("catalog-pending");
}

// Pré-venda é vendida mesmo sem estoque (a MONTÊ aceita ou recusa cada pedido no painel):
// na loja, cada cor ativa da bolsa aparece disponível, até 20 por pedido (o limite do checkout).
const PRESALE_MAX_PER_ORDER = 20;
function storeVariants(product) {
    const variants = product.product_variants || [];
    if (!product.is_presale) return variants;
    return variants.map(variant => variant.active === false ? variant : { ...variant, stock: PRESALE_MAX_PER_ORDER });
}

async function loadProductsFromDatabase() {
    let data;
    try {
        data = await fetchCatalog();
    } catch (error) {
        console.error("Erro ao carregar produtos:", error);
        revealCatalogSections();
        return;
    }

    products = (data || []).map(product => ({
        ...product,
        price: product.is_sale && product.sale_price != null
            ? Number(product.sale_price)
            : Number(product.price || 0),
        oldPrice: product.is_sale && product.sale_price != null
            ? Number(product.price || 0)
            : null,
        sale: !!product.is_sale,
        newProduct: !!product.is_new,
        presale: !!product.is_presale,
        images: Array.isArray(product.images) ? product.images : [],
        variants: storeVariants(product),
        stock: storeVariants(product)
            .filter(variant => variant.active !== false)
            .reduce((total, variant) => total + Number(variant.stock || 0), 0)
    }));

    renderProducts();
    revealCatalogSections();
    // As opções de presente das promoções vêm do catálogo.
    if (cart.length) updatePaymentSummary();
}

/* =====================================================
   ESTADO
===================================================== */

let cart = [];
let selectedPaymentMethod = "pix";
// Cupom conferido pelo servidor ({ code, discount_type, discount_value }).
let appliedCoupon = null;

// Promoções de presente no ar (cadastradas no painel, vêm de /api/promocoes).
let storePromotions = [];
const GIFT_STORAGE_KEY = "monteGift";
// Presente escolhido: { promotion_id, product_id, variant_id }.
let selectedGift = (() => {
    try { return JSON.parse(localStorage.getItem(GIFT_STORAGE_KEY) || "null"); } catch { return null; }
})();
let shippingOptions = [];
let selectedShippingOption = null;
let shippingRequestId = 0;

let selectedProduct = null;
let selectedVariant = null;
let selectedQuantity = 1;

let currentSlide = 0;
let currentGalleryIndex = 0;

// Coleção, Novidades e Sale: 3 produtos por vez (fotos maiores) e as setas avançam 3.
const PRODUCTS_PER_PAGE = 3;
const COLLECTION_STEP = PRODUCTS_PER_PAGE;
let collectionProducts = [];
let currentCollectionIndex = 0;

const SALE_STEP = PRODUCTS_PER_PAGE;
let saleProducts = [];
let currentSaleIndex = 0;

const NEW_STEP = PRODUCTS_PER_PAGE;
let newProducts = [];
let currentNewIndex = 0;

function getCarouselVisibleCount() {
    return PRODUCTS_PER_PAGE;
}


/* =====================================================
   FORMATAÇÃO DE PREÇO
===================================================== */

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    })[char]);
}

function formatPrice(value) {

    return new Intl.NumberFormat(
        "pt-BR",
        {
            style: "currency",
            currency: "BRL"
        }
    ).format(value);

}


/* =====================================================
   CRIAR CARD
===================================================== */

function createProductCard(product) {

    const card = document.createElement("article");

    card.className = "product-card";
    card.dataset.productId = product.id;
    card.dataset.productName = product.name || "";

    const image =
        product.images && product.images.length
            ? product.images[0]
            : "data:image/svg+xml;charset=UTF-8," +
              encodeURIComponent(`
                <svg xmlns="http://www.w3.org/2000/svg"
                     width="600"
                     height="800"
                     viewBox="0 0 600 800">
                    <rect width="600" height="800" fill="#f3f3f1"/>
                    <text x="300"
                          y="390"
                          text-anchor="middle"
                          font-family="Arial"
                          font-size="18"
                          letter-spacing="4"
                          fill="#222">
                        MONTÊ
                    </text>
                </svg>
              `);

    const productStock = Number(product.stock || 0);
    const isOutOfStock = productStock <= 0;

    let priceHTML = "";

    if (product.sale && product.oldPrice) {

        priceHTML = `
            <span class="old-price">
                ${formatPrice(product.oldPrice)}
            </span>

            <span class="sale-price">
                ${formatPrice(product.price)}
            </span>
        `;

    } else {

        priceHTML =
            product.price !== undefined
                ? formatPrice(product.price)
                : "Preço em breve";

    }

    setHTML(card, `

        <div class="product-image">

            ${
                product.sale
                ?
                `<span class="product-badge">
                    SALE
                </span>`
                :
                ""
            }

            ${
                product.presale && !isOutOfStock
                ?
                `<span class="product-badge product-badge-presale">
                    PRÉ-VENDA
                </span>`
                :
                product.newProduct && !product.presale
                ?
                `<span class="product-badge">
                    NOVO
                </span>`
                :
                ""
            }

            ${
                isOutOfStock
                ?
                `<span class="product-badge product-badge-stock">
                    ESGOTADO
                </span>`
                :
                ""
            }

            <img
                src="${escapeHTML(smallImage(image))}"
                alt="${escapeHTML(product.name)}"
                loading="lazy"
                decoding="async"
            >

        </div>

        <div class="product-info">

            <div class="product-name">
                ${escapeHTML(product.name)}
            </div>

            <div class="product-price">
                ${priceHTML}
            </div>

            ${product.presale && !isOutOfStock ? '<div class="presale-card-cta">Garanta a sua!</div>' : ""}

        </div>

    `);

    const productImageFrame = card.querySelector(".product-image");
    const productImageElement = card.querySelector(".product-image img");

    if (productImageFrame && productImageElement) {
        const applyProductBackground = () => {
            if (productImageElement.currentSrc || productImageElement.src) {
                productImageFrame.style.setProperty(
                    "--product-bg",
                    'url("' + (productImageElement.currentSrc || productImageElement.src).replace(/"/g, '%22') + '")'
                );
            }
        };

        if (productImageElement.complete) {
            applyProductBackground();
        } else {
            // Enquanto a foto baixa, o cartão mostra um fundo suave em vez de ficar em branco.
            productImageFrame.classList.add("is-loading");
            const loaded = () => productImageFrame.classList.remove("is-loading");
            productImageElement.addEventListener("load", () => { loaded(); applyProductBackground(); }, { once: true });
            productImageElement.addEventListener("error", loaded, { once: true });
        }
    }

    card.addEventListener(
        "click",
        () => openProductModal(product.id)
    );

    return card;
}


/* =====================================================
   RENDER PRODUTOS
===================================================== */

function renderProducts() {
    const newContainer = document.getElementById("newProducts");
    if (newContainer) newContainer.replaceChildren();

    // Bolsas em pré-venda não aparecem nas vitrines da página inicial.
    const inStore = products.filter(product => !product.presale);

    renderCollectionProducts(
        inStore.filter(product => product.category === "bolsas")
    );

    renderCategorySectionProducts(
        "cintos-acessorios",
        inStore.filter(product => product.category === "cintos" || product.category === "acessorios")
    );

    renderSaleProducts(inStore.filter(product => product.sale));
    renderNewProducts(inStore.filter(product => product.newProduct));
}


function renderCollectionProducts(list) {

    collectionProducts = Array.isArray(list)
        ? list
        : [];

    currentCollectionIndex = 0;

    renderCollectionPage();

}


function renderNewProducts(list) {

    newProducts = Array.isArray(list)
        ? list
        : [];

    currentNewIndex = 0;

    renderNewPage();

}


// As vitrines mostram poucos produtos por vez. A próxima página já fica baixada enquanto a
// cliente olha a atual: antes as fotos só começavam a baixar no toque da seta e o cartão
// ficava em branco. Só baixa quando a vitrine está na tela, para não gastar dados à toa.
const preloadedImages = new Map();
const pendingPreloads = new WeakMap();
const preloadObserver = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const urls = pendingPreloads.get(entry.target);
        pendingPreloads.delete(entry.target);
        (urls || []).forEach(preloadImage);
    });
}, { rootMargin: "300px 0px" }) : null;

function preloadImage(url) {
    if (!url || preloadedImages.has(url)) return;
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    preloadedImages.set(url, image);
}

function preloadNextPage(container, list, start, count) {
    if (!container || !Array.isArray(list) || list.length <= count) return;
    const urls = [];
    for (let offset = count; offset < count * 2; offset++) {
        const image = list[(start + offset) % list.length]?.images?.[0];
        if (image) urls.push(smallImage(image));
    }
    // A página anterior também, para a seta de voltar deslizar com as fotos prontas.
    for (let offset = -count; offset < 0; offset++) {
        const image = list[(start + offset + list.length * 2) % list.length]?.images?.[0];
        if (image) urls.push(smallImage(image));
    }
    if (!preloadObserver) return urls.forEach(preloadImage);
    pendingPreloads.set(container, urls);
    preloadObserver.unobserve(container);
    preloadObserver.observe(container);
}

// Troca de página das vitrines como um carrossel: os produtos atuais e os próximos andam
// juntos, lado a lado, como uma faixa só (3 por vez). Sem animação se a cliente prefere
// movimento reduzido.
const PAGE_SLIDE_DURATION = 750;
const PAGE_SLIDE_EASING = "cubic-bezier(.65, 0, .35, 1)";
const runningPageSlides = new WeakMap();

function slidePage(container, direction, change) {
    if (!container) return change();
    // Clique durante o deslize: termina o anterior na hora e já começa o próximo.
    runningPageSlides.get(container)?.();

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !container.animate) return change();

    const box = container.getBoundingClientRect();
    const originX = box.left + container.clientLeft;
    const originY = box.top + container.clientTop;
    const oldCards = [...container.children].map(card => ({ card, rect: card.getBoundingClientRect() }));

    change();

    const newCards = [...container.children];
    if (!oldCards.length || !newCards.length) return;

    const style = getComputedStyle(container);
    const contentWidth = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const shift = (contentWidth + (parseFloat(style.columnGap) || 0)) * direction;

    const previous = { position: container.style.position, overflowX: container.style.overflowX };
    if (style.position === "static") container.style.position = "relative";
    container.style.overflowX = CSS.supports?.("overflow-x", "clip") ? "clip" : "hidden";

    // Os cartões que estão saindo voltam por cima, no mesmo lugar, até a faixa terminar de andar.
    oldCards.forEach(({ card, rect }) => {
        const place = {
            position: "absolute", margin: "0", "pointer-events": "none",
            left: rect.left - originX + "px", top: rect.top - originY + "px",
            width: rect.width + "px", height: rect.height + "px"
        };
        Object.entries(place).forEach(([property, value]) => card.style.setProperty(property, value, "important"));
        container.appendChild(card);
    });

    const timing = { duration: PAGE_SLIDE_DURATION, easing: PAGE_SLIDE_EASING };
    const animations = [
        ...oldCards.map(({ card }) => card.animate(
            [{ transform: "translateX(0)" }, { transform: `translateX(${-shift}px)` }],
            { ...timing, fill: "forwards" }
        )),
        ...newCards.map(card => card.animate(
            [{ transform: `translateX(${shift}px)` }, { transform: "translateX(0)" }],
            timing
        ))
    ];

    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        runningPageSlides.delete(container);
        animations.forEach(animation => animation.cancel());
        oldCards.forEach(({ card }) => card.remove());
        container.style.position = previous.position;
        container.style.overflowX = previous.overflowX;
    };
    runningPageSlides.set(container, finish);
    animations[0].finished.then(finish, () => {});
}

function renderNewPage() {

    const container =
        document.getElementById("newProducts");

    const previousButton =
        document.querySelector(".new-prev");

    const nextButton =
        document.querySelector(".new-next");

    if (!container) return;

    container.replaceChildren();

    if (!newProducts.length) {
        if (previousButton) {
            previousButton.disabled = true;
            previousButton.style.visibility = "hidden";
        }
        if (nextButton) {
            nextButton.disabled = true;
            nextButton.style.visibility = "hidden";
        }
        return;
    }

    const total = newProducts.length;
    const start = currentNewIndex % total;

    for (
        let offset = 0;
        offset < Math.min(getCarouselVisibleCount(), total);
        offset++
    ) {
        const product =
            newProducts[(start + offset) % total];

        container.appendChild(
            createProductCard(product)
        );
    }

    preloadNextPage(container, newProducts, start, Math.min(getCarouselVisibleCount(), total));

    const hasCarousel =
        total > getCarouselVisibleCount();

    if (previousButton) {
        previousButton.disabled = !hasCarousel;
        previousButton.style.visibility =
            hasCarousel ? "visible" : "hidden";
    }

    if (nextButton) {
        nextButton.disabled = !hasCarousel;
        nextButton.style.visibility =
            hasCarousel ? "visible" : "hidden";
    }

}


function nextNewPage() {

    if (newProducts.length <= getCarouselVisibleCount()) return;

    slidePage(document.getElementById("newProducts"), 1, () => {
        currentNewIndex =
            (currentNewIndex + NEW_STEP) % newProducts.length;
        renderNewPage();
    });

}


function previousNewPage() {

    if (newProducts.length <= getCarouselVisibleCount()) return;

    slidePage(document.getElementById("newProducts"), -1, () => {
        currentNewIndex =
            (currentNewIndex - NEW_STEP + newProducts.length) %
            newProducts.length;
        renderNewPage();
    });

}


function renderSaleProducts(list) {

    saleProducts = Array.isArray(list)
        ? list
        : [];

    currentSaleIndex = 0;

    renderSalePage();

}


function renderSalePage() {

    const container =
        document.getElementById("saleProducts");

    const previousButton =
        document.querySelector(".sale-prev");

    const nextButton =
        document.querySelector(".sale-next");

    if (!container) return;

    container.replaceChildren();

    if (!saleProducts.length) {
        if (previousButton) {
            previousButton.disabled = true;
            previousButton.style.visibility = "hidden";
        }
        if (nextButton) {
            nextButton.disabled = true;
            nextButton.style.visibility = "hidden";
        }
        return;
    }

    const total = saleProducts.length;
    const start = currentSaleIndex % total;

    for (
        let offset = 0;
        offset < Math.min(getCarouselVisibleCount(), total);
        offset++
    ) {
        const product =
            saleProducts[(start + offset) % total];

        container.appendChild(
            createProductCard(product)
        );
    }

    preloadNextPage(container, saleProducts, start, Math.min(getCarouselVisibleCount(), total));

    const hasCarousel =
        total > getCarouselVisibleCount();

    if (previousButton) {
        previousButton.disabled = !hasCarousel;
        previousButton.style.visibility =
            hasCarousel ? "visible" : "hidden";
    }

    if (nextButton) {
        nextButton.disabled = !hasCarousel;
        nextButton.style.visibility =
            hasCarousel ? "visible" : "hidden";
    }

}


function nextSalePage() {

    if (saleProducts.length <= getCarouselVisibleCount()) {
        return;
    }

    slidePage(document.getElementById("saleProducts"), 1, () => {
        currentSaleIndex =
            (currentSaleIndex + SALE_STEP) % saleProducts.length;
        renderSalePage();
    });

}


function previousSalePage() {

    if (saleProducts.length <= getCarouselVisibleCount()) {
        return;
    }

    slidePage(document.getElementById("saleProducts"), -1, () => {
        currentSaleIndex =
            (currentSaleIndex - SALE_STEP + saleProducts.length) % saleProducts.length;
        renderSalePage();
    });

}


function renderCollectionPage() {

    const container =
        document.getElementById("allProducts");

    const previousButton =
        document.querySelector(".collection-prev");

    const nextButton =
        document.querySelector(".collection-next");


    if (!container) return;


    container.replaceChildren();


    if (!collectionProducts.length) {

        if (previousButton) {
            previousButton.disabled = true;
        }

        if (nextButton) {
            nextButton.disabled = true;
        }

        return;

    }


    const total = collectionProducts.length;

    const start = currentCollectionIndex % total;


    for (
        let offset = 0;
        offset < Math.min(getCarouselVisibleCount(), total);
        offset++
    ) {

        const product =
            collectionProducts[(start + offset) % total];

        container.appendChild(
            createProductCard(product)
        );

    }

    preloadNextPage(container, collectionProducts, start, Math.min(getCarouselVisibleCount(), total));


    const hasCarousel =
        total > getCarouselVisibleCount();


    if (previousButton) {
        previousButton.disabled = !hasCarousel;
        previousButton.style.visibility =
            hasCarousel ? "visible" : "hidden";
    }

    if (nextButton) {
        nextButton.disabled = !hasCarousel;
        nextButton.style.visibility =
            hasCarousel ? "visible" : "hidden";
    }

}


function nextCollectionPage() {

    if (collectionProducts.length <= getCarouselVisibleCount()) {
        return;
    }


    slidePage(document.getElementById("allProducts"), 1, () => {
        currentCollectionIndex =
            (currentCollectionIndex + COLLECTION_STEP) %
            collectionProducts.length;
        renderCollectionPage();
    });

}


function previousCollectionPage() {

    if (collectionProducts.length <= getCarouselVisibleCount()) {
        return;
    }


    slidePage(document.getElementById("allProducts"), -1, () => {
        currentCollectionIndex =
            (currentCollectionIndex - COLLECTION_STEP +
                collectionProducts.length) %
            collectionProducts.length;
        renderCollectionPage();
    });

}


let categorySectionProducts = { cintos: [], acessorios: [] };
let categorySectionIndexes = { cintos: 0, acessorios: 0 };

// A vitrine de categoria divide a largura com o texto ao lado:
// 3 cards por vez no computador e 2 no celular.
function getCategoryVisibleCount() {
    return window.matchMedia("(max-width: 650px)").matches ? 2 : 3;
}

function categoryContainer(category) {
    return document.getElementById(category === "cintos-acessorios" ? "cintosAcessoriosProducts" : category + "Products");
}

function renderCategorySection(category) {
    const container = categoryContainer(category);
    if (!container) return;

    const list = categorySectionProducts[category] || [];
    const prev = document.querySelector('#' + category + ' .category-prev');
    const next = document.querySelector('#' + category + ' .category-next');

    container.replaceChildren();

    if (!list.length) {
        if (prev) prev.style.visibility = "hidden";
        if (next) next.style.visibility = "hidden";
        return;
    }

    const total = list.length;
    const start = categorySectionIndexes[category] % total;

    for (let offset = 0; offset < Math.min(getCategoryVisibleCount(), total); offset++) {
        container.appendChild(createProductCard(list[(start + offset) % total]));
    }
    preloadNextPage(container, list, start, Math.min(getCategoryVisibleCount(), total));

    const hasCarousel = total > getCategoryVisibleCount();
    if (prev) {
        prev.disabled = !hasCarousel;
        prev.style.visibility = hasCarousel ? "visible" : "hidden";
    }
    if (next) {
        next.disabled = !hasCarousel;
        next.style.visibility = hasCarousel ? "visible" : "hidden";
    }
}

function renderCategorySectionProducts(category, list) {
    categorySectionProducts[category] = Array.isArray(list) ? list : [];
    categorySectionIndexes[category] = 0;
    renderCategorySection(category);
}

function nextCategoryPage(category) {
    const list = categorySectionProducts[category] || [];
    if (list.length <= getCategoryVisibleCount()) return;
    slidePage(categoryContainer(category), 1, () => {
        categorySectionIndexes[category] =
            (categorySectionIndexes[category] + getCategoryVisibleCount()) % list.length;
        renderCategorySection(category);
    });
}

function previousCategoryPage(category) {
    const list = categorySectionProducts[category] || [];
    if (list.length <= getCategoryVisibleCount()) return;
    slidePage(categoryContainer(category), -1, () => {
        categorySectionIndexes[category] =
            (categorySectionIndexes[category] - getCategoryVisibleCount() + list.length) % list.length;
        renderCategorySection(category);
    });
}

// No celular, arrastar a vitrine para o lado também troca de página.
function enableShowcaseSwipe(id, next, previous) {
    const container = document.getElementById(id);
    if (!container) return;
    let startX = 0;
    let startY = 0;
    let swiped = false;
    container.addEventListener("touchstart", event => {
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        swiped = false;
    }, { passive: true });
    container.addEventListener("touchend", event => {
        const dx = event.changedTouches[0].clientX - startX;
        const dy = event.changedTouches[0].clientY - startY;
        if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        swiped = true;
        if (dx < 0) next();
        else previous();
    }, { passive: true });
    // O arraste não pode abrir o produto em que o dedo começou.
    container.addEventListener("click", event => {
        if (!swiped) return;
        swiped = false;
        event.stopPropagation();
    }, true);
}

enableShowcaseSwipe("newProducts", nextNewPage, previousNewPage);
enableShowcaseSwipe("saleProducts", nextSalePage, previousSalePage);
enableShowcaseSwipe("allProducts", nextCollectionPage, previousCollectionPage);
enableShowcaseSwipe("cintosAcessoriosProducts", () => nextCategoryPage("cintos-acessorios"), () => previousCategoryPage("cintos-acessorios"));

/* =====================================================
   FILTRO
===================================================== */

let lastMobileCarouselMode = window.matchMedia("(max-width: 650px)").matches;

window.addEventListener("resize", () => {
    const mobileMode = window.matchMedia("(max-width: 650px)").matches;
    if (mobileMode === lastMobileCarouselMode) return;
    lastMobileCarouselMode = mobileMode;
    renderCollectionPage();
    renderCategorySection("cintos-acessorios");
    renderNewPage();
    renderSalePage();
});

/* =====================================================
   MODAL PRODUTO
===================================================== */

// Algumas cores estão cadastradas com o nome do produto ("Bag Vienna - preta"):
// na loja aparece só a cor ("Preta"). O cadastro não muda.
function colorLabel(color, productName) {
    const text = String(color || "").trim();
    const name = String(productName || "").trim();
    const plain = value => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (!text || !name || text.length <= name.length || !plain(text).startsWith(plain(name))) return text;
    const rest = text.slice(name.length).replace(/^[\s\-–—:|]+/, "").trim();
    return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : text;
}

function openWhatsAppReservation(product = selectedProduct, variant = selectedVariant) {
    if (!product) return;

    const productName = product.name || "produto MONTÊ";
    const color = variant?.color ? " — cor: " + colorLabel(variant.color, product.name) : "";
    const message = "Olá, MONTÊ! Gostaria de reservar o produto \"" + productName + "\""+ color + ". Vi que ele está esgotado e gostaria de saber a disponibilidade para reserva.";
    const url = "https://wa.me/5585992163305?text=" + encodeURIComponent(message);
    window.open(url, "_blank", "noopener,noreferrer");
}

function updateProductAvailabilityUI() {
    const product = selectedProduct;
    if (!product) return;

    const activeVariants = (product.variants || []).filter(v => v.active !== false);
    const totalStock = activeVariants.length
        ? activeVariants.reduce((total, variant) => total + Number(variant.stock || 0), 0)
        : Number(product.stock || 0);
    const selectedStock = selectedVariant ? Number(selectedVariant.stock || 0) : totalStock;
    const isProductSoldOut = totalStock <= 0;
    const isSelectionSoldOut = selectedStock <= 0;

    const quantityTitle = document.querySelector("#productModal .quantity-title");
    const quantitySelector = document.querySelector("#productModal .quantity-selector");
    const addButton = document.getElementById("addProductButton");
    const buyNowButton = document.getElementById("buyNowButton");
    const reservationBox = document.getElementById("reservationBox");

    if (quantityTitle) quantityTitle.style.display = isSelectionSoldOut ? "none" : "";
    if (quantitySelector) quantitySelector.style.display = isSelectionSoldOut ? "none" : "";
    if (addButton) addButton.style.display = isSelectionSoldOut ? "none" : "";
    if (buyNowButton) buyNowButton.style.display = isSelectionSoldOut ? "none" : "";

    if (reservationBox) {
        if (isSelectionSoldOut) {
            const text = isProductSoldOut
                ? "Esse produto se encontra esgotado no momento. Entre em contato com nossos atendentes para fazer sua reserva."
                : "Essa cor se encontra esgotada no momento. Entre em contato com nossos atendentes para fazer sua reserva.";
            reservationBox.querySelector(".reservation-message").textContent = text;
            reservationBox.style.display = "block";
        } else {
            reservationBox.style.display = "none";
        }
    }
}

function openProductModal(productId) {
    selectedProduct = products.find(product => product.id === productId);
    if (!selectedProduct) return;

    selectedVariant = null;
    selectedQuantity = 1;

    const activeVariants = (selectedProduct.variants || []).filter(v => v.active !== false);
    const availableVariants = activeVariants.filter(v => Number(v.stock || 0) > 0);
    if (availableVariants.length) selectedVariant = availableVariants[0];

    document.getElementById("quantity").textContent = selectedQuantity;
    document.getElementById("modalName").textContent = selectedProduct.name;
    document.getElementById("modalCategory").textContent = selectedProduct.category.toUpperCase();
    document.getElementById("modalDescription").textContent = selectedProduct.description;

    let priceHTML = formatPrice(selectedProduct.price);
    if (selectedProduct.sale && selectedProduct.oldPrice) {
        priceHTML = '<span class="old-price">' + formatPrice(selectedProduct.oldPrice) + '</span>' +
            '<span class="sale-price">' + formatPrice(selectedProduct.price) + '</span>';
    }
    setHTML(document.getElementById("modalPrice"), priceHTML);

    // Produtos da Sale não acompanham dustbag: o aviso aparece ao abrir qualquer um deles.
    const saleNotice = document.getElementById("modalSaleNotice");
    if (saleNotice) saleNotice.hidden = !selectedProduct.sale;

    // Pré-venda: destaque "Garanta a sua!" e a entrega em 10 dias úteis.
    const presaleNotice = document.getElementById("modalPresaleNotice");
    if (presaleNotice) presaleNotice.hidden = !selectedProduct.presale;
    const buyNowLabel = document.getElementById("buyNowButton");
    if (buyNowLabel) buyNowLabel.textContent = selectedProduct.presale ? "GARANTA A SUA!" : "COMPRAR AGORA";

    const variantSelector = document.getElementById("variantSelector");
    const variantOptions = document.getElementById("variantOptions");
    if (variantSelector && variantOptions) {
        if (activeVariants.length) {
            variantSelector.style.display = "block";
            variantOptions.replaceChildren();
            activeVariants.forEach(variant => {
                const button = document.createElement("button");
                button.type = "button";
                const variantAvailable = Number(variant.stock || 0) > 0;
                const isSelected = selectedVariant?.id === variant.id;
                button.className = "variant-option" + (isSelected ? " active" : "") + (variantAvailable ? "" : " unavailable");
                const label = colorLabel(variant.color, selectedProduct.name);
                button.textContent = variantAvailable ? label : (label || "Cor") + " — esgotado";
                button.disabled = false;
                button.addEventListener("click", () => {
                    selectedVariant = variant;
                    selectedQuantity = 1;
                    document.querySelectorAll(".variant-option").forEach(b => b.classList.remove("active"));
                    button.classList.add("active");
                    document.getElementById("quantity").textContent = "1";
                    updateProductAvailabilityUI();
                });
                variantOptions.appendChild(button);
            });
        } else {
            variantSelector.style.display = "none";
            variantOptions.replaceChildren();
        }
    }

    updateProductAvailabilityUI();
    renderGallery();
    document.getElementById("productModal").classList.add("active");
    document.body.style.overflow = "hidden";
}


/* =====================================================
   GALERIA
===================================================== */

function setGalleryImage(index) {
    if (!selectedProduct || !Array.isArray(selectedProduct.images) || !selectedProduct.images.length) return;

    const total = selectedProduct.images.length;
    currentGalleryIndex = (index + total) % total;

    const image = selectedProduct.images[currentGalleryIndex];
    const mainImage = document.getElementById("modalMainImage");

    if (mainImage) {
        // A foto pequena já está no aparelho (cartão e miniaturas): aparece na hora, e a grande
        // entra no lugar quando terminar de baixar. Antes a janela ficava sem foto até lá.
        const small = smallImage(image);
        mainImage.dataset.full = image;
        mainImage.src = small;
        if (small !== image) {
            const full = new Image();
            full.onload = () => { if (mainImage.dataset.full === image) mainImage.src = image; };
            full.src = image;
        }
        mainImage.alt = selectedProduct.name || "Produto MONTÊ";
    }

    document.querySelectorAll(".gallery-thumbnail").forEach((item, itemIndex) => {
        item.classList.toggle("active", itemIndex === currentGalleryIndex);
    });
}

function renderGallery() {
    const mainImage = document.getElementById("modalMainImage");
    const thumbnails = document.getElementById("galleryThumbnails");

    if (!mainImage || !thumbnails || !selectedProduct) return;

    currentGalleryIndex = 0;
    thumbnails.replaceChildren();

    (selectedProduct.images || []).forEach((image, index) => {
        const thumbnail = document.createElement("img");

        thumbnail.src = smallImage(image);
        thumbnail.decoding = "async";
        thumbnail.alt = (selectedProduct.name || "Produto MONTÊ") + " — foto " + (index + 1);
        thumbnail.className = "gallery-thumbnail";
        thumbnail.loading = "lazy";

        thumbnail.addEventListener("click", () => {
            setGalleryImage(index);
        });

        thumbnails.appendChild(thumbnail);
    });

    setGalleryImage(0);

    mainImage.onclick = () => openProductImageLightbox(currentGalleryIndex);
    mainImage.setAttribute("role", "button");
    mainImage.setAttribute("tabindex", "0");
    mainImage.setAttribute("aria-label", "Ampliar foto do produto");

    mainImage.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openProductImageLightbox(currentGalleryIndex);
        }
    };
}

function updateProductLightbox() {
    if (!selectedProduct || !selectedProduct.images?.length) return;

    const image = selectedProduct.images[currentGalleryIndex];
    const lightboxImage = document.getElementById("productLightboxImage");
    const counter = document.getElementById("productLightboxCounter");
    const lightbox = document.getElementById("productImageLightbox");
    const total = selectedProduct.images.length;

    if (lightboxImage) {
        lightboxImage.src = image;
        lightboxImage.alt = (selectedProduct.name || "Produto MONTÊ") + " — foto " + (currentGalleryIndex + 1);
    }

    if (counter) {
        counter.textContent = total > 1 ? (currentGalleryIndex + 1) + " / " + total : "";
    }

    if (lightbox) {
        lightbox.classList.toggle("single-image", total <= 1);
    }
}

function openProductImageLightbox(index = currentGalleryIndex) {
    if (!selectedProduct || !selectedProduct.images?.length) return;

    currentGalleryIndex = index;
    updateProductLightbox();

    const lightbox = document.getElementById("productImageLightbox");
    if (!lightbox) return;

    lightbox.classList.add("active");
    lightbox.setAttribute("aria-hidden", "false");
    document.body.classList.add("product-lightbox-open");
}

function closeProductImageLightbox() {
    const lightbox = document.getElementById("productImageLightbox");
    if (!lightbox) return;

    lightbox.classList.remove("active");
    lightbox.setAttribute("aria-hidden", "true");
    document.body.classList.remove("product-lightbox-open");
}

function navigateProductLightbox(direction) {
    if (!selectedProduct || !selectedProduct.images?.length) return;

    const total = selectedProduct.images.length;
    currentGalleryIndex = (currentGalleryIndex + direction + total) % total;
    updateProductLightbox();
    setGalleryImage(currentGalleryIndex);
}

function handleProductLightboxKeydown(event) {
    const lightbox = document.getElementById("productImageLightbox");
    if (!lightbox?.classList.contains("active")) return;

    if (event.key === "Escape") {
        closeProductImageLightbox();
    } else if (event.key === "ArrowLeft") {
        navigateProductLightbox(-1);
    } else if (event.key === "ArrowRight") {
        navigateProductLightbox(1);
    }
}

document.addEventListener("keydown", handleProductLightboxKeydown);

function setupProductLightboxSwipe() {
    const lightbox = document.getElementById("productImageLightbox");
    if (!lightbox || lightbox.dataset.swipeReady === "true") return;

    let startX = 0;
    let startY = 0;

    lightbox.addEventListener("touchstart", (event) => {
        const touch = event.changedTouches[0];
        startX = touch.clientX;
        startY = touch.clientY;
    }, { passive: true });

    lightbox.addEventListener("touchend", (event) => {
        const touch = event.changedTouches[0];
        const deltaX = touch.clientX - startX;
        const deltaY = touch.clientY - startY;

        if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY)) {
            navigateProductLightbox(deltaX < 0 ? 1 : -1);
        }
    }, { passive: true });

    lightbox.addEventListener("click", (event) => {
        if (event.target === lightbox) {
            closeProductImageLightbox();
        }
    });

    lightbox.dataset.swipeReady = "true";
}

setupProductLightboxSwipe();


/* =====================================================
   FECHAR MODAL
===================================================== */

function closeProductModal() {

    document
        .getElementById("productModal")
        .classList.remove("active");


    document.body.style.overflow = "";

}


/* =====================================================
   QUANTIDADE
===================================================== */

function changeQuantity(amount) {

    const maxStock = selectedVariant ? Number(selectedVariant.stock || 0) : Number(selectedProduct?.stock || 0);
    selectedQuantity += amount;

    if (selectedQuantity > maxStock) selectedQuantity = maxStock;
    if (selectedQuantity < 1) {

        selectedQuantity = 1;

    }


    document.getElementById("quantity")
        .textContent = selectedQuantity;

}


/* =====================================================
   ADICIONAR AO CARRINHO
===================================================== */

// Coloca o produto escolhido na sacola. Em "Comprar agora" (buyNow) o item que já
// estava na sacola não é somado de novo: fica com a quantidade escolhida, se for maior.
function addSelectedProductToCart(buyNow = false) {

    if (!selectedProduct) return false;

    const available = selectedVariant ? Number(selectedVariant.stock || 0) : Number(selectedProduct.stock || 0);
    if (available <= 0 || selectedQuantity > available) {
        showToast("Quantidade indisponível para este produto.");
        return false;
    }

    // Produtos com uma única variação ativa já ficam automaticamente
    // associados a essa variação. A cliente não precisa selecionar nada.
    if (!selectedVariant) {
        const onlyVariant = (selectedProduct.variants || [])
            .filter(v => v.active !== false && Number(v.stock || 0) > 0);
        if (onlyVariant.length === 1) {
            selectedVariant = onlyVariant[0];
        }
    }

    const variantKey = selectedVariant?.id || "default";
    const existing =
        cart.find(
            item =>
                item.id === selectedProduct.id && (item.variant_id || "default") === variantKey
        );


    if (existing) {

        const maxStock = selectedVariant ? Number(selectedVariant.stock || 0) : Number(selectedProduct.stock || 0);
        existing.quantity = buyNow
            ? Math.min(Math.max(existing.quantity, selectedQuantity), maxStock)
            : Math.min(existing.quantity + selectedQuantity, maxStock);

    } else {

        cart.push({

            ...selectedProduct,
            variant_id: selectedVariant?.id || null,
            variant_color: selectedVariant?.color || null,
            variant_sku: selectedVariant?.sku || selectedProduct.sku || null,
            quantity: selectedQuantity

        });

    }


    updateCart();

    window.monteAnalytics?.track("add_to_cart", {
        product_id: selectedProduct.id,
        product_name: selectedProduct.name,
        variant_id: selectedVariant?.id || null,
        quantity: selectedQuantity,
        value: Number(selectedProduct.price || 0) * selectedQuantity
    });

    return true;

}


document.getElementById(
    "addProductButton"
).addEventListener(
    "click",
    () => {

        if (!addSelectedProductToCart()) return;

        // A cliente continua no produto que está vendo: só aparece o aviso.
        showToast(
            "Produto adicionado ao carrinho."
        );

    }
);


/* =====================================================
   COMPRAR AGORA
   Põe o produto na sacola, abre a sacola já na etapa
   "Seus dados" e deixa o cursor no primeiro campo vazio.
===================================================== */

document.getElementById("buyNowButton")?.addEventListener("click", () => {

    if (!addSelectedProductToCart(true)) return;

    closeProductModal();
    openCart();

    setTimeout(() => {
        const panel = document.querySelector("#cartOverlay .cart");
        const target = document.getElementById("stepData");
        if (!panel || !target) return;
        const header = panel.querySelector(".cart-header");
        const top = target.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - (header?.offsetHeight || 0) - 12;
        panel.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        const firstEmpty = [...target.querySelectorAll("input")].find(input => !input.value.trim());
        firstEmpty?.focus({ preventScroll: true });
    }, 350);

});


/* =====================================================
   ATUALIZAR CARRINHO
===================================================== */

function updateCart() {

    const container =
        document.getElementById(
            "cartItems"
        );


    const count =
        document.getElementById(
            "cartCount"
        );


    const total =
        document.getElementById(
            "cartTotal"
        );


    container.replaceChildren();

    const cartPanel = document.querySelector("#cartOverlay .cart");
    if (cartPanel) cartPanel.classList.toggle("is-empty", cart.length === 0);

    if (cart.length === 0) {

        setHTML(container, `
            <div class="empty-cart">
                <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M10 16h28l-2.4 24H12.4z"/><path d="M17 16v-3a7 7 0 0 1 14 0v3"/></svg>
                <p class="empty-cart-title">Sua sacola está vazia</p>
                <p class="empty-cart-text">Que tal começar pelas novidades da coleção?</p>
                <button type="button" class="empty-cart-button" data-click="browseNovidades">VER NOVIDADES</button>
            </div>
        `);

    }


    let cartTotal = 0;

    let cartQuantity = 0;


    cart.forEach((item, index) => {

        cartTotal +=
            item.price * item.quantity;


        cartQuantity +=
            item.quantity;


        const element =
            document.createElement(
                "div"
            );


        element.className =
            "cart-item";

        element.style.setProperty("--i", index);

        setHTML(element, `

            <div class="cart-item-media">
                <img
                    src="${escapeHTML(smallImage(Array.isArray(item.images) ? item.images[0] || "" : ""))}"
                    alt="${escapeHTML(item.name)}"
                >
            </div>

            <div class="cart-item-body">

                <div class="cart-item-name">
                    ${escapeHTML(item.name)}
                </div>

                ${item.variant_color ? `<div class="cart-item-variant">${escapeHTML(colorLabel(item.variant_color, item.name))}</div>` : ""}
                ${item.presale ? '<div class="cart-item-presale">Pré-venda · entrega em 10 dias úteis</div>' : ""}

                <div class="cart-item-row">

                    <div class="cart-quantity" aria-label="Quantidade">
                        <button type="button" aria-label="Diminuir quantidade" data-click="updateItemQuantity" data-args="[${index}, -1]">−</button>
                        <span>${item.quantity}</span>
                        <button type="button" aria-label="Aumentar quantidade" data-click="updateItemQuantity" data-args="[${index}, 1]">+</button>
                    </div>

                    <div class="cart-item-price">
                        ${formatPrice(item.price * item.quantity)}
                        ${item.quantity > 1 ? `<small>${formatPrice(item.price)} cada</small>` : ""}
                    </div>

                </div>

            </div>

            <button
                type="button"
                class="cart-item-remove"
                aria-label="Remover ${escapeHTML(item.name)}"
                data-click="removeFromCart" data-args="[${index}]">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>
            </button>

        `);


        container.appendChild(element);

    });

    const headerCount = document.getElementById("cartHeaderCount");
    if (headerCount) headerCount.textContent = cartQuantity;


    count.textContent =
        cartQuantity;


    total.textContent =
        formatPrice(cartTotal);


    // Navegador com dados de site bloqueados (Safari com "Bloquear todos os cookies", por
    // exemplo): o localStorage dá erro. A sacola continua funcionando, só não fica salva.
    try {
        localStorage.setItem(
            "monteCart",
            JSON.stringify(cart)
        );
    } catch {}

    updateShipping();

}


/* =====================================================
   QUANTIDADE DO CARRINHO
===================================================== */

function updateItemQuantity(index, amount) {

    const item = cart[index];

    if (!item) return;

    const maxStock = item.variant_id
        ? Number(
            products
                .find(p => p.id === item.id)
                ?.variants
                ?.find(v => v.id === item.variant_id)
                ?.stock || 0
        )
        : Number(
            products.find(p => p.id === item.id)?.stock || 0
        );

    item.quantity += amount;

    if (item.quantity > maxStock) {
        item.quantity = maxStock;
    }

    if (item.quantity <= 0) {
        cart.splice(index, 1);
    }

    updateCart();
}


/* =====================================================
   REMOVER
===================================================== */

function removeFromCart(index) {

    if (index >= 0 && index < cart.length) {
        cart.splice(index, 1);
    }

    updateCart();
}


/* =====================================================
   ABRIR CARRINHO


===================================================== */

// No celular o Safari ignora o overflow:hidden do body e a página de fundo rolava junto
// com o checkout. Enquanto a sacola está aberta, a página fica presa no lugar (fixed)
// e, ao fechar, volta exatamente para onde a cliente estava.
let lockedPageScrollY = null;

function lockPageScroll() {
    if (lockedPageScrollY !== null) return;
    if (!window.matchMedia("(pointer: coarse), (max-width: 900px)").matches) return;
    lockedPageScrollY = window.scrollY;
    document.body.style.top = -lockedPageScrollY + "px";
    document.body.classList.add("page-locked");
}

function unlockPageScroll() {
    if (lockedPageScrollY === null) return;
    const y = lockedPageScrollY;
    lockedPageScrollY = null;
    document.body.classList.remove("page-locked");
    document.body.style.top = "";
    window.scrollTo({ top: y, behavior: "instant" });
}


function openCart() {

    document
        .getElementById("cartOverlay")
        .classList.add("active");

    document.body.classList.add("cart-open");

    lockPageScroll();

}


function closeCart() {

    document
        .getElementById("cartOverlay")
        .classList.remove("active");

    document.body.classList.remove("cart-open");

    unlockPageScroll();

    setPaymentHelp(false);

}


function closeCartOutside(event) {

    if (
        event.target.id ===
        "cartOverlay"
    ) {

        closeCart();

    }

}

/* =====================================================
   FRETE
===================================================== */

const metropolitanCities = [
    "AQUIRAZ",
    "CAUCAIA",
    "EUSEBIO",
    "GUAIUBA",
    "ITAITINGA",
    "MARACANAU",
];


function normalizeCity(city) {

    return city
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toUpperCase();

}


// Pré-venda: bolsas que ainda vão chegar; a entrega é em 10 dias úteis.
const PRESALE_MIN_BUSINESS_DAYS = 10;
function cartHasPresale() {
    return cart.some(item => item.presale);
}

function getCartSubtotal() {
    return cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
}

// Frete grátis só na entrega MONTÊ (Fortaleza e região metropolitana), a partir de um valor
// em peças (preço de tabela, antes do Pix e do cupom; o frete não conta), e o desconto do
// Pix nas peças. Os dois são editados no painel (aba Promoções) e chegam por /api/promocoes
// (applyStoreBenefits); estes são os valores até a resposta chegar. O servidor aplica as
// mesmas regras e é ele que define o valor cobrado.
let FREE_SHIPPING_ENABLED = true;
let FREE_SHIPPING_MIN = 599;
let PIX_DISCOUNT_PERCENT = 5;
const FREE_SHIPPING_OPTION_IDS = ["monte-fortaleza", "monte-regiao-metropolitana"];

// Desconto do Pix em uma unidade, em centavos (mesma conta do servidor).
function pixUnitDiscountCents(unitCents) {
    return PIX_DISCOUNT_PERCENT > 0 ? unitCents - Math.round(unitCents * (100 - PIX_DISCOUNT_PERCENT) / 100) : 0;
}

function shippingPriceFor(option, subtotal = getCartSubtotal()) {
    if (!option) return 0;
    const price = Number(option.price || 0);
    return FREE_SHIPPING_ENABLED && FREE_SHIPPING_OPTION_IDS.includes(option.id) && subtotal >= FREE_SHIPPING_MIN ? 0 : price;
}

const shortPrice = value => formatPrice(value).replace(",00", "");
const percentText = value => String(value).replace(".", ",") + "%";

// Textos da loja com o frete grátis e o desconto do Pix do painel. Benefício desligado some.
function applyStoreBenefits(benefits) {
    const shipping = benefits?.free_shipping;
    const pix = benefits?.pix_discount;
    if (shipping) {
        FREE_SHIPPING_ENABLED = shipping.enabled !== false;
        FREE_SHIPPING_MIN = Number(shipping.min_subtotal) || FREE_SHIPPING_MIN;
    }
    if (pix) PIX_DISCOUNT_PERCENT = pix.enabled === false ? 0 : Number(pix.percent) || 0;
    const pixOn = PIX_DISCOUNT_PERCENT > 0;
    const setText = (name, text) => document.querySelectorAll(`[data-benefit="${name}"]`).forEach(el => { el.textContent = text; });
    const show = (name, visible) => document.querySelectorAll(`[data-benefit-show="${name}"]`).forEach(el => { el.hidden = !visible; });
    setText("shipping-bar", `FRETE GRÁTIS EM FORTALEZA E REGIÃO A PARTIR DE ${shortPrice(FREE_SHIPPING_MIN)}`);
    setText("shipping-benefit", FREE_SHIPPING_ENABLED ? `Frete grátis em Fortaleza e região acima de ${shortPrice(FREE_SHIPPING_MIN)}.` : "Envio com rastreio.");
    setText("pix-bar", `${percentText(PIX_DISCOUNT_PERCENT)} OFF NO PIX`);
    setText("pix-badge", `${percentText(PIX_DISCOUNT_PERCENT)} OFF`);
    setText("pix-trust", `Pix com ${percentText(PIX_DISCOUNT_PERCENT)} OFF`);
    setText("payment-hint", [
        pixOn ? "O desconto do Pix vale para as peças." : "",
        FREE_SHIPPING_ENABLED ? `Frete grátis em Fortaleza e região a partir de ${shortPrice(FREE_SHIPPING_MIN)}.` : ""
    ].filter(Boolean).join(" "));
    show("shipping", FREE_SHIPPING_ENABLED);
    show("pix", pixOn);
    show("shipping-and-pix", FREE_SHIPPING_ENABLED && pixOn);
    show("payment-hint", FREE_SHIPPING_ENABLED || pixOn);
}

function shippingPriceLabel(option) {
    const charge = shippingPriceFor(option);
    return charge === 0 && Number(option?.price || 0) > 0 ? "Grátis" : formatPrice(charge);
}

// Cada peça continua custando pelo menos R$ 1,00 (mesma regra do servidor).
const COUPON_MIN_UNIT_CENTS = 100;

// Totais do checkout. Mesmo cálculo do servidor: desconto do Pix por unidade, arredondado em
// centavos; o cupom vale nas peças (depois do Pix) e o frete fica integral.
function checkoutTotals(subtotal = getCartSubtotal()) {
    const shipping = getShippingValue();
    const paymentMethod =
        document.querySelector('input[name="paymentMethod"]:checked')?.value ||
        selectedPaymentMethod ||
        "pix";
    const unitCents = item => Math.round(Number(item.price || 0) * 100);
    const pixDiscountCents = paymentMethod === "pix"
        ? cart.reduce((sum, item) => sum + pixUnitDiscountCents(unitCents(item)) * Number(item.quantity || 0), 0)
        : 0;
    const productCents = cart.reduce((sum, item) => sum + unitCents(item) * Number(item.quantity || 0), 0) - pixDiscountCents;
    const units = cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    let couponCents = 0;
    if (appliedCoupon && productCents > 0) {
        const value = Number(appliedCoupon.discount_value) || 0;
        const raw = appliedCoupon.discount_type === "percent"
            ? Math.round(productCents * Math.min(value, 100) / 100)
            : Math.round(value * 100);
        couponCents = Math.max(0, Math.min(raw, productCents - units * COUPON_MIN_UNIT_CENTS));
    }
    const pixDiscount = pixDiscountCents / 100;
    const couponDiscount = couponCents / 100;
    return {
        subtotal,
        shipping,
        pixDiscount,
        couponDiscount,
        total: Number((subtotal - pixDiscount - couponDiscount + shipping).toFixed(2)),
        paymentMethod
    };
}

function updatePaymentSummary(subtotal = getCartSubtotal()) {
    const totals = checkoutTotals(subtotal);
    const { shipping, pixDiscount, couponDiscount, paymentMethod } = totals;
    const checkoutTotal = totals.total;

    selectedPaymentMethod = paymentMethod;

    const checkoutElement = document.getElementById("checkoutTotal");
    if (checkoutElement) checkoutElement.textContent = formatPrice(checkoutTotal);

    const discountElement = document.getElementById("checkoutDiscount");
    if (discountElement) {
        discountElement.textContent = pixDiscount > 0
            ? `Desconto Pix: -${formatPrice(pixDiscount)}`
            : "";
        discountElement.style.display = pixDiscount > 0 ? "block" : "none";
    }

    // O frete pode virar grátis (ou deixar de ser) quando a sacola muda.
    const shippingValueElement = document.getElementById("shippingValue");
    if (shippingValueElement && selectedShippingOption) {
        const label = shippingPriceLabel(selectedShippingOption);
        if (shippingValueElement.textContent !== label) shippingValueElement.textContent = label;
    }
    document.querySelectorAll("#shippingOptions .shipping-option").forEach(el => {
        const option = shippingOptions.find(o => String(o.id) === el.dataset.optionId);
        const priceEl = el.querySelector(".shipping-option-price");
        if (!option || !priceEl) return;
        const free = shippingPriceFor(option) === 0 && Number(option.price || 0) > 0;
        el.classList.toggle("is-free", free);
        setHTML(priceEl, free ? `<s>${formatPrice(option.price)}</s> Grátis` : formatPrice(option.price));
    });

    document.querySelectorAll(".payment-option").forEach(option => {
        const input = option.querySelector('input[name="paymentMethod"]');
        option.classList.toggle("selected", !!input?.checked);
    });

    renderCouponStatus(couponDiscount);
    renderCheckoutNote(totals);
    renderCheckoutExtras({ subtotal, shipping, pixDiscount, couponDiscount, paymentMethod });
}

function couponLabel(coupon) {
    const value = Number(coupon?.discount_value || 0);
    return coupon?.discount_type === "percent"
        ? value.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + "% OFF nas peças"
        : formatPrice(value) + " OFF nas peças";
}

function renderCouponStatus(couponDiscount = checkoutTotals().couponDiscount, message = "", isError = false) {
    const input = document.getElementById("couponCode");
    const button = document.getElementById("couponApply");
    const status = document.getElementById("couponStatus");
    if (!input || !button || !status) return;
    input.readOnly = !!appliedCoupon;
    input.closest(".field")?.classList.toggle("is-valid", !!appliedCoupon);
    input.closest(".field")?.classList.toggle("is-invalid", isError);
    button.textContent = appliedCoupon ? "REMOVER" : "APLICAR";
    button.dataset.click = appliedCoupon ? "removeCoupon" : "applyCoupon";
    status.classList.toggle("is-error", isError);
    if (message) {
        status.textContent = message;
    } else if (appliedCoupon) {
        setHTML(status, `<strong>${escapeHTML(appliedCoupon.code)}</strong> aplicado: ${escapeHTML(couponLabel(appliedCoupon))}` +
            (couponDiscount > 0 ? ` · <strong>-${formatPrice(couponDiscount)}</strong>` : ""));
    } else {
        status.textContent = "";
    }
}

// Confere o cupom no servidor. O desconto mostrado aqui é recalculado no checkout.
async function applyCoupon() {
    const input = document.getElementById("couponCode");
    const button = document.getElementById("couponApply");
    const code = String(input?.value || "").replace(/\s+/g, "").toUpperCase();
    if (!input) return false;
    if (!code) {
        renderCouponStatus(0, "Digite o código do cupom.", true);
        input.focus();
        return false;
    }
    input.value = code;
    if (button) { button.disabled = true; button.textContent = "..."; }
    try {
        const response = await fetch("/api/cupom", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
                code,
                cpf: document.getElementById("customerCpf")?.value || "",
                email: document.getElementById("customerEmail")?.value || ""
            })
        });
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok || !data?.coupon) {
            appliedCoupon = null;
            updatePaymentSummary();
            renderCouponStatus(0, data?.message || "Não foi possível conferir o cupom.", true);
            return false;
        }
        appliedCoupon = data.coupon;
        updatePaymentSummary();
        return true;
    } catch {
        renderCouponStatus(0, "Sem conexão. Confira sua internet e tente novamente.", true);
        return false;
    } finally {
        if (button) button.disabled = false;
        if (!appliedCoupon && button) button.textContent = "APLICAR";
    }
}

/* =====================================================
   PRESENTES DAS PROMOÇÕES (cadastradas no painel, aba Promoções)
   Compra com as peças somando o valor mínimo (preço de tabela; o
   frete não conta) ganha uma peça da categoria da promoção, à
   escolha da cliente. Na sacola, uma escada de benefícios mostra o
   que ela já ganhou e o próximo degrau (outra promoção ou o frete
   grátis de Fortaleza e região). Com mais de uma promoção no ar,
   vale o presente do maior degrau alcançado. As peças da cor das
   que estão na sacola aparecem primeiro ("combina com a sua sacola").
   O servidor confere tudo de novo no checkout.
===================================================== */
const GIFT_CATEGORY_WORDS = {
    cintos: { one: "um cinto", mine: "seu cinto" },
    acessorios: { one: "um acessório", mine: "seu acessório" },
    bolsas: { one: "uma bolsa", mine: "sua bolsa" }
};
const giftWords = promotion => GIFT_CATEGORY_WORDS[promotion?.gift_category] || { one: "um presente", mine: "seu presente" };

async function loadStorePromotions() {
    try {
        const response = await fetch("/api/promocoes", { headers: { "Accept": "application/json" } });
        const body = await response.json();
        storePromotions = Array.isArray(body?.promotions) ? body.promotions : [];
        if (body?.benefits) applyStoreBenefits(body.benefits);
    } catch {
        storePromotions = [];
    }
    // A barra do topo anuncia a promoção (no celular, só esse aviso).
    const banner = storePromotions.find(promotion => promotion.banner_text)?.banner_text;
    const barMessage = document.getElementById("shippingBarPromo");
    if (barMessage && banner) {
        barMessage.textContent = banner;
        document.querySelectorAll(".shipping-bar-promo").forEach(el => { el.hidden = false; });
        document.querySelector(".shipping-bar")?.classList.add("has-promo");
    }
    if (cart.length) updatePaymentSummary();
}

function plainColor(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Peças que podem ser o presente: da categoria da promoção, ativas, fora da pré-venda e com
// a cor em estoque (descontando o que já está na sacola).
function giftOptionsFor(promotion) {
    const inCart = new Map();
    cart.forEach(item => {
        if (item.variant_id) inCart.set(String(item.variant_id), (inCart.get(String(item.variant_id)) || 0) + Number(item.quantity || 0));
    });
    const categoryOf = item => products.find(product => String(product.id) === String(item.id || item.product_id))?.category;
    const cartColors = new Set(cart
        .filter(item => categoryOf(item) !== promotion.gift_category)
        .map(item => plainColor(colorLabel(item.variant_color, item.name)).split(/\s+/)[0])
        .filter(Boolean));
    const options = [];
    products
        .filter(product => product.category === promotion.gift_category && !product.presale && product.active !== false)
        .forEach(product => (product.variants || []).forEach(variant => {
            if (variant.active === false) return;
            const available = Number(variant.stock || 0) - (inCart.get(String(variant.id)) || 0);
            if (available < 1) return;
            const color = colorLabel(variant.color, product.name);
            options.push({ product, variant, color, matches: cartColors.has(plainColor(color).split(/\s+/)[0]) });
        }));
    return options.sort((a, b) =>
        (b.matches - a.matches) || (Number(b.product.price) - Number(a.product.price)) || a.product.name.localeCompare(b.product.name));
}

// Degraus das promoções no ar que têm presente em estoque, do menor valor para o maior.
function promotionTiers() {
    const now = Date.now();
    return storePromotions
        .filter(promotion => now < Date.parse(promotion.ends_at))
        .map(promotion => ({ promotion, options: giftOptionsFor(promotion) }))
        .filter(tier => tier.options.length)
        .sort((a, b) => Number(a.promotion.min_subtotal) - Number(b.promotion.min_subtotal));
}

function reachedTier(subtotal = getCartSubtotal(), tiers = promotionTiers()) {
    return [...tiers].reverse().find(tier => subtotal >= Number(tier.promotion.min_subtotal)) || null;
}

function giftEligible(subtotal = getCartSubtotal()) {
    return !!reachedTier(subtotal);
}

// O presente escolhido, se ainda vale (degrau alcançado e cor com estoque).
function currentGift(subtotal = getCartSubtotal()) {
    if (!selectedGift) return null;
    const tier = reachedTier(subtotal);
    if (!tier || String(tier.promotion.id) !== String(selectedGift.promotion_id)) return null;
    const option = tier.options.find(o => String(o.variant.id) === String(selectedGift.variant_id) &&
        String(o.product.id) === String(selectedGift.product_id));
    return option ? { ...option, promotion: tier.promotion } : null;
}

function saveSelectedGift(gift) {
    selectedGift = gift;
    try {
        if (gift) localStorage.setItem(GIFT_STORAGE_KEY, JSON.stringify(gift));
        else localStorage.removeItem(GIFT_STORAGE_KEY);
    } catch {}
}

// Modelo tocado na escolha do presente, esperando a cor: { promotion_id, product_id }.
let giftDraft = null;

function chooseGift(promotionId, productId, variantId) {
    giftDraft = { promotion_id: promotionId, product_id: productId };
    saveSelectedGift({ promotion_id: promotionId, product_id: productId, variant_id: variantId });
    updatePaymentSummary();
}

// Toque no card do modelo: com uma cor só, ela já fica escolhida; com várias, aparecem as cores.
function pickGiftProduct(promotionId, productId) {
    const tier = reachedTier();
    const colors = tier ? tier.options.filter(option => String(option.product.id) === String(productId)) : [];
    if (colors.length === 1) {
        chooseGift(promotionId, productId, colors[0].variant.id);
        return;
    }
    giftDraft = { promotion_id: promotionId, product_id: productId };
    if (selectedGift && String(selectedGift.product_id) !== String(productId)) saveSelectedGift(null);
    updatePaymentSummary();
    document.getElementById("giftColors")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Bolinhas do carrossel de presentes no celular (mostram em que card a cliente está).
function renderGiftDots(count) {
    const dots = document.getElementById("giftDots");
    const box = document.getElementById("giftOptions");
    if (!dots || !box) return;
    dots.hidden = count < 2;
    setHTML(dots, Array.from({ length: count }, (_, i) => `<button type="button" data-index="${i}"></button>`).join(""));
    const update = () => {
        const card = box.querySelector(".gift-card");
        const step = card ? card.getBoundingClientRect().width + 10 : 1;
        const last = box.scrollLeft + box.clientWidth >= box.scrollWidth - 2;
        const index = last ? count - 1 : Math.round(box.scrollLeft / step);
        dots.querySelectorAll("button").forEach((dot, i) => dot.classList.toggle("is-active", i === index));
    };
    if (!box.dataset.dotsReady) {
        box.dataset.dotsReady = "1";
        box.addEventListener("scroll", () => requestAnimationFrame(update), { passive: true });
        dots.addEventListener("click", event => {
            const dot = event.target.closest("button[data-index]");
            const card = dot && box.querySelectorAll(".gift-card")[Number(dot.dataset.index)];
            const first = box.querySelector(".gift-card");
            if (card && first) box.scrollTo({ left: card.offsetLeft - first.offsetLeft, behavior: "smooth" });
        });
    }
    update();
}

// Escada de benefícios + escolha do presente. Devolve true quando está na tela (aí ela já
// mostra o frete grátis e o aviso simples de frete some).
function renderGiftPerk({ subtotal, freeShippingApplies }) {
    const perk = document.getElementById("giftPerk");
    const picker = document.getElementById("giftPicker");
    const optionsBox = document.getElementById("giftOptions");
    const line = document.getElementById("cartGiftLine");
    const tiers = promotionTiers();
    const visible = !!perk && cart.length > 0 && tiers.length > 0;
    if (perk) perk.hidden = !visible;
    if (line) line.hidden = true;
    if (!visible) return false;

    const reached = reachedTier(subtotal, tiers);
    const shippingReached = freeShippingApplies && subtotal >= FREE_SHIPPING_MIN;
    const steps = tiers.map(tier => ({
        value: Number(tier.promotion.min_subtotal),
        label: giftWords(tier.promotion).one.split(" ")[1],
        goal: "ganhar " + giftWords(tier.promotion).one + " de presente"
    }));
    if (freeShippingApplies) steps.push({ value: FREE_SHIPPING_MIN, label: "frete grátis", goal: "frete grátis em Fortaleza e região" });
    steps.sort((a, b) => a.value - b.value);
    // Degraus no mesmo valor viram um só ("cinto + frete grátis").
    for (let i = steps.length - 1; i > 0; i--) {
        if (steps[i].value !== steps[i - 1].value) continue;
        steps[i - 1] = { value: steps[i].value, label: steps[i - 1].label + " + " + steps[i].label, goal: steps[i - 1].goal + " e " + steps[i].goal };
        steps.splice(i, 1);
    }
    const next = steps.find(step => subtotal < step.value);

    const won = [reached ? giftWords(reached.promotion).one + " de presente" : "", shippingReached ? "frete grátis" : ""].filter(Boolean);
    const text = [
        won.length ? `<strong>Você ganhou ${won.join(" e ")}!</strong>` : "",
        next ? `Faltam <strong>${formatPrice(next.value - subtotal)}</strong> para ${next.goal}` : ""
    ].filter(Boolean).join(" ");
    perk.classList.toggle("is-active", !!reached);
    setHTML(document.getElementById("giftPerkText"), text);

    // Degraus espaçados por igual; a barra enche aos poucos dentro de cada etapa.
    const position = index => (index + 1) / steps.length * 100;
    let filled = 0;
    for (let i = 0; i < steps.length; i++) {
        const from = i ? steps[i - 1].value : 0;
        const start = i ? position(i - 1) : 0;
        if (subtotal >= steps[i].value) { filled = position(i); continue; }
        filled = start + (position(i) - start) * Math.max(0, (subtotal - from) / (steps[i].value - from));
        break;
    }
    const fill = document.getElementById("giftLadderFill");
    if (fill) fill.style.width = Math.min(100, filled).toFixed(1) + "%";
    setHTML(document.getElementById("giftLadderSteps"), steps.map((step, index) => {
        const last = index === steps.length - 1;
        return `<span class="gift-ladder-step${last ? " is-last" : ""}${subtotal >= step.value ? " is-done" : ""}" data-left="${last ? "" : position(index).toFixed(1)}"><b></b><small>${escapeHTML(step.label.charAt(0).toUpperCase() + step.label.slice(1))}<br>${escapeHTML(formatPrice(step.value).replace(",00", ""))}</small></span>`;
    }).join(""));
    // O HTML seguro não aceita style: a posição de cada degrau vai por aqui.
    document.querySelectorAll("#giftLadderSteps [data-left]").forEach(el => { if (el.dataset.left) el.style.left = el.dataset.left + "%"; });

    if (picker) picker.hidden = !reached;
    if (!reached || !optionsBox) return true;

    // Presente escolhido que esgotou, saiu da loja ou é de outro degrau: escolhe de novo.
    const chosen = currentGift(subtotal);
    if (selectedGift && !chosen) saveSelectedGift(null);
    const words = giftWords(reached.promotion);
    setHTML(document.getElementById("giftPickerTitle"), escapeHTML("Escolha " + words.mine + " de presente"));
    // Um card por modelo, igual aos da loja; as cores aparecem ao tocar no modelo.
    const groups = [];
    reached.options.forEach(option => {
        let group = groups.find(g => String(g.product.id) === String(option.product.id));
        if (!group) groups.push(group = { product: option.product, options: [], matches: false });
        group.options.push(option);
        group.matches = group.matches || option.matches;
    });
    groups.sort((a, b) => (b.matches - a.matches) || (Number(b.product.price) - Number(a.product.price)) || a.product.name.localeCompare(b.product.name));
    const draftId = chosen ? String(chosen.product.id)
        : giftDraft && String(giftDraft.promotion_id) === String(reached.promotion.id) ? String(giftDraft.product_id) : "";
    const active = groups.find(group => String(group.product.id) === draftId) || null;
    if (!active) giftDraft = null;

    setHTML(document.getElementById("giftPickerHint"), chosen
        ? `Seu presente: <strong>${escapeHTML(chosen.product.name)}</strong> · ${escapeHTML(chosen.color || "Cor única")}`
        : active ? "Agora escolha a cor." : "Toque no modelo que você quer ganhar.");
    const signature = reached.promotion.id + ":" + draftId + ":" + (chosen ? chosen.variant.id : "") + ":" +
        reached.options.map(o => o.variant.id).join("|");
    if (optionsBox.dataset.signature !== signature) {
        optionsBox.dataset.signature = signature;
        setHTML(optionsBox, groups.map(group => {
            const isActive = active === group;
            const image = smallImage(Array.isArray(group.product.images) ? group.product.images[0] || "" : "");
            const colors = group.options.length;
            const colorText = isActive && chosen ? chosen.color || "Cor única" : colors === 1 ? group.options[0].color || "Cor única" : colors + " cores";
            return `<button type="button" class="product-card gift-card${isActive ? " is-active" : ""}${isActive && chosen ? " is-selected" : ""}" aria-pressed="${isActive ? "true" : "false"}"
                data-click="pickGiftProduct" data-args="${escapeHTML(JSON.stringify([reached.promotion.id, group.product.id]))}">
                <span class="product-image">${group.matches ? '<span class="product-badge">COMBINA COM SUA SACOLA</span>' : ""}${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(group.product.name)}" loading="lazy" decoding="async">` : ""}</span>
                <span class="product-info">
                    <span class="product-name">${escapeHTML(group.product.name)}</span>
                    <span class="product-price"><span class="old-price">${formatPrice(group.product.price)}</span><span class="sale-price">GRÁTIS</span></span>
                    <span class="gift-card-colors">${escapeHTML(colorText)}</span>
                </span>
            </button>`;
        }).join(""));
        renderGiftDots(groups.length);
        const colorsBox = document.getElementById("giftColors");
        if (colorsBox) {
            colorsBox.hidden = !(active && active.options.length > 1);
            if (!colorsBox.hidden) {
                setHTML(colorsBox, `<p class="gift-colors-title">Escolha a cor do ${escapeHTML(active.product.name)}</p>
                    <div class="variant-options">${active.options.map(option => {
                        const selected = chosen && String(option.variant.id) === String(chosen.variant.id);
                        return `<button type="button" class="variant-option${selected ? " active" : ""}" aria-pressed="${selected ? "true" : "false"}"
                            data-click="chooseGift" data-args="${escapeHTML(JSON.stringify([reached.promotion.id, active.product.id, option.variant.id]))}">${escapeHTML(option.color || "Cor única")}</button>`;
                    }).join("")}</div>`);
            }
        }
    }

    if (line && chosen) {
        line.hidden = false;
        const image = smallImage(Array.isArray(chosen.product.images) ? chosen.product.images[0] || "" : "");
        setHTML(line, `<div class="cart-item cart-gift-item">
            <div class="cart-item-media">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(chosen.product.name)}">` : ""}</div>
            <div class="cart-item-body">
                <span class="cart-gift-tag">Presente</span>
                <div class="cart-item-name">${escapeHTML(chosen.product.name)}</div>
                <div class="cart-item-variant">${escapeHTML(chosen.color || "Cor única")}</div>
                <div class="cart-item-row"><span class="cart-gift-qty">1 unidade</span><div class="cart-item-price"><s>${formatPrice(chosen.product.price)}</s> Grátis</div></div>
            </div>
        </div>`);
    }
    return true;
}

function removeCoupon(message = "") {
    appliedCoupon = null;
    const input = document.getElementById("couponCode");
    if (input && !message) input.value = "";
    updatePaymentSummary();
    if (message) renderCouponStatus(0, message, true);
}

function setupPaymentMethodSelector() {
    document.querySelectorAll('input[name="paymentMethod"]').forEach(input => {
        input.addEventListener("change", () => {
            selectedPaymentMethod = input.value;
            updatePaymentSummary();
        });
    });
    updatePaymentSummary();
}

function getShippingValue() {
    return shippingPriceFor(selectedShippingOption);
}

function renderShippingOptions() {
    const container = document.getElementById("shippingOptions");
    if (!container) return;
    container.replaceChildren();
    shippingOptions.forEach(option => {
        const label = document.createElement("label");
        label.className = "shipping-option" + (selectedShippingOption?.id === option.id ? " selected" : "");
        label.dataset.optionId = String(option.id);
        const min = Number(option.delivery_min_days || 0);
        const max = Number(option.delivery_max_days || 0);
        const carrierDays = min && max && min !== max ? `${min} a ${max} dias úteis` : (max || option.delivery_days) ? `${max || option.delivery_days} dias úteis` : "Prazo informado";
        // Bolsa em pré-venda: ela ainda vai chegar, então a entrega é em 10 dias úteis
        // (ou no prazo da transportadora, se for maior).
        const days = cartHasPresale() ? `Pré-venda: entrega em ${Math.max(PRESALE_MIN_BUSINESS_DAYS, max || Number(option.delivery_days) || 0)} dias úteis` : carrierDays;
        setHTML(label, `<input type="radio" name="shippingMethod" value="${escapeHTML(String(option.id))}" ${selectedShippingOption?.id === option.id ? "checked" : ""}><span class="shipping-option-info"><strong>${escapeHTML(option.name)}</strong><small>${escapeHTML(days)}</small></span><strong class="shipping-option-price">${formatPrice(option.price)}</strong>`);
        label.addEventListener("click", () => {
            selectedShippingOption = option;
            document.querySelectorAll(".shipping-option").forEach(el => el.classList.remove("selected"));
            label.classList.add("selected");
            updatePaymentSummary();
        });
        container.appendChild(label);
    });
}

async function updateShipping() {
    document.getElementById("presaleDeliveryNotice")?.toggleAttribute("hidden", !cartHasPresale());
    const shippingValueElement = document.getElementById("shippingValue");
    const optionsContainer = document.getElementById("shippingOptions");
    if (!shippingValueElement) return;
    const cep = document.getElementById("customerCep")?.value.replace(/\D/g, "") || "";
    const city = normalizeCity(document.getElementById("customerCity")?.value || "");
    const state = (document.getElementById("customerState")?.value || "").trim().toUpperCase();
    const requestId = ++shippingRequestId;
    shippingOptions = [];
    selectedShippingOption = null;
    renderShippingOptions();
    updatePaymentSummary();
    if (cep.length !== 8) { shippingValueElement.textContent = "Informe seu CEP"; return; }
    const localCity = state === "CE" && ["FORTALEZA", ...metropolitanCities].includes(city);
    if (localCity) {
        const local = city === "FORTALEZA" ? {id:"monte-fortaleza",name:"Entrega MONTÊ — Fortaleza",price:15,delivery_days:1} : {id:"monte-regiao-metropolitana",name:"Entrega MONTÊ — Região Metropolitana",price:20,delivery_days:3};
        shippingOptions = [local]; selectedShippingOption = local;
        shippingValueElement.textContent = shippingPriceLabel(local);
        renderShippingOptions(); updatePaymentSummary(); return;
    }
    shippingValueElement.textContent = "Calculando...";
    if (optionsContainer) setHTML(optionsContainer, '<div class="shipping-loading">Consultando opções de entrega...</div>');
    try {
        const response = await fetch("/api/frete/cotacao",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({to_cep:cep,city,state,items:cart.map(item=>({id:item.id,quantity:item.quantity}))})});
        const data = await response.json().catch(() => ({}));
        if (requestId !== shippingRequestId) return;
        if (!response.ok || !data.success || !Array.isArray(data.options) || !data.options.length) throw new Error(data.message || "Nenhuma opção de frete disponível.");
        shippingOptions = data.options; selectedShippingOption = shippingOptions[0];
        shippingValueElement.textContent = shippingPriceLabel(selectedShippingOption);
        renderShippingOptions(); updatePaymentSummary();
    } catch(error) {
        if (requestId !== shippingRequestId) return;
        shippingValueElement.textContent = "Não disponível";
        if (optionsContainer) setHTML(optionsContainer, `<div class="shipping-error">${escapeHTML(error.message || "Não foi possível calcular o frete.")}</div>`);
        updatePaymentSummary();
    }
}

/* =====================================================
   BUSCA DE ENDEREÇO PELO CEP
   Preenche automaticamente rua, bairro, cidade e estado.
===================================================== */

let cepLookupController = null;

async function lookupAddressByCep() {
    const cepInput = document.getElementById("customerCep");
    const streetInput = document.getElementById("customerStreet");
    const neighborhoodInput = document.getElementById("customerNeighborhood");
    const cityInput = document.getElementById("customerCity");
    const stateInput = document.getElementById("customerState");

    if (!cepInput || !streetInput || !neighborhoodInput || !cityInput || !stateInput) {
        return;
    }

    const cep = cepInput.value.replace(/\D/g, "");

    if (cep.length !== 8) {
        return;
    }

    if (cepLookupController) {
        cepLookupController.abort();
    }

    cepLookupController = new AbortController();

    streetInput.value = "Consultando...";
    neighborhoodInput.value = "Consultando...";
    cityInput.value = "Consultando...";
    stateInput.value = "...";

    try {
        const response = await fetch(
            `https://viacep.com.br/ws/${cep}/json/`,
            {
                signal: cepLookupController.signal,
                headers: {
                    "Accept": "application/json"
                }
            }
        );

        if (!response.ok) {
            throw new Error("Falha na consulta do CEP.");
        }

        const data = await response.json();

        if (data.erro) {
            throw new Error("CEP não encontrado.");
        }

        streetInput.value = data.logradouro || "";
        neighborhoodInput.value = data.bairro || "";
        cityInput.value = data.localidade || "";
        stateInput.value = (data.uf || "").toUpperCase();

        updateShipping();

        // O número da residência continua sendo informado pela cliente.
        document.getElementById("customerNumber")?.focus();

    } catch (error) {
        if (error.name === "AbortError") {
            return;
        }

        streetInput.value = "";
        neighborhoodInput.value = "";
        cityInput.value = "";
        stateInput.value = "";

        showToast("Não encontramos esse CEP. Confira o número informado.");
        updateShipping();

    } finally {
        cepLookupController = null;
    }
}


/* =====================================================
   CHECKOUT — INFINITEPAY
===================================================== */

// Quando o pagamento não abre, aparece um balão preto que abre o WhatsApp da loja ao tocar, com
// as peças da sacola já escritas na mensagem. Fica até a cliente tocar, tentar de novo ou fechar a sacola.
function setPaymentHelp(visible, paymentMethod) {
    const balloon = document.getElementById("paymentHelp");
    if (!balloon) return;
    if (!visible) {
        balloon.classList.remove("show");
        balloon.hidden = true;
        return;
    }
    const items = cart.map(item => Number(item.quantity || 1) + "x " + item.name +
        (item.variant_color ? " (" + colorLabel(item.variant_color, item.name) + ")" : "")).join(", ");
    const message = "Olá, MONTÊ! Tentei finalizar minha compra no site, mas o pagamento não abriu. " +
        "Peças: " + items + ". Pagamento: " + (paymentMethod === "pix" ? "Pix" : "cartão") + ".";
    balloon.href = "https://wa.me/5585992163305?text=" + encodeURIComponent(message);
    balloon.hidden = false;
    requestAnimationFrame(() => balloon.classList.add("show"));
}

async function checkout() {
    if (!Array.isArray(cart) || cart.length === 0) { showToast("Seu carrinho está vazio."); return; }
    setPaymentHelp(false);
    const name=document.getElementById("customerName")?.value.trim();
    const email=document.getElementById("customerEmail")?.value.trim();
    const phone=document.getElementById("customerPhone")?.value.trim();
    const cpf=document.getElementById("customerCpf")?.value.trim();
    const cep=document.getElementById("customerCep")?.value.trim();
    const street=document.getElementById("customerStreet")?.value.trim();
    const number=document.getElementById("customerNumber")?.value.trim();
    const complement=document.getElementById("customerComplement")?.value.trim();
    const neighborhood=document.getElementById("customerNeighborhood")?.value.trim();
    const city=document.getElementById("customerCity")?.value.trim();
    const state=document.getElementById("customerState")?.value.trim().toUpperCase();

    if(!name||!email||!phone||!cpf||!cep||!street||!number||!neighborhood||!city||!state){
        flagCheckoutFields(); showToast("Preencha todos os dados do cliente e da entrega."); return;
    }
    const cpfDigits=cpf.replace(/\D/g,"");
    const whatsappNumber=phoneDigits(phone);
    // A InfinitePay não abre o pagamento com telefone incompleto.
    if(!CHECKOUT_RULES.customerPhone(phone)){flagCheckoutFields(["customerPhone"]);showToast("Informe seu WhatsApp com DDD e 9 dígitos. Ex.: (85) 99999-9999.");return;}
    if(cpfDigits.length!==11){flagCheckoutFields(["customerCpf"]);showToast("Informe um CPF válido com 11 dígitos.");return;}

    const items=cart.map(item=>{
        const price=Number(item.price), quantity=Number(item.quantity)||1;
        if(!Number.isFinite(price)||price<=0)return null;
        return {quantity,price,description:String(item.name||"Produto MONTÊ"),
            sku:item.variant_sku||item.sku?String(item.variant_sku||item.sku):null,
            id:item.id||item.product_id||null,product_id:item.id||item.product_id||null,
            variant_id:item.variant_id||null,variant_color:item.variant_color||null};
    }).filter(Boolean);

    if(!selectedShippingOption){document.querySelector(".shipping-result")?.scrollIntoView({behavior:"smooth",block:"center"});showToast("Selecione uma opção de frete antes de finalizar a compra.");return;}
    const shippingServiceId=String(selectedShippingOption.id||"");
    if(!items.length){showToast("Não foi possível identificar os produtos do carrinho.");return;}

    const paymentMethod=document.querySelector('input[name="paymentMethod"]:checked')?.value||selectedPaymentMethod||"pix";
    if(!["pix","credit_card"].includes(paymentMethod)){showToast("Selecione uma forma de pagamento válida.");return;}

    // Promoção de presente: com a sacola no valor mínimo, a cliente escolhe o presente antes.
    const gift=currentGift();
    if(!gift&&giftEligible()){
        document.getElementById(giftDraft?"giftColors":"giftPicker")?.scrollIntoView({behavior:"smooth",block:"center"});
        showToast(giftDraft?"Escolha a cor do seu presente para finalizar.":"Escolha o seu presente para finalizar.");
        return;
    }

    // Cupom digitado sem tocar em APLICAR: confere antes de seguir.
    const typedCoupon=String(document.getElementById("couponCode")?.value||"").trim();
    if(typedCoupon&&!appliedCoupon){
        if(!(await applyCoupon())){document.getElementById("couponBox")?.scrollIntoView({behavior:"smooth",block:"center"});return;}
    }

    const checkoutButton=document.querySelector(".checkout-button");
    if(checkoutButton){checkoutButton.disabled=true;checkoutButton.textContent="PREPARANDO PAGAMENTO...";}
    showToast("Preparando seu pagamento...");
    window.monteAnalytics?.track("begin_checkout",{value:getCartSubtotal(),metadata:{payment_method:paymentMethod,coupon:appliedCoupon?.code||null}});
    window.monteAnalytics?.saveCart();

    try{
        const response=await fetch("/api/criar-checkout",{
            method:"POST",
            headers:{"Content-Type":"application/json","Accept":"application/json"},
            body:JSON.stringify({items,shipping_service_id:shippingServiceId,payment_method:paymentMethod,
                coupon_code:appliedCoupon?.code||undefined,
                gift:gift?{promotion_id:gift.promotion.id,product_id:gift.product.id,variant_id:gift.variant.id}:undefined,
                customer:{name,email,phone,whatsapp_phone:whatsappNumber,whatsapp_updates:true,cpf:cpfDigits,
                    address:{cep,street,number,complement:complement||"",neighborhood,city,state}}})
        });
        const responseText=await response.text();
        let data=null;
        try{data=JSON.parse(responseText);}catch{console.error("Resposta não é JSON:",responseText);}
        if(!response.ok){
            if(data?.stock_changed&&typeof loadProductsFromDatabase==="function")loadProductsFromDatabase().catch(()=>{});
            // Presente esgotado ou promoção encerrada: confere de novo e escolhe outro.
            if(data?.gift_invalid){
                saveSelectedGift(null);
                await Promise.all([loadProductsFromDatabase().catch(()=>{}),loadStorePromotions()]);
                updatePaymentSummary();
                document.getElementById("giftPerk")?.scrollIntoView({behavior:"smooth",block:"center"});
                throw new Error(data.message||"Escolha o cinto de presente de novo.");
            }
            // Cupom recusado no checkout: sai do pedido e a cliente confere o novo total.
            if(data?.coupon_invalid){
                removeCoupon(data.message||"Cupom inválido.");
                document.getElementById("couponBox")?.scrollIntoView({behavior:"smooth",block:"center"});
                throw new Error((data.message||"Cupom inválido.")+" O cupom foi removido: confira o total e finalize de novo.");
            }
            const failure=new Error(data?.message||"O pagamento não abriu. Tente novamente.");
            failure.paymentUnavailable=data?.payment_unavailable===true||response.status>=500;
            throw failure;
        }

        if(paymentMethod==="pix"&&data?.pix_checkout&&data?.url){
            closeCart();
            let pixCheckoutUrl;
            try{
                pixCheckoutUrl=new URL(data.url);
            }catch{
                const failure=new Error("O pagamento não abriu. Tente novamente.");
                failure.paymentUnavailable=true;
                throw failure;
            }
            try{
                window.top.location.replace(pixCheckoutUrl.href);
            }catch(navigationError){
                window.location.replace(pixCheckoutUrl.href);
            }
            return;
        }

        const checkoutUrl=data?.url||data?.checkoutUrl||data?.paymentUrl||data?.redirectUrl;
        let validUrl=null;
        try{validUrl=new URL(checkoutUrl);}catch{}
        if(!validUrl){const failure=new Error("O pagamento não abriu. Tente novamente.");failure.paymentUnavailable=true;throw failure;}

        closeCart();
        // Navega diretamente para o checkout da InfinitePay em qualquer dispositivo.
        // Mantém fallback para Safari/iOS e navegadores embutidos.
        try{
            window.top.location.replace(validUrl.href);
        }catch(navigationError){
            window.location.replace(validUrl.href);
        }
        setTimeout(()=>{
            if(document.visibilityState==="visible"){
                const paymentLink=document.createElement("a");
                paymentLink.href=validUrl.href;
                paymentLink.target="_self";
                paymentLink.rel="noopener";
                paymentLink.style.display="none";
                document.body.appendChild(paymentLink);
                paymentLink.click();
                paymentLink.remove();
            }
        },1200);
    }catch(error){
        console.error("ERRO COMPLETO NO CHECKOUT:",error);
        // Pagamento que não abriu: só o balão para chamar no WhatsApp.
        // Sem internet o navegador dá "Failed to fetch" / "Load failed": a cliente vê a explicação.
        if(error.paymentUnavailable){hideToast();setPaymentHelp(true,paymentMethod);}
        else showToast(error instanceof TypeError?"Sem conexão. Confira sua internet e tente novamente.":(error.message||"Não foi possível concluir. Tente novamente."));
        if(checkoutButton){checkoutButton.disabled=false;checkoutButton.textContent="FINALIZAR COMPRA";}
    }
}

// Ao voltar do checkout pelo botão "voltar", a página pode ser restaurada do
// cache com o botão ainda desabilitado.
window.addEventListener("pageshow",event=>{
    if(!event.persisted)return;
    const checkoutButton=document.querySelector(".checkout-button");
    if(checkoutButton){checkoutButton.disabled=false;checkoutButton.textContent="FINALIZAR COMPRA";}
});

/* =====================================================
   CARROSSEL
===================================================== */

let carouselSlides=[];
let carouselAutoTimer=null;

// Banner com largura, altura e srcset: o navegador reserva o espaço antes da foto chegar
// (a página não pula) e o celular baixa a versão menor quando ela existe.
function carouselSlideHtml(slide,i){
  const src=String(slide?.src||slide||"");
  const size=slide?.width&&slide?.height?' width="'+Number(slide.width)+'" height="'+Number(slide.height)+'"':"";
  const srcset=slide?.small?' srcset="'+escapeHTML(slide.small)+' 960w, '+escapeHTML(src)+' 2000w" sizes="100vw"':"";
  return '<div class="slide'+(i===0?' active':'')+'"><img src="'+escapeHTML(src)+'"'+srcset+size+(i===0?' fetchpriority="high"':' loading="lazy"')+' decoding="async" alt="MONTÊ — Novidades"></div>';
}

async function loadHomepageCarousel(){
  const container=document.getElementById("carouselSlides");
  if(!container)return;
  // O servidor já mandou os banners dentro da página: só liga os pontos e a troca automática.
  if(container.dataset.ssr!=="1"){
    try{
      const response=await fetch("/api/carousel",{cache:"no-store"});
      const data=await response.json();
      const slides=Array.isArray(data?.slides)&&data.slides.length
        ?data.slides
        :(Array.isArray(data?.images)?data.images.filter(Boolean).map(src=>({src})):[]);
      if(slides.length)setHTML(container,slides.map(carouselSlideHtml).join(""));
    }catch{
      // Sem resposta: ficam os banners padrão que já estão na página.
    }
  }
  setupCarousel(container);
}

function setupCarousel(container){
  carouselSlides=[...container.querySelectorAll(".slide")];
  const dots=document.getElementById("carouselDots");
  if(dots){
    dots.replaceChildren();
    carouselSlides.forEach((_,index)=>{
      const dot=document.createElement("button");
      dot.className="carousel-dot"+(index===0?" active":"");
      dot.type="button";dot.setAttribute("aria-label","Mostrar banner "+(index+1));
      dot.addEventListener("click",()=>{currentSlide=index;showSlide(currentSlide)});
      dots.appendChild(dot);
    });
  }
  currentSlide=0;
  if(carouselAutoTimer)clearInterval(carouselAutoTimer);
  if(carouselSlides.length>1)carouselAutoTimer=setInterval(nextSlide,20000);
}
function showSlide(index){
  if(!carouselSlides.length)return;
  currentSlide=(index+carouselSlides.length)%carouselSlides.length;
  carouselSlides.forEach(slide=>slide.classList.remove("active"));
  carouselSlides[currentSlide].classList.add("active");
  document.querySelectorAll("#carouselDots .carousel-dot").forEach(dot=>dot.classList.remove("active"));
  const dot=document.querySelectorAll("#carouselDots .carousel-dot")[currentSlide];
  if(dot)dot.classList.add("active");
}
function nextSlide(){
  if(!carouselSlides.length)return;
  currentSlide=(currentSlide+1)%carouselSlides.length;
  showSlide(currentSlide);
}
function previousSlide(){
  if(!carouselSlides.length)return;
  currentSlide=(currentSlide-1+carouselSlides.length)%carouselSlides.length;
  showSlide(currentSlide);
}
document.addEventListener("DOMContentLoaded",loadHomepageCarousel);

/* =====================================================
   PESQUISA
===================================================== */

function openSearch() {

    document
        .getElementById(
            "searchOverlay"
        )
        .classList.add("active");


    setTimeout(
        () => {

            document
                .getElementById(
                    "searchInput"
                )
                .focus();

        },
        100
    );

}


function closeSearch() {

    document
        .getElementById(
            "searchOverlay"
        )
        .classList.remove("active");


    document.getElementById(
        "searchInput"
    ).value = "";

    document.getElementById("searchResults")?.replaceChildren();

}


// A busca mostra os resultados dentro da própria caixa: antes eles iam para a vitrine
// "Bolsas", atrás da tela escura, e não dava para tocar no produto encontrado.
function searchText(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function searchProducts() {
    const term = searchText(document.getElementById("searchInput").value);
    const container = document.getElementById("searchResults");
    if (!container) return [];
    container.replaceChildren();
    if (!term) return [];

    const found = products.filter(product =>
        searchText(product.name + " " + (product.category || "")).includes(term)
    );

    if (!found.length) {
        const empty = document.createElement("p");
        empty.className = "search-empty";
        empty.textContent = "Nenhum produto encontrado.";
        container.appendChild(empty);
        return found;
    }

    found.forEach(product => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "search-result";
        button.dataset.productId = product.id;

        const image = document.createElement("img");
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        if (product.images?.[0]) image.src = smallImage(product.images[0]);
        image.dataset.imgError = "hide";

        const info = document.createElement("span");
        const name = document.createElement("strong");
        name.textContent = product.name;
        const detail = document.createElement("small");
        detail.textContent = formatPrice(product.price) +
            (product.presale ? " · Pré-venda" : Number(product.stock || 0) <= 0 ? " · Esgotado" : "");
        info.append(name, detail);

        button.append(image, info);
        button.addEventListener("click", () => {
            closeSearch();
            openProductModal(product.id);
        });
        container.appendChild(button);
    });
    return found;
}


/* =====================================================
   NEWSLETTER
===================================================== */

async function subscribeNewsletter(event) {
    event.preventDefault();

    const form = event.target;
    const input = form.querySelector('input[type="email"]');
    const email = String(input?.value || "").trim().toLowerCase();

    if (!email) return;

    const button = form.querySelector("button");
    if (button) {
        button.disabled = true;
        button.textContent = "CADASTRANDO...";
    }

    try {
        const response = await fetch("/api/newsletter", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) {
            throw new Error(data.message || "Não foi possível concluir o cadastro.");
        }

        showToast("Cadastro realizado com sucesso.");
        form.reset();
    } catch (error) {
        console.error("Newsletter:", error);
        showToast(error.message || "Não foi possível concluir o cadastro.");
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "CADASTRAR";
        }
    }
}


/* =====================================================
   MENU MOBILE
===================================================== */

function goToNovidades(event){
    if(event?.target?.closest?.("button")) return;
    const section=document.getElementById("novidades");
    if(section) section.scrollIntoView({behavior:"smooth",block:"start"});
}

function toggleMobileMenu() {

    document
        .getElementById(
            "mainNavigation"
        )
        .classList
        .toggle("active");

}


function closeMobileMenu() {

    document
        .getElementById(
            "mainNavigation"
        )
        .classList
        .remove("active");

}


/* =====================================================
   TOAST
===================================================== */

let toastTimer = null;

function hideToast() {
    clearTimeout(toastTimer);
    document.getElementById("toast")?.classList.remove("show");
}

function showToast(message) {

    const toast =
        document.getElementById(
            "toast"
        );


    toast.textContent =
        message;


    toast.classList.add(
        "show"
    );


    // Mensagens longas (erro no pagamento, com o WhatsApp da loja) ficam o tempo de serem lidas.
    toast.classList.toggle("is-long", String(message || "").length > 60);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
        () => {

            toast.classList.remove(
                "show"
            );

        },
        Math.max(3000, String(message || "").length * 60)
    );

}


/* =====================================================
   SACOLA PELO LINK DO E-MAIL DE LEMBRETE
   ?sacola=[[produto, variação, quantidade], ...] em base64url.
   Só entram as peças que ainda têm estoque; a sacola abre
   quando a animação de abertura termina.
===================================================== */

function restoreCartFromLink() {
    let encoded = "";
    try { encoded = new URLSearchParams(location.search).get("sacola") || ""; } catch { return; }
    if (!encoded) return;

    // Tira o parâmetro do endereço: recarregar a página não refaz a sacola.
    try {
        const url = new URL(location.href);
        url.searchParams.delete("sacola");
        history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch {}

    let entries = [];
    try {
        entries = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
        return;
    }

    let restored = 0;
    (Array.isArray(entries) ? entries : []).slice(0, 20).forEach(entry => {
        const [productId, variantId, quantity] = Array.isArray(entry) ? entry : [];
        const product = products.find(p => p.id === productId);
        if (!product) return;
        const variant = variantId
            ? (product.variants || []).find(v => v.id === variantId && v.active !== false)
            : null;
        if (variantId && !variant) return;
        const stock = variant ? Number(variant.stock || 0) : Number(product.stock || 0);
        if (stock <= 0) return;
        const wanted = Math.max(1, Math.min(Math.floor(Number(quantity) || 1), stock));
        const key = variant?.id || "default";
        const existing = cart.find(item => item.id === product.id && (item.variant_id || "default") === key);
        if (existing) {
            existing.quantity = Math.max(Number(existing.quantity || 0), wanted);
        } else {
            cart.push({
                ...product,
                variant_id: variant?.id || null,
                variant_color: variant?.color || null,
                variant_sku: variant?.sku || product.sku || null,
                quantity: wanted
            });
        }
        restored++;
    });

    const root = document.documentElement;
    const whenIntroEnds = callback => {
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            observer.disconnect();
            callback();
        };
        const observer = new MutationObserver(() => {
            if (!root.classList.contains("intro-playing")) run();
        });
        if (!root.classList.contains("intro-playing")) return run();
        observer.observe(root, { attributes: true, attributeFilter: ["class"] });
        setTimeout(run, 9000);
    };

    if (!restored) {
        whenIntroEnds(() => showToast("As peças do seu pedido esgotaram. Veja as novidades da MONTÊ."));
        return;
    }

    updateCart();
    whenIntroEnds(openCart);
}

/* =====================================================
   LINK DIRETO PARA UM PRODUTO
   /?produto=ID abre a vitrine com o produto já aberto, depois da
   animação de abertura.
===================================================== */

function openProductFromLink() {
    let productId = "";
    try { productId = new URLSearchParams(location.search).get("produto") || ""; } catch { return; }
    if (!productId) return;

    if (!products.some(p => p.id === productId)) return;

    const root = document.documentElement;
    let done = false;
    const run = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        openProductModal(productId);
    };
    const observer = new MutationObserver(() => {
        if (!root.classList.contains("intro-playing")) run();
    });
    if (!root.classList.contains("intro-playing")) return run();
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    setTimeout(run, 9000);
}

/* =====================================================
   LOCAL STORAGE
===================================================== */

function loadCart() {

    let saved = null;
    try {
        saved =
            localStorage.getItem(
                "monteCart"
            );
    } catch {}


    if (saved) {

        try {

            cart =
                JSON.parse(saved);

        } catch {

            cart = [];

        }

    }

    if (!Array.isArray(cart)) cart = [];

    // O carrinho salvo pode ter preços antigos. Atualiza com o catálogo atual
    // (o servidor cobra sempre o preço vigente) e remove itens indisponíveis.
    if (products.length) {
        cart = cart
            .map(item => {
                const product = products.find(p => p.id === item.id);
                if (!product) return null;
                // A cor salva pode ter esgotado ou saído do site desde a última visita: o
                // checkout recusaria a sacola inteira. Sem cor salva, só vale se houver uma única.
                const inStock = (product.variants || []).filter(v => v.active !== false && Number(v.stock || 0) > 0);
                const variant = item.variant_id
                    ? inStock.find(v => v.id === item.variant_id)
                    : (inStock.length === 1 ? inStock[0] : null);
                if (!variant && (item.variant_id || (product.variants || []).length)) return null;
                const stock = variant ? Number(variant.stock || 0) : Number(product.stock || 0);
                if (stock <= 0) return null;
                return {
                    ...item,
                    variant_id: variant?.id || null,
                    variant_color: variant?.color || item.variant_color || null,
                    variant_sku: variant?.sku || item.variant_sku || null,
                    quantity: Math.min(Math.max(1, Number(item.quantity) || 1), stock),
                    name: product.name,
                    price: product.price,
                    oldPrice: product.oldPrice,
                    sale: product.sale,
                    presale: product.presale,
                    images: product.images,
                    variants: product.variants,
                    stock: product.stock
                };
            })
            .filter(Boolean);
    }


    updateCart();

}


/* =====================================================
   INICIALIZAÇÃO
===================================================== */

document.addEventListener(
    "DOMContentLoaded",
    async () => {

        // Carrega primeiro os produtos cadastrados no Supabase.
        // Isso garante que a vitrine use o estoque/catálogo do painel gerencial.
        await loadProductsFromDatabase();

        loadCart();
        // Promoções de presente do painel (escada de benefícios e aviso no topo).
        loadStorePromotions();

        restoreCartFromLink();
        openProductFromLink();

    }
);


document.addEventListener("DOMContentLoaded", () => {
    const cepInput = document.getElementById("customerCep");

    if (cepInput) {
        cepInput.addEventListener("input", () => {
            const digits = cepInput.value.replace(/\D/g, "").slice(0, 8);
            cepInput.value = digits.length > 5
                ? `${digits.slice(0, 5)}-${digits.slice(5)}`
                : digits;

            if (digits.length === 8) {
                lookupAddressByCep();
            }
        });

        cepInput.addEventListener("blur", () => {
            const digits = cepInput.value.replace(/\D/g, "");
            if (digits.length === 8) {
                lookupAddressByCep();
            }
        });
    }

    ["customerCity", "customerState"].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.addEventListener("input", () => updateShipping());
    });

    const cpfInput = document.getElementById("customerCpf");
    if (cpfInput) {
        cpfInput.addEventListener("input", () => {
            const digits = cpfInput.value.replace(/\D/g, "").slice(0, 11);
            cpfInput.value = digits
                .replace(/(\d{3})(\d)/, "$1.$2")
                .replace(/(\d{3})(\d)/, "$1.$2")
                .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
        });
    }
});

/* =====================================================
   PRIVACIDADE — PERMISSÃO DE COOKIES (LGPD)
   Necessários (sacola e a própria escolha) ficam sempre ativos.
   Estatísticas (Google Analytics e estatísticas da loja) e o lembrete
   da sacola por e-mail só funcionam depois que a cliente permite.
   A escolha vale 12 meses e muda pelo link "Preferências de cookies".
===================================================== */

const CONSENT_KEY = "monte_consent";
const CONSENT_MAX_AGE = 365 * 24 * 60 * 60 * 1000;
let privacyConsent = readPrivacyConsent();

// Antes da permissão as chamadas de estatística não fazem nada.
window.monteAnalytics = { track() {}, saveCart() {} };

function readPrivacyConsent() {
    try {
        const saved = JSON.parse(localStorage.getItem(CONSENT_KEY) || "null");
        if (saved && saved.v === 1 && Date.now() - Number(saved.at) < CONSENT_MAX_AGE) return saved;
    } catch {}
    return null;
}

function savePrivacyConsent(choice) {
    const before = privacyConsent;
    privacyConsent = { v: 1, analytics: !!choice.analytics, reminders: !!choice.reminders, at: Date.now() };
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify(privacyConsent)); } catch {}
    hideCookieConsent();
    // Permissão retirada: apaga o que já estava guardado e recarrega para parar o que estava rodando.
    if ((before?.analytics && !privacyConsent.analytics) || (before?.reminders && !privacyConsent.reminders)) {
        forgetTrackingData();
        location.reload();
        return;
    }
    applyPrivacyConsent();
    if (privacyConsent.analytics || privacyConsent.reminders) {
        window.monteAnalytics.record?.("consent_granted", { metadata: { analytics: privacyConsent.analytics, reminders: privacyConsent.reminders } });
    }
}

function forgetTrackingData() {
    for (const [store, keys] of [["localStorage", ["monte_analytics_visitor"]], ["sessionStorage", ["monte_analytics_session", "monte_analytics_session_started"]]]) {
        try { keys.forEach(key => window[store].removeItem(key)); } catch {}
    }
    // Cookies do Google Analytics (_ga, _ga_XXXX), no domínio da loja e no principal.
    const host = location.hostname;
    const domains = ["", host, "." + host, "." + host.replace(/^www\./, "")];
    document.cookie.split(";").map(c => c.split("=")[0].trim()).filter(name => /^_ga/.test(name)).forEach(name => {
        domains.forEach(domain => {
            document.cookie = name + "=; Max-Age=0; path=/" + (domain ? "; domain=" + domain : "");
        });
    });
}

function applyPrivacyConsent() {
    if (privacyConsent?.analytics || privacyConsent?.reminders) startStoreAnalytics();
    if (privacyConsent?.analytics) loadGoogleAnalytics();
}

let storeAnalyticsStarted = false;
function startStoreAnalytics() {
    if (storeAnalyticsStarted) return;
    storeAnalyticsStarted = true;
    const VK = "monte_analytics_visitor", SK = "monte_analytics_session", TK = "monte_analytics_session_started";
    const uid = () => window.crypto?.randomUUID ? window.crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const read = (store, key) => { try { return window[store].getItem(key); } catch { return null; } };
    const write = (store, key, value) => { try { window[store].setItem(key, value); } catch {} };
    const visitor_id = read("localStorage", VK) || uid();
    write("localStorage", VK, visitor_id);
    let session_id = read("sessionStorage", SK), started = Number(read("sessionStorage", TK) || 0);
    if (!session_id || !started || Date.now() - started > 1800000) {
        session_id = uid();
        write("sessionStorage", SK, session_id);
        write("sessionStorage", TK, String(Date.now()));
    }
    const post = async (path, data) => { try { await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true, body: JSON.stringify(data) }); } catch {} };
    const record = (name, extra) => post("/api/analytics/event", { visitor_id, session_id, event_name: name, path: location.pathname + location.search, referrer: document.referrer, ...extra });
    // Páginas, produtos vistos e sacola: só com a permissão de estatísticas.
    const track = (name, extra) => { if (privacyConsent?.analytics) record(name, extra); };
    // A sacola é salva com estatísticas ou lembrete; nome, e-mail e telefone só com o lembrete.
    function saveCart() {
        const items = Array.isArray(cart) ? cart : [];
        if (!items.length) return;
        const reminders = privacyConsent?.reminders === true;
        const shippingPrice = Number(selectedShippingOption?.price || 0);
        const subtotal = items.reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || 1), 0);
        post("/api/analytics/cart", {
            visitor_id, session_id,
            items: items.map(i => ({ id: i.id, product_id: i.id, product_name: i.name, sku: i.sku, variant_id: i.variant_id || null, variant_color: i.variant_color || i.color || null, quantity: i.quantity, unit_price: i.price, total_price: Number(i.price || 0) * Number(i.quantity || 1) })),
            subtotal, shipping: shippingPrice, total: subtotal + shippingPrice,
            customer_name: reminders ? document.getElementById("customerName")?.value || "" : "",
            customer_email: reminders ? document.getElementById("customerEmail")?.value || "" : "",
            customer_phone: reminders ? document.getElementById("customerPhone")?.value || "" : ""
        });
    }
    window.monteAnalytics = { track, saveCart, record };
    if (document.readyState === "complete") track("page_view");
    else window.addEventListener("load", () => track("page_view"), { once: true });
    setInterval(saveCart, 30000);
    document.addEventListener("click", e => {
        const el = e.target.closest?.("[data-product-id]");
        if (el) track("view_product", { product_id: el.dataset.productId, product_name: el.dataset.productName || null });
    });
}

let googleAnalyticsLoaded = false;
function loadGoogleAnalytics() {
    if (googleAnalyticsLoaded) return;
    googleAnalyticsLoaded = true;
    const id = "G-RCG5BX64FG";
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", id, { anonymize_ip: true });
    // Carrega quando o navegador está livre: a loja abre sem esperar o script do Google.
    const inject = () => {
        const script = document.createElement("script");
        script.async = true;
        script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
        document.head.appendChild(script);
    };
    const schedule = () => (window.requestIdleCallback ? requestIdleCallback(inject, { timeout: 4000 }) : setTimeout(inject, 2000));
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
}

function showCookieConsent(customize = false) {
    const box = document.getElementById("cookieConsent");
    if (!box) return;
    document.getElementById("consentAnalytics").checked = privacyConsent ? privacyConsent.analytics : false;
    document.getElementById("consentReminders").checked = privacyConsent ? privacyConsent.reminders : false;
    document.getElementById("cookieOptions").hidden = !customize;
    document.getElementById("cookieCustomize").hidden = customize;
    document.getElementById("cookieSave").hidden = !customize;
    box.hidden = false;
}

function hideCookieConsent() {
    const box = document.getElementById("cookieConsent");
    if (box) box.hidden = true;
}

function acceptCookies() { savePrivacyConsent({ analytics: true, reminders: true }); }
function rejectCookies() { savePrivacyConsent({ analytics: false, reminders: false }); }
function customizeCookies() { showCookieConsent(true); }
function saveCookieChoices() {
    savePrivacyConsent({
        analytics: document.getElementById("consentAnalytics").checked,
        reminders: document.getElementById("consentReminders").checked
    });
}
function openCookiePreferences(event) {
    event?.preventDefault?.();
    showCookieConsent(true);
}

applyPrivacyConsent();
(function askCookieConsent() {
    const wantsPreferences = new URLSearchParams(location.search).get("cookies") === "preferencias";
    if (privacyConsent && !wantsPreferences) return;
    // Aparece depois da abertura animada da loja.
    const root = document.documentElement;
    let shown = false;
    const show = () => { if (shown) return; shown = true; observer.disconnect(); showCookieConsent(wantsPreferences); };
    const observer = new MutationObserver(() => { if (!root.classList.contains("intro-playing")) show(); });
    if (!root.classList.contains("intro-playing")) return show();
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    setTimeout(show, 9000);
})();


/* =====================================================
   INSTAGRAM — ELFSIGHT
   O feed é renderizado pelo widget oficial do Elfsight no HTML.
===================================================== */



// Garante que a newsletter apareça apenas uma vez na página,
// mesmo que algum conteúdo seja reinserido dinamicamente.
(function ensureSingleNewsletter() {
    const removeDuplicateNewsletters = () => {
        const candidates = Array.from(document.querySelectorAll('section.newsletter, .newsletter'));
        const seen = new Set();
        candidates.forEach((section) => {
            const heading = section.querySelector('h2')?.textContent?.trim().replace(/\s+/g, ' ').toUpperCase() || '';
            const key = heading || 'newsletter';
            if (seen.has(key)) {
                section.remove();
            } else {
                seen.add(key);
            }
        });
    };

    const start = () => {
        removeDuplicateNewsletters();
        const observer = new MutationObserver(removeDuplicateNewsletters);
        observer.observe(document.body, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();


/* =====================================================
   FORMA DE PAGAMENTO
===================================================== */
document.addEventListener("DOMContentLoaded", setupPaymentMethodSelector);


/* =====================================================
   PARALLAX E ENTRADA SUAVE
   Elementos com data-parallax="velocidade" se deslocam conforme a
   posição do bloco na tela (camadas em profundidades diferentes).
   Usa a propriedade CSS "translate" para não conflitar com rotações.
   Desligado para quem pede menos movimento no sistema.
===================================================== */
(function setupParallaxAndReveal() {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const start = () => {
        const reveals = [...document.querySelectorAll(".reveal")];
        if ("IntersectionObserver" in window && !reduceMotion.matches) {
            document.documentElement.classList.add("js-motion");
            const observer = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    entry.target.classList.add("is-visible");
                    observer.unobserve(entry.target);
                });
            }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
            reveals.forEach(element => observer.observe(element));
        }

        const layers = [...document.querySelectorAll("[data-parallax]")];
        if (!layers.length) return;

        let scheduled = false;
        const update = () => {
            scheduled = false;
            const viewportHeight = window.innerHeight;
            const strength = window.innerWidth <= 760 ? 0.5 : 1;

            layers.forEach(layer => {
                if (reduceMotion.matches) {
                    layer.style.translate = "";
                    return;
                }
                const rect = layer.parentElement.getBoundingClientRect();
                if (rect.bottom < -200 || rect.top > viewportHeight + 200) return;
                const distanceFromCenter = rect.top + rect.height / 2 - viewportHeight / 2;
                const offset = distanceFromCenter * Number(layer.dataset.parallax || 0) * strength;
                layer.style.translate = "0 " + offset.toFixed(1) + "px";
            });

        };

        const requestUpdate = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(update);
        };

        window.addEventListener("scroll", requestUpdate, { passive: true });
        window.addEventListener("resize", requestUpdate);
        reduceMotion.addEventListener?.("change", requestUpdate);
        update();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();



/* =====================================================
   ABERTURA — libera a página quando a animação termina
===================================================== */
(function setupIntro() {
    const root = document.documentElement;
    const intro = document.getElementById("monteIntro");
    if (!intro) return;
    if (!root.classList.contains("intro-playing")) {
        intro.remove();
        return;
    }

    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        root.classList.remove("intro-playing");
        root.classList.add("intro-done");
        window.removeEventListener("pointermove", onMove);
        intro.remove();
        // Link para uma seção (ex.: /#colecao): vai até ela quando a abertura termina.
        const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (target) requestAnimationFrame(() => target.scrollIntoView());
    };

    // A animação começa quando a página aparece, o que no celular pode levar
    // alguns segundos depois da navegação. Conta o tempo pela própria animação.
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) root.classList.add("intro-reduced");
    const duration = root.classList.contains("intro-reduced") ? 1400 : 4500;
    const own = intro.getAnimations ? intro.getAnimations().find(a => a.effect && a.effect.target === intro && !a.effect.pseudoElement) : null;
    let remaining = duration;
    if (own && typeof own.currentTime === "number") {
        const timing = own.effect.getComputedTiming();
        remaining = Number(timing.endTime || duration) - own.currentTime + 50;
    }
    let timer = setTimeout(finish, Math.max(300, remaining));

    intro.addEventListener("animationend", event => {
        if (event.target === intro && !event.pseudoElement) finish();
    });

    const stage = intro.querySelector(".intro-stage");
    const tagline = intro.querySelector(".intro-tagline");
    function onMove(event) {
        const x = event.clientX / window.innerWidth - .5;
        const y = event.clientY / window.innerHeight - .5;
        stage?.style.setProperty("--ix", (x * -16).toFixed(1) + "px");
        stage?.style.setProperty("--iy", (y * -12).toFixed(1) + "px");
        if (tagline) tagline.style.translate = (x * 10).toFixed(1) + "px " + (y * 8).toFixed(1) + "px";
    }
    window.addEventListener("pointermove", onMove, { passive: true });

    intro.addEventListener("click", () => {
        if (intro.classList.contains("is-skipping")) return;
        intro.classList.add("is-skipping");
        root.classList.add("intro-skipped");
        clearTimeout(timer);
        timer = setTimeout(finish, 1000);
    });
})();


/* =====================================================
   NOTA MONTÊ — etiqueta de compra no checkout
===================================================== */
const NOTE_FIELDS = ["customerName", "customerEmail", "customerPhone", "customerCpf", "customerCep", "customerStreet", "customerNumber", "customerComplement", "customerNeighborhood", "customerCity", "customerState"];
let lastNoteSignature = "";

function noteValue(id) {
    return (document.getElementById(id)?.value || "").trim();
}

function maskCpfForNote(value) {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 11) return digits ? digits.replace(/\d(?=\d{2})/g, "•") : "";
    return "•••." + digits.slice(3, 6) + "." + digits.slice(6, 9) + "-••";
}

function setNoteText(id, text, placeholder = "— — —") {
    const element = document.getElementById(id);
    if (!element) return;
    const value = text || placeholder;
    if (element.textContent !== value) {
        element.textContent = value;
        element.classList.remove("is-fresh");
        void element.offsetWidth;
        if (text) element.classList.add("is-fresh");
    }
    element.classList.toggle("is-empty", !text);
}

function drawNoteBarcode(seed) {
    const box = document.getElementById("noteBarcode");
    if (!box) return;
    let hash = 2166136261;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const stops = [];
    let x = 0;
    while (x < 100) {
        hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
        const bar = 0.8 + (Math.abs(hash) % 3) * 0.8;
        const gap = 0.8 + (Math.abs(hash >> 5) % 3) * 0.7;
        stops.push(`#1b1716 ${x.toFixed(1)}% ${(x + bar).toFixed(1)}%`, `transparent ${(x + bar).toFixed(1)}% ${(x + bar + gap).toFixed(1)}%`);
        x += bar + gap;
    }
    box.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
}

function renderCheckoutNote(summary) {
    if (!document.getElementById("orderNote")) return;
    const totals = summary || checkoutTotals();

    const today = new Date();
    setNoteText("noteDate", [today.getDate(), today.getMonth() + 1].map(n => String(n).padStart(2, "0")).join(".") + "." + today.getFullYear());

    setNoteText("noteName", noteValue("customerName"));
    setNoteText("noteContact", [noteValue("customerEmail"), noteValue("customerPhone")].filter(Boolean).join(" · "));
    setNoteText("noteCpf", maskCpfForNote(noteValue("customerCpf")));

    const street = [noteValue("customerStreet"), noteValue("customerNumber")].filter(Boolean).join(", ");
    const cityLine = [noteValue("customerCity"), noteValue("customerState").toUpperCase()].filter(Boolean).join(" / ");
    const address = [street, noteValue("customerComplement"), noteValue("customerNeighborhood"), cityLine, noteValue("customerCep")].filter(Boolean).join(" — ");
    setNoteText("noteAddress", address);

    const itemsBox = document.getElementById("noteItems");
    if (itemsBox) {
        setHTML(itemsBox, cart.length
            ? cart.map(item => `<div class="order-note-item"><span>${escapeHTML(item.name)}</span><span>${formatPrice(Number(item.price || 0) * Number(item.quantity || 0))}</span><small>${escapeHTML(colorLabel(item.variant_color, item.name) || "Cor única")} · ${Number(item.quantity || 0)} un.</small></div>`).join("")
            : '<div class="order-note-item"><span class="is-empty">Nenhuma peça na sacola</span></div>');
        const gift = currentGift();
        if (gift) appendHTML(itemsBox, `<div class="order-note-item"><span>${escapeHTML(gift.product.name)}</span><span>Presente</span><small>${escapeHTML(gift.color || "Cor única")} · 1 un.</small></div>`);
    }

    setNoteText("noteShipping", selectedShippingOption ? `${selectedShippingOption.name} · ${shippingPriceLabel(selectedShippingOption)}` : "");
    const discountRow = document.getElementById("noteDiscountRow");
    if (discountRow) discountRow.hidden = !(totals.pixDiscount > 0);
    setNoteText("noteDiscount", totals.pixDiscount > 0 ? "-" + formatPrice(totals.pixDiscount) : "");
    const couponRow = document.getElementById("noteCouponRow");
    if (couponRow) couponRow.hidden = !(totals.couponDiscount > 0);
    setNoteText("noteCouponLabel", appliedCoupon ? "Cupom " + appliedCoupon.code : "Cupom");
    setNoteText("noteCoupon", totals.couponDiscount > 0 ? "-" + formatPrice(totals.couponDiscount) : "");
    setNoteText("notePayment", totals.paymentMethod === "pix"
        ? (PIX_DISCOUNT_PERCENT > 0 ? `Pix · ${percentText(PIX_DISCOUNT_PERCENT)} off nas peças` : "Pix")
        : "Cartão de crédito");
    setNoteText("noteTotal", formatPrice(totals.total));

    const signature = [noteValue("customerName"), noteValue("customerCpf"), address, cart.length, totals.total].join("|");
    drawNoteBarcode(signature || "MONTE");
    if (signature !== lastNoteSignature) {
        lastNoteSignature = signature;
        const tag = document.querySelector(".order-note-tag");
        if (tag && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            tag.classList.remove("is-swaying");
            void tag.offsetWidth;
            tag.classList.add("is-swaying");
        }
    }
}

(function setupCheckoutNote() {
    const start = () => {
        const note = document.getElementById("orderNote");
        if (!note) return;
        const tag = note.querySelector(".order-note-tag");
        const cord = note.querySelector(".order-note-cord");
        const scroller = document.querySelector("#cartOverlay .cart");
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

        NOTE_FIELDS.forEach(id => document.getElementById(id)?.addEventListener("input", () => renderCheckoutNote()));

        // Ponteiro: a etiqueta inclina e as camadas internas se deslocam.
        note.addEventListener("pointermove", event => {
            if (reduceMotion.matches || event.pointerType === "touch") return;
            const rect = tag.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width - .5;
            const y = (event.clientY - rect.top) / rect.height - .5;
            tag.style.setProperty("--ry", (x * 10).toFixed(2) + "deg");
            tag.style.setProperty("--rx", (y * -7).toFixed(2) + "deg");
            tag.style.setProperty("--px", (x * 2).toFixed(2));
            tag.style.setProperty("--py", (y * 2).toFixed(2));
        });
        note.addEventListener("pointerleave", () => {
            ["--rx", "--ry", "--px", "--py"].forEach(name => tag.style.removeProperty(name));
        });

        // Rolagem do carrinho: cordão e etiqueta em velocidades diferentes.
        let scheduled = false;
        const onScroll = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                if (reduceMotion.matches) return;
                const rect = note.getBoundingClientRect();
                const fromCenter = rect.top + rect.height / 2 - window.innerHeight / 2;
                tag.style.setProperty("--tag-y", (fromCenter * -0.05).toFixed(1) + "px");
                cord.style.setProperty("--cord-y", (fromCenter * 0.06).toFixed(1) + "px");
            });
        };
        scroller?.addEventListener("scroll", onScroll, { passive: true });

        renderCheckoutNote();
        onScroll();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();

/* =====================================================
   CHECKOUT — etapas, campos e barra de finalização
   Mostra o progresso da compra, confirma cada campo
   preenchido, destaca o que falta e mantém o total e o
   botão de finalizar sempre à vista.
===================================================== */

// Celular com DDD e 9 dígitos. O preenchimento automático pode trazer o +55 na frente.
function phoneDigits(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length > 11 && digits.startsWith("55") ? digits.slice(2) : digits;
}

const CHECKOUT_RULES = {
    customerName: v => v.trim().split(/\s+/).filter(Boolean).length >= 2,
    customerEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()),
    customerPhone: v => /^[1-9]{2}9\d{8}$/.test(phoneDigits(v)),
    customerCpf: v => v.replace(/\D/g, "").length === 11,
    customerCep: v => v.replace(/\D/g, "").length === 8,
    customerStreet: v => v.trim().length > 1,
    customerNumber: v => v.trim().length > 0,
    customerNeighborhood: v => v.trim().length > 1,
    customerCity: v => v.trim().length > 1,
    customerState: v => /^[A-Za-z]{2}$/.test(v.trim())
};

const CHECKOUT_STEP_FIELDS = {
    data: ["customerName", "customerEmail", "customerPhone", "customerCpf"],
    delivery: ["customerCep", "customerStreet", "customerNumber", "customerNeighborhood", "customerCity", "customerState"]
};

function checkoutFieldValid(id) {
    const input = document.getElementById(id);
    return !!input && CHECKOUT_RULES[id](input.value || "");
}

function refreshCheckoutField(input, { strict = false } = {}) {
    const field = input?.closest(".field");
    // O cupom só fica marcado depois de conferido no servidor (renderCouponStatus).
    if (!field || input.id === "couponCode") return;
    const rule = CHECKOUT_RULES[input.id];
    const value = input.value || "";
    const valid = rule ? rule(value) : value.trim().length > 0;
    field.classList.toggle("is-valid", !!value.trim() && valid);
    if (valid || !value.trim()) field.classList.remove("is-invalid");
    else if (strict) field.classList.add("is-invalid");
}

function flagCheckoutFields(ids) {
    const required = [...CHECKOUT_STEP_FIELDS.data, ...CHECKOUT_STEP_FIELDS.delivery];
    const missing = ids || required.filter(id => !(document.getElementById(id)?.value || "").trim());
    missing.forEach(id => document.getElementById(id)?.closest(".field")?.classList.add("is-invalid"));
    const first = document.getElementById(missing[0]);
    if (first) {
        first.closest(".field")?.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => first.focus({ preventScroll: true }), 350);
    }
}

function updateCheckoutProgress() {
    const steps = document.getElementById("checkoutSteps");
    if (!steps) return;
    const done = {
        bag: cart.length > 0,
        data: CHECKOUT_STEP_FIELDS.data.every(checkoutFieldValid),
        delivery: CHECKOUT_STEP_FIELDS.delivery.every(checkoutFieldValid) && !!selectedShippingOption
    };
    done.payment = done.bag && done.data && done.delivery;
    const order = ["bag", "data", "delivery", "payment"];
    const current = order.find(step => !done[step]);
    steps.querySelectorAll("li").forEach(li => {
        li.classList.toggle("is-done", !!done[li.dataset.step]);
        li.classList.toggle("is-current", li.dataset.step === current);
    });
    steps.style.setProperty("--progress", current ? order.indexOf(current) / (order.length - 1) : 1);
    document.querySelectorAll(".checkout-step[data-section]").forEach(section => {
        section.classList.toggle("is-complete", !!done[section.dataset.section]);
    });
}

function renderCheckoutExtras({ subtotal, shipping, pixDiscount, couponDiscount = 0, paymentMethod }) {
    const potential = cart.reduce((sum, item) =>
        sum + pixUnitDiscountCents(Math.round(Number(item.price || 0) * 100)) * Number(item.quantity || 0), 0) / 100;

    const perk = document.getElementById("pixPerk");
    const perkText = document.getElementById("pixPerkText");
    const perkButton = document.getElementById("pixPerkButton");
    if (perk && perkText) {
        perk.hidden = !(cart.length && potential > 0);
        perk.classList.toggle("is-active", paymentMethod === "pix");
        setHTML(perkText, paymentMethod === "pix"
            ? `Pix selecionado: você economiza <strong>${formatPrice(potential)}</strong>`
            : `Pagando no Pix você economiza <strong>${formatPrice(potential)}</strong>`);
        if (perkButton) perkButton.hidden = paymentMethod === "pix";
    }

    // Frete grátis em Fortaleza e região a partir de R$ 599: quanto falta, ou o aviso de que
    // ganhou. Some quando o endereço é de outra cidade (lá o frete continua sendo cobrado).
    const freePerk = document.getElementById("freeShippingPerk");
    const freePerkText = document.getElementById("freeShippingPerkText");
    const freePerkFill = document.getElementById("freeShippingPerkFill");
    const otherCity = !!selectedShippingOption && !FREE_SHIPPING_OPTION_IDS.includes(selectedShippingOption.id);
    const giftPromoShown = renderGiftPerk({ subtotal, freeShippingApplies: FREE_SHIPPING_ENABLED && !otherCity });
    if (freePerk && freePerkText) {
        const missing = Math.max(0, FREE_SHIPPING_MIN - subtotal);
        freePerk.hidden = !cart.length || otherCity || giftPromoShown || !FREE_SHIPPING_ENABLED;
        freePerk.classList.toggle("is-active", missing === 0);
        setHTML(freePerkText, missing === 0
            ? (selectedShippingOption ? "Você ganhou <strong>frete grátis</strong>!" : "Frete grátis para <strong>Fortaleza e região</strong> nesta compra")
            : `Faltam <strong>${formatPrice(missing)}</strong> para frete grátis em Fortaleza e região`);
        if (freePerkFill) freePerkFill.style.width = Math.min(100, subtotal / FREE_SHIPPING_MIN * 100).toFixed(1) + "%";
    }

    const hint = document.getElementById("checkoutBarHint");
    if (hint) {
        const parts = [];
        if (pixDiscount > 0) parts.push(`${formatPrice(pixDiscount)} de desconto no Pix`);
        if (couponDiscount > 0) parts.push(`cupom -${formatPrice(couponDiscount)}`);
        if (currentGift(subtotal)) parts.push("presente incluso");
        parts.push(selectedShippingOption
            ? (shipping === 0 && Number(selectedShippingOption.price || 0) > 0 ? "frete grátis" : `frete ${formatPrice(shipping)}`)
            : "frete a calcular");
        hint.textContent = parts.join(" · ");
    }

    const total = document.getElementById("checkoutTotal");
    if (total && total.dataset.last !== total.textContent) {
        if (total.dataset.last) {
            total.classList.remove("is-bumping");
            void total.offsetWidth;
            total.classList.add("is-bumping");
        }
        total.dataset.last = total.textContent;
    }

    updateCheckoutProgress();
}

(function setupCheckoutExperience() {
    const start = () => {
        const form = document.querySelector("#cartOverlay .checkout-form");
        if (!form) return;

        const phone = document.getElementById("customerPhone");
        if (phone) {
            phone.addEventListener("input", () => {
                const d = phoneDigits(phone.value).slice(0, 11);
                phone.value = d.length > 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
                    : d.length > 6 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
                    : d.length > 2 ? `(${d.slice(0, 2)}) ${d.slice(2)}`
                    : d;
            });
        }

        const state = document.getElementById("customerState");
        if (state) state.addEventListener("input", () => { state.value = state.value.replace(/[^a-z]/gi, "").toUpperCase(); });

        form.querySelectorAll(".field input").forEach(input => {
            input.addEventListener("input", () => { refreshCheckoutField(input); updateCheckoutProgress(); });
            input.addEventListener("blur", () => refreshCheckoutField(input, { strict: true }));
        });

        // O CEP preenche rua, bairro e cidade sem disparar "input": confere de novo.
        const recheck = () => { form.querySelectorAll(".field input").forEach(i => refreshCheckoutField(i)); updateCheckoutProgress(); };
        form.addEventListener("change", recheck);
        new MutationObserver(recheck).observe(document.getElementById("shippingValue") || form, { childList: true, characterData: true, subtree: true });

        document.getElementById("pixPerkButton")?.addEventListener("click", () => {
            const pix = document.querySelector('input[name="paymentMethod"][value="pix"]');
            if (!pix) return;
            pix.checked = true;
            pix.dispatchEvent(new Event("change", { bubbles: true }));
        });

        document.querySelectorAll("#checkoutSteps [data-go]").forEach(button => {
            button.addEventListener("click", () => {
                const target = document.getElementById(button.dataset.go);
                if (!target) return;
                const panel = document.querySelector("#cartOverlay .cart");
                const header = panel.querySelector(".cart-header");
                const top = target.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - header.offsetHeight - 12;
                panel.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
            });
        });

        recheck();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
})();


/* =====================================================
   AÇÕES DOS BOTÕES E CAMPOS
   A CSP do site não aceita JavaScript dentro do HTML (onclick="..."):
   os botões dizem a ação em data-click (veja safe-html.js) e só as
   funções desta lista podem ser chamadas.
===================================================== */

/* =====================================================
   CARROSSEL BORDEAUX COLLECTION (seção "Mais que bolsas.")
   Setas, pontos, arrastar no celular e troca a cada 6 s enquanto
   a seção está na tela. Para no mouse/foco e para quem pede menos
   movimento no sistema.
===================================================== */
(function setupEditorialCarousel() {
    const start = () => {
        const root = document.getElementById("editorialCarousel");
        if (!root) return;
        const slides = [...root.querySelectorAll(".editorial-slide")];
        const dotsBox = document.getElementById("editorialCarouselDots");
        if (slides.length < 2) {
            const controls = root.querySelector(".editorial-carousel-controls");
            if (controls) controls.hidden = true;
            return;
        }

        let current = 0;
        let timer = null;
        let visible = false;
        let paused = false;
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

        const dots = slides.map((_, index) => {
            const dot = document.createElement("button");
            dot.type = "button";
            dot.className = "editorial-carousel-dot" + (index === 0 ? " active" : "");
            dot.setAttribute("aria-label", "Mostrar foto " + (index + 1) + " de " + slides.length);
            dot.addEventListener("click", () => { show(index); restart(); });
            dotsBox?.appendChild(dot);
            return dot;
        });

        function show(index) {
            current = (index + slides.length) % slides.length;
            slides.forEach((slide, i) => {
                slide.classList.toggle("active", i === current);
                if (i === current) slide.removeAttribute("aria-hidden");
                else slide.setAttribute("aria-hidden", "true");
            });
            dots.forEach((dot, i) => {
                dot.classList.toggle("active", i === current);
                if (i === current) dot.setAttribute("aria-current", "true");
                else dot.removeAttribute("aria-current");
            });
        }

        function restart() {
            clearInterval(timer);
            timer = null;
            if (visible && !paused && !reduceMotion.matches && !document.hidden) {
                timer = setInterval(() => show(current + 1), 6000);
            }
        }

        root.querySelector(".editorial-carousel-prev")?.addEventListener("click", () => { show(current - 1); restart(); });
        root.querySelector(".editorial-carousel-next")?.addEventListener("click", () => { show(current + 1); restart(); });

        root.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") { paused = true; restart(); } });
        root.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") { paused = false; restart(); } });
        root.addEventListener("focusin", () => { paused = true; restart(); });
        root.addEventListener("focusout", () => { paused = false; restart(); });

        // Arrastar para o lado troca a foto (celular).
        let touchX = null;
        root.addEventListener("touchstart", event => { touchX = event.touches[0].clientX; }, { passive: true });
        root.addEventListener("touchend", event => {
            if (touchX === null) return;
            const delta = event.changedTouches[0].clientX - touchX;
            touchX = null;
            if (Math.abs(delta) < 40) return;
            show(current + (delta < 0 ? 1 : -1));
            restart();
        });

        if ("IntersectionObserver" in window) {
            new IntersectionObserver(entries => {
                visible = entries.some(entry => entry.isIntersecting);
                restart();
            }, { threshold: 0.3 }).observe(root);
        } else {
            visible = true;
        }
        document.addEventListener("visibilitychange", restart);
        reduceMotion.addEventListener?.("change", restart);
        show(0);
        restart();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();


function browseNovidades() {
    closeCart();
    document.getElementById("novidades")?.scrollIntoView({ behavior: "smooth" });
}

registerClickActions({
    applyCoupon, browseNovidades, chooseGift, pickGiftProduct, changeQuantity, checkout, closeCart, closeCartOutside, closeMobileMenu,
    closeProductImageLightbox, closeProductModal, closeSearch, goToNovidades, navigateProductLightbox,
    nextCategoryPage, nextCollectionPage, nextNewPage, nextSalePage, nextSlide, openCart, openSearch,
    openWhatsAppReservation, previousCategoryPage, previousCollectionPage, previousNewPage,
    previousSalePage, previousSlide, removeCoupon, removeFromCart, toggleMobileMenu, updateItemQuantity,
    acceptCookies, rejectCookies, customizeCookies, saveCookieChoices, openCookiePreferences
});

document.getElementById("searchInput")?.addEventListener("input", () => searchProducts());
// Enter no campo do cupom aplica o cupom (sem enviar nada além disso).
document.getElementById("couponCode")?.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!appliedCoupon) applyCoupon();
});
document.getElementById("couponCode")?.addEventListener("input", () => {
    if (!appliedCoupon) renderCouponStatus(0);
});
// Enter abre o primeiro resultado; Esc ou um toque fora da caixa fecham a busca.
document.getElementById("searchInput")?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        event.preventDefault();
        document.querySelector("#searchResults .search-result")?.click();
    } else if (event.key === "Escape") {
        closeSearch();
    }
});
document.getElementById("searchOverlay")?.addEventListener("click", event => {
    if (event.target.id === "searchOverlay") closeSearch();
});
document.getElementById("newsletterForm")?.addEventListener("submit", event => subscribeNewsletter(event));
document.getElementById("carouselSlides")?.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        goToNovidades(event);
    }
});


