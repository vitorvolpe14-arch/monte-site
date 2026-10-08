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
        images: Array.isArray(product.images) ? product.images : [],
        variants: product.product_variants || [],
        stock: (product.product_variants || [])
            .reduce((total, variant) => total + Number(variant.stock || 0), 0)
    }));

    renderProducts();
    revealCatalogSections();
}

/* =====================================================
   ESTADO
===================================================== */

let cart = [];
let selectedPaymentMethod = "pix";
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
                product.newProduct
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
            productImageElement.addEventListener("load", applyProductBackground, { once: true });
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

    renderCollectionProducts(
        products.filter(product => product.category === "bolsas")
    );

    renderCategorySectionProducts(
        "cintos-acessorios",
        products.filter(product => product.category === "cintos" || product.category === "acessorios")
    );

    renderSaleProducts(products.filter(product => product.sale));
    renderNewProducts(products.filter(product => product.newProduct));
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

    currentNewIndex =
        (currentNewIndex + NEW_STEP) % newProducts.length;

    renderNewPage();

}


function previousNewPage() {

    if (newProducts.length <= getCarouselVisibleCount()) return;

    currentNewIndex =
        (currentNewIndex - NEW_STEP + newProducts.length) %
        newProducts.length;

    renderNewPage();

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

    currentSaleIndex =
        (currentSaleIndex + SALE_STEP) % saleProducts.length;

    renderSalePage();

}


function previousSalePage() {

    if (saleProducts.length <= getCarouselVisibleCount()) {
        return;
    }

    currentSaleIndex =
        (currentSaleIndex - SALE_STEP + saleProducts.length) % saleProducts.length;

    renderSalePage();

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


    currentCollectionIndex =
        (currentCollectionIndex + COLLECTION_STEP) %
        collectionProducts.length;

    renderCollectionPage();

}


function previousCollectionPage() {

    if (collectionProducts.length <= getCarouselVisibleCount()) {
        return;
    }


    currentCollectionIndex =
        (currentCollectionIndex - COLLECTION_STEP +
            collectionProducts.length) %
        collectionProducts.length;

    renderCollectionPage();

}


let categorySectionProducts = { cintos: [], acessorios: [] };
let categorySectionIndexes = { cintos: 0, acessorios: 0 };

// A vitrine de categoria divide a largura com o texto ao lado:
// 3 cards por vez no computador e 2 no celular.
function getCategoryVisibleCount() {
    return window.matchMedia("(max-width: 650px)").matches ? 2 : 3;
}

function renderCategorySection(category) {
    const container = document.getElementById(category === "cintos-acessorios" ? "cintosAcessoriosProducts" : category + "Products");
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
    categorySectionIndexes[category] =
        (categorySectionIndexes[category] + getCategoryVisibleCount()) % list.length;
    renderCategorySection(category);
}

function previousCategoryPage(category) {
    const list = categorySectionProducts[category] || [];
    if (list.length <= getCategoryVisibleCount()) return;
    categorySectionIndexes[category] =
        (categorySectionIndexes[category] - getCategoryVisibleCount() + list.length) % list.length;
    renderCategorySection(category);
}

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

function filterProducts(category) {

    document
        .querySelectorAll(".filter-button")
        .forEach(button => {

            button.classList.remove("active");

        });


    const activeButton =
        document.querySelector(
            `[data-filter="${category}"]`
        );

    if (activeButton) {
        activeButton.classList.add("active");
    }


    const filteredProducts =
        products.filter(product => {

            if (category === "all") {

                return true;

            }

            return product.category === category;

        });


    renderCollectionProducts(filteredProducts);

}


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
    const reservationBox = document.getElementById("reservationBox");

    if (quantityTitle) quantityTitle.style.display = isSelectionSoldOut ? "none" : "";
    if (quantitySelector) quantitySelector.style.display = isSelectionSoldOut ? "none" : "";
    if (addButton) addButton.style.display = isSelectionSoldOut ? "none" : "";

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
        mainImage.src = image;
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

document.getElementById(
    "addProductButton"
).addEventListener(
    "click",
    () => {

        if (!selectedProduct) return;

        const available = selectedVariant ? Number(selectedVariant.stock || 0) : Number(selectedProduct.stock || 0);
        if (available <= 0 || selectedQuantity > available) {
            showToast("Quantidade indisponível para este produto.");
            return;
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
            existing.quantity = Math.min(existing.quantity + selectedQuantity, maxStock);

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


        closeProductModal();


        showToast(
            "Produto adicionado ao carrinho."
        );

    }
);


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


    localStorage.setItem(
        "monteCart",
        JSON.stringify(cart)
    );

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

function openCart() {

    document
        .getElementById("cartOverlay")
        .classList.add("active");

    document.body.classList.add("cart-open");

}


function closeCart() {

    document
        .getElementById("cartOverlay")
        .classList.remove("active");

    document.body.classList.remove("cart-open");

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


function getCartSubtotal() {
    return cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
}

function updatePaymentSummary(subtotal = getCartSubtotal()) {
    const shipping = getShippingValue();
    const paymentMethod =
        document.querySelector('input[name="paymentMethod"]:checked')?.value ||
        selectedPaymentMethod ||
        "pix";

    selectedPaymentMethod = paymentMethod;

    // Mesmo cálculo do servidor: 5% por unidade, arredondado em centavos.
    const pixDiscount = paymentMethod === "pix"
        ? cart.reduce((sum, item) => {
            const unitCents = Math.round(Number(item.price || 0) * 100);
            return sum + (unitCents - Math.round(unitCents * 0.95)) * Number(item.quantity || 0);
        }, 0) / 100
        : 0;

    const checkoutTotal = Number(
        (subtotal - pixDiscount + shipping).toFixed(2)
    );

    const checkoutElement = document.getElementById("checkoutTotal");
    if (checkoutElement) checkoutElement.textContent = formatPrice(checkoutTotal);

    const discountElement = document.getElementById("checkoutDiscount");
    if (discountElement) {
        discountElement.textContent = pixDiscount > 0
            ? `Desconto Pix: -${formatPrice(pixDiscount)}`
            : "";
        discountElement.style.display = pixDiscount > 0 ? "block" : "none";
    }

    document.querySelectorAll(".payment-option").forEach(option => {
        const input = option.querySelector('input[name="paymentMethod"]');
        option.classList.toggle("selected", !!input?.checked);
    });

    renderCheckoutNote({ subtotal, shipping, pixDiscount, total: checkoutTotal, paymentMethod });
    renderCheckoutExtras({ subtotal, shipping, pixDiscount, paymentMethod });
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
    return Number(selectedShippingOption?.price || 0);
}

function renderShippingOptions() {
    const container = document.getElementById("shippingOptions");
    if (!container) return;
    container.replaceChildren();
    shippingOptions.forEach(option => {
        const label = document.createElement("label");
        label.className = "shipping-option" + (selectedShippingOption?.id === option.id ? " selected" : "");
        const min = Number(option.delivery_min_days || 0);
        const max = Number(option.delivery_max_days || 0);
        const days = min && max && min !== max ? `${min} a ${max} dias úteis` : (max || option.delivery_days) ? `${max || option.delivery_days} dias úteis` : "Prazo informado";
        setHTML(label, `<input type="radio" name="shippingMethod" value="${String(option.id).replace(/"/g, "&quot;")}" ${selectedShippingOption?.id === option.id ? "checked" : ""}><span class="shipping-option-info"><strong>${option.name}</strong><small>${days}</small></span><strong class="shipping-option-price">${formatPrice(option.price)}</strong>`);
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
        shippingValueElement.textContent = formatPrice(local.price);
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
        shippingValueElement.textContent = formatPrice(selectedShippingOption.price);
        renderShippingOptions(); updatePaymentSummary();
    } catch(error) {
        if (requestId !== shippingRequestId) return;
        shippingValueElement.textContent = "Não disponível";
        if (optionsContainer) setHTML(optionsContainer, `<div class="shipping-error">${error.message || "Não foi possível calcular o frete."}</div>`);
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

async function checkout() {
    if (!Array.isArray(cart) || cart.length === 0) { showToast("Seu carrinho está vazio."); return; }
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
    const whatsappNumber=phone.replace(/\D/g,"");
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

    const checkoutButton=document.querySelector(".checkout-button");
    if(checkoutButton){checkoutButton.disabled=true;checkoutButton.textContent="PREPARANDO PAGAMENTO...";}
    showToast("Preparando seu pagamento...");
    window.monteAnalytics?.track("begin_checkout",{value:getCartSubtotal(),metadata:{payment_method:paymentMethod}});
    window.monteAnalytics?.saveCart();

    try{
        const response=await fetch("/api/criar-checkout",{
            method:"POST",
            headers:{"Content-Type":"application/json","Accept":"application/json"},
            body:JSON.stringify({items,shipping_service_id:shippingServiceId,payment_method:paymentMethod,
                customer:{name,email,phone,whatsapp_phone:whatsappNumber,whatsapp_updates:true,cpf:cpfDigits,
                    address:{cep,street,number,complement:complement||"",neighborhood,city,state}}})
        });
        const responseText=await response.text();
        let data=null;
        try{data=JSON.parse(responseText);}catch{console.error("Resposta não é JSON:",responseText);}
        if(!response.ok){
            if(data?.stock_changed&&typeof loadProductsFromDatabase==="function")loadProductsFromDatabase().catch(()=>{});
            throw new Error(data?.message||("Erro do servidor ("+response.status+")."));
        }

        if(paymentMethod==="pix"&&data?.pix_checkout&&data?.url){
            closeCart();
            let pixCheckoutUrl;
            try{
                pixCheckoutUrl=new URL(data.url);
            }catch{
                throw new Error("O servidor retornou um link Pix inválido.");
            }
            try{
                window.top.location.replace(pixCheckoutUrl.href);
            }catch(navigationError){
                window.location.replace(pixCheckoutUrl.href);
            }
            return;
        }

        const checkoutUrl=data?.url||data?.checkoutUrl||data?.paymentUrl||data?.redirectUrl;
        if(!checkoutUrl)throw new Error(data?.message||"O servidor não retornou o link da InfinitePay.");
        let validUrl;
        try{validUrl=new URL(checkoutUrl);}catch{throw new Error("O servidor retornou um link de pagamento inválido.");}

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
        showToast(error.message||"Não foi possível abrir o pagamento.");
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

}


function searchProducts() {

    const search =
        document
            .getElementById(
                "searchInput"
            )
            .value
            .toLowerCase();


    const container =
        document.getElementById(
            "allProducts"
        );


    container.replaceChildren();


    products
        .filter(
            product =>
                product.name
                    .toLowerCase()
                    .includes(search)
        )
        .forEach(
            product =>
                container.appendChild(
                    createProductCard(
                        product
                    )
                )
        );


    document
        .getElementById(
            "colecao"
        )
        .scrollIntoView({
            behavior: "smooth"
        });

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


    setTimeout(
        () => {

            toast.classList.remove(
                "show"
            );

        },
        3000
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
   LOCAL STORAGE
===================================================== */

function loadCart() {

    const saved =
        localStorage.getItem(
            "monteCart"
        );


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
                return {
                    ...item,
                    name: product.name,
                    price: product.price,
                    oldPrice: product.oldPrice,
                    sale: product.sale,
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

        restoreCartFromLink();

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

(function(){
 const VK="monte_analytics_visitor",SK="monte_analytics_session",TK="monte_analytics_session_started";
 const uid=()=>window.crypto?.randomUUID?window.crypto.randomUUID():Date.now().toString(36)+"-"+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
 const read=(store,key)=>{try{return window[store].getItem(key)}catch{return null}};
 const write=(store,key,value)=>{try{window[store].setItem(key,value)}catch{}};
 const visitor_id=read("localStorage",VK)||uid();write("localStorage",VK,visitor_id);
 let session_id=read("sessionStorage",SK),started=Number(read("sessionStorage",TK)||0);
 if(!session_id||!started||Date.now()-started>1800000){session_id=uid();write("sessionStorage",SK,session_id);write("sessionStorage",TK,String(Date.now()));}
 async function post(path,data){try{await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},keepalive:true,body:JSON.stringify(data)})}catch{}}
 function track(name,extra){post("/api/analytics/event",{visitor_id,session_id,event_name:name,path:location.pathname+location.search,referrer:document.referrer,...extra})}
 function saveCart(){const items=Array.isArray(cart)?cart:[];const shippingPrice=Number(selectedShippingOption?.price||0);if(!items.length)return;const subtotal=items.reduce((s,i)=>s+Number(i.price||0)*Number(i.quantity||1),0);post("/api/analytics/cart",{visitor_id,session_id,items:items.map(i=>({id:i.id,product_id:i.id,product_name:i.name,sku:i.sku,variant_id:i.variant_id||null,variant_color:i.variant_color||i.color||null,quantity:i.quantity,unit_price:i.price,total_price:Number(i.price||0)*Number(i.quantity||1)})),subtotal,shipping:shippingPrice,total:subtotal+shippingPrice,customer_name:document.getElementById("customerName")?.value||"",customer_email:document.getElementById("customerEmail")?.value||"",customer_phone:document.getElementById("customerPhone")?.value||""})}
 window.monteAnalytics={track,saveCart};
 window.addEventListener("load",()=>track("page_view"));
 setInterval(saveCart,30000);
 document.addEventListener("click",e=>{const el=e.target.closest?.("[data-product-id]");if(el)track("view_product",{product_id:el.dataset.productId,product_name:el.dataset.productName||null})});
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
    const totals = summary || (() => {
        const subtotal = getCartSubtotal();
        const shipping = getShippingValue();
        const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value || selectedPaymentMethod || "pix";
        const pixDiscount = paymentMethod === "pix"
            ? cart.reduce((sum, item) => {
                const unitCents = Math.round(Number(item.price || 0) * 100);
                return sum + (unitCents - Math.round(unitCents * 0.95)) * Number(item.quantity || 0);
            }, 0) / 100
            : 0;
        return { subtotal, shipping, pixDiscount, total: Number((subtotal - pixDiscount + shipping).toFixed(2)), paymentMethod };
    })();

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
    }

    setNoteText("noteShipping", selectedShippingOption ? `${selectedShippingOption.name} · ${formatPrice(totals.shipping)}` : "");
    const discountRow = document.getElementById("noteDiscountRow");
    if (discountRow) discountRow.hidden = !(totals.pixDiscount > 0);
    setNoteText("noteDiscount", totals.pixDiscount > 0 ? "-" + formatPrice(totals.pixDiscount) : "");
    setNoteText("notePayment", totals.paymentMethod === "pix" ? "Pix · 5% off nas peças" : "Cartão de crédito");
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

const CHECKOUT_RULES = {
    customerName: v => v.trim().split(/\s+/).filter(Boolean).length >= 2,
    customerEmail: v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()),
    customerPhone: v => v.replace(/\D/g, "").length >= 10,
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
    if (!field) return;
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

function renderCheckoutExtras({ subtotal, shipping, pixDiscount, paymentMethod }) {
    const potential = cart.reduce((sum, item) => {
        const unitCents = Math.round(Number(item.price || 0) * 100);
        return sum + (unitCents - Math.round(unitCents * 0.95)) * Number(item.quantity || 0);
    }, 0) / 100;

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

    const hint = document.getElementById("checkoutBarHint");
    if (hint) {
        const parts = [];
        if (pixDiscount > 0) parts.push(`${formatPrice(pixDiscount)} de desconto no Pix`);
        parts.push(selectedShippingOption ? `frete ${formatPrice(shipping)}` : "frete a calcular");
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
                const d = phone.value.replace(/\D/g, "").slice(0, 11);
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
    browseNovidades, changeQuantity, checkout, closeCart, closeCartOutside, closeMobileMenu,
    closeProductImageLightbox, closeProductModal, closeSearch, goToNovidades, navigateProductLightbox,
    nextCategoryPage, nextCollectionPage, nextNewPage, nextSalePage, nextSlide, openCart, openSearch,
    openWhatsAppReservation, previousCategoryPage, previousCollectionPage, previousNewPage,
    previousSalePage, previousSlide, removeFromCart, toggleMobileMenu, updateItemQuantity
});

document.getElementById("searchInput")?.addEventListener("input", () => searchProducts());
document.getElementById("newsletterForm")?.addEventListener("submit", event => subscribeNewsletter(event));
document.getElementById("carouselSlides")?.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        goToNovidades(event);
    }
});


/* =====================================================
   GOOGLE ANALYTICS
   Carrega depois que a página termina de abrir, quando o navegador
   está livre: os visitantes continuam sendo contados e a loja abre
   sem esperar o script do Google.
===================================================== */

(function loadAnalytics() {
    const id = "G-RCG5BX64FG";
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", id, { anonymize_ip: true });
    const inject = () => {
        const script = document.createElement("script");
        script.async = true;
        script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
        document.head.appendChild(script);
    };
    const schedule = () => (window.requestIdleCallback ? requestIdleCallback(inject, { timeout: 4000 }) : setTimeout(inject, 2000));
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
})();
