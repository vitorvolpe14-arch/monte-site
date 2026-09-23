const SUPABASE_URL = "https://uvrhougaurupvkxmezwy.supabase.co";
const SUPABASE_KEY = "sb_publishable_oML0grXREF2gHg7WNIxNlA_BYMV9D1V";
const supabaseClient = window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

let products = [];

async function loadProductsFromDatabase() {
    if (!supabaseClient) {
        console.error("Supabase não carregado.");
        return;
    }

    const { data, error } = await supabaseClient
        .from("products")
        .select("*, product_variants(*)")
        .eq("active", true)
        .order("created_at", { ascending: false });

    if (error) {
        console.error("Erro ao carregar produtos:", error);
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

const COLLECTION_VISIBLE_COUNT = 5;
const COLLECTION_STEP = 4;
let collectionProducts = [];
let currentCollectionIndex = 0;


/* =====================================================
   FORMATAÇÃO DE PREÇO
===================================================== */

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

    card.innerHTML = `

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
                src="${image}"
                alt="${product.name}"
                loading="lazy"
            >

        </div>

        <div class="product-info">

            <div class="product-name">
                ${product.name}
            </div>

            <div class="product-price">
                ${priceHTML}
            </div>

        </div>

    `;

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

    const newContainer =
        document.getElementById("newProducts");

    const saleContainer =
        document.getElementById("saleProducts");


    newContainer.innerHTML = "";

    saleContainer.innerHTML = "";


    renderCollectionProducts(products);


    products.forEach(product => {

        if (product.newProduct) {

            newContainer.appendChild(
                createProductCard(product)
            );

        }


        if (product.sale) {

            saleContainer.appendChild(
                createProductCard(product)
            );

        }

    });

}


function renderCollectionProducts(list) {

    collectionProducts = Array.isArray(list)
        ? list
        : [];

    currentCollectionIndex = 0;

    renderCollectionPage();

}


function renderCollectionPage() {

    const container =
        document.getElementById("allProducts");

    const previousButton =
        document.querySelector(".collection-prev");

    const nextButton =
        document.querySelector(".collection-next");


    if (!container) return;


    container.innerHTML = "";


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
        offset < Math.min(COLLECTION_VISIBLE_COUNT, total);
        offset++
    ) {

        const product =
            collectionProducts[(start + offset) % total];

        container.appendChild(
            createProductCard(product)
        );

    }


    const hasCarousel =
        total > COLLECTION_VISIBLE_COUNT;


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

    if (collectionProducts.length <= COLLECTION_VISIBLE_COUNT) {
        return;
    }


    currentCollectionIndex =
        (currentCollectionIndex + COLLECTION_STEP) %
        collectionProducts.length;

    renderCollectionPage();

}


function previousCollectionPage() {

    if (collectionProducts.length <= COLLECTION_VISIBLE_COUNT) {
        return;
    }


    currentCollectionIndex =
        (currentCollectionIndex - COLLECTION_STEP +
            collectionProducts.length) %
        collectionProducts.length;

    renderCollectionPage();

}


/* =====================================================
   FILTRO
===================================================== */

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

function openProductModal(productId) {

    selectedProduct =
        products.find(
            product => product.id === productId
        );


    selectedVariant = null;
    selectedQuantity = 1;

    const activeVariants = (selectedProduct.variants || []).filter(v => v.active !== false);
    const availableVariants = activeVariants.filter(v => Number(v.stock || 0) > 0);
    if (availableVariants.length) {
        selectedVariant = availableVariants[0];
    } else if ((selectedProduct.stock || 0) <= 0) {
        showToast("Este produto está esgotado no momento.");
        return;
    }

    document.getElementById("quantity")
        .textContent = selectedQuantity;


    document.getElementById("modalName")
        .textContent = selectedProduct.name;


    document.getElementById("modalCategory")
        .textContent =
        selectedProduct.category.toUpperCase();


    document.getElementById("modalDescription")
        .textContent =
        selectedProduct.description;


    let priceHTML =
        formatPrice(selectedProduct.price);


    if (
        selectedProduct.sale &&
        selectedProduct.oldPrice
    ) {

        priceHTML = `

            <span class="old-price">
                ${formatPrice(
                    selectedProduct.oldPrice
                )}
            </span>

            <span class="sale-price">
                ${formatPrice(
                    selectedProduct.price
                )}
            </span>

        `;

    }


    document.getElementById("modalPrice")
        .innerHTML = priceHTML;

    const variantSelector = document.getElementById("variantSelector");
    const variantOptions = document.getElementById("variantOptions");
    if (variantSelector && variantOptions) {
        const activeVariants = (selectedProduct.variants || []).filter(v => v.active !== false);
        if (activeVariants.length) {
            variantSelector.style.display = "block";
            variantOptions.innerHTML = "";
            activeVariants.forEach((variant, index) => {
                const button = document.createElement("button");
                button.type = "button";
                const variantAvailable = Number(variant.stock || 0) > 0;
                button.className = "variant-option" + (index === 0 && variantAvailable ? " active" : "") + (variantAvailable ? "" : " unavailable");
                button.textContent = variantAvailable ? variant.color : variant.color + " — esgotado";
                button.disabled = !variantAvailable;
                button.addEventListener("click", () => {
                    if (!variantAvailable) {
                        showToast("Esta cor está esgotada.");
                        return;
                    }
                    selectedVariant = variant;
                    selectedQuantity = 1;
                    document.querySelectorAll(".variant-option").forEach(b => b.classList.remove("active"));
                    button.classList.add("active");
                    document.getElementById("quantity").textContent = "1";
                });
                variantOptions.appendChild(button);
            });
        } else {
            variantSelector.style.display = "none";
            variantOptions.innerHTML = "";
        }
    }

    renderGallery();


    document.getElementById("productModal")
        .classList.add("active");


    document.body.style.overflow = "hidden";

}


/* =====================================================
   GALERIA
===================================================== */

function renderGallery() {

    const mainImage =
        document.getElementById(
            "modalMainImage"
        );


    const thumbnails =
        document.getElementById(
            "galleryThumbnails"
        );


    mainImage.src =
        selectedProduct.images[0];


    thumbnails.innerHTML = "";


    selectedProduct.images.forEach(
        (image, index) => {

            const thumbnail =
                document.createElement("img");


            thumbnail.src = image;

            thumbnail.className =
                "gallery-thumbnail";


            if (index === 0) {

                thumbnail.classList.add(
                    "active"
                );

            }


            thumbnail.addEventListener(
                "click",
                () => {

                    mainImage.src = image;


                    document
                        .querySelectorAll(
                            ".gallery-thumbnail"
                        )
                        .forEach(
                            item =>
                                item.classList
                                    .remove("active")
                        );


                    thumbnail.classList.add(
                        "active"
                    );

                }
            );


            thumbnails.appendChild(
                thumbnail
            );

        }
    );

}


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


    container.innerHTML = "";


    if (cart.length === 0) {

        container.innerHTML = `

            <div class="empty-cart">

                Seu carrinho está vazio.

            </div>

        `;

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


        element.innerHTML = `

            <img
                src="${item.images[0]}"
                alt="${item.name}"
            >


            <div>

                <div class="cart-item-name">
                    ${item.name}${item.variant_color ? " · " + item.variant_color : ""}
                </div>

                <div class="cart-item-price">
                    ${formatPrice(
                        item.price
                    )}
                </div>


                <div class="cart-quantity">

                    <button
                        onclick="updateItemQuantity(${index}, -1)">

                        −

                    </button>


                    <span>
                        ${item.quantity}
                    </span>


                    <button
                        onclick="updateItemQuantity(${index}, 1)">

                        +

                    </button>

                </div>

            </div>


            <button
                class="cart-item-remove"
                onclick="removeFromCart(${index})">

                REMOVER

            </button>

        `;


        container.appendChild(element);

    });


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

}


function closeCart() {

    document
        .getElementById("cartOverlay")
        .classList.remove("active");

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


function getSelectedPaymentMethod() {
    return document.querySelector('input[name="paymentMethod"]:checked')?.value || "pix";
}

function selectPaymentMethod(method) {
    selectedPaymentMethod = method === "card" ? "card" : "pix";

    document.querySelectorAll(".payment-option").forEach(option => {
        const input = option.querySelector('input[name="paymentMethod"]');
        option.classList.toggle("selected", input?.value === selectedPaymentMethod);
    });

    updatePaymentSummary();
}

function getCartSubtotal() {
    return cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
}

function updatePaymentSummary(subtotal = getCartSubtotal()) {
    const shipping = getShippingValue();
    const pixTotal = Number((subtotal * 0.95 + shipping).toFixed(2));
    const cardTotal = Number((subtotal + shipping).toFixed(2));
    const pixElement = document.getElementById("pixTotal");
    const cardElement = document.getElementById("cardTotal");
    const checkoutElement = document.getElementById("checkoutTotal");
    if (pixElement) pixElement.textContent = formatPrice(pixTotal);
    if (cardElement) cardElement.textContent = formatPrice(cardTotal);
    if (checkoutElement) checkoutElement.textContent = formatPrice(selectedPaymentMethod === "pix" ? pixTotal : cardTotal);
}

function getShippingValue() {
    return Number(selectedShippingOption?.price || 0);
}

function renderShippingOptions() {
    const container = document.getElementById("shippingOptions");
    if (!container) return;
    container.innerHTML = "";
    shippingOptions.forEach(option => {
        const label = document.createElement("label");
        label.className = "shipping-option" + (selectedShippingOption?.id === option.id ? " selected" : "");
        const min = Number(option.delivery_min_days || 0);
        const max = Number(option.delivery_max_days || 0);
        const days = min && max && min !== max ? `${min} a ${max} dias úteis` : (max || option.delivery_days) ? `${max || option.delivery_days} dias úteis` : "Prazo informado";
        label.innerHTML = `<input type="radio" name="shippingMethod" value="${String(option.id).replace(/"/g, "&quot;")}" ${selectedShippingOption?.id === option.id ? "checked" : ""}><span class="shipping-option-info"><strong>${option.name}</strong><small>${days}</small></span><strong class="shipping-option-price">${formatPrice(option.price)}</strong>`;
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
        const local = city === "FORTALEZA" ? {id:"monte-fortaleza",name:"Entrega MONTÊ — Fortaleza",price:15,delivery_days:2} : {id:"monte-regiao-metropolitana",name:"Entrega MONTÊ — Região Metropolitana",price:20,delivery_days:3};
        shippingOptions = [local]; selectedShippingOption = local;
        shippingValueElement.textContent = formatPrice(local.price);
        renderShippingOptions(); updatePaymentSummary(); return;
    }
    shippingValueElement.textContent = "Calculando...";
    if (optionsContainer) optionsContainer.innerHTML = '<div class="shipping-loading">Consultando opções de entrega...</div>';
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
        if (optionsContainer) optionsContainer.innerHTML = `<div class="shipping-error">${error.message || "Não foi possível calcular o frete."}</div>`;
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

    // 1. Verifica carrinho
    if (!Array.isArray(cart) || cart.length === 0) {

        showToast("Seu carrinho está vazio.");

        return;
    }


    // 2. Captura os dados
    const name =
        document.getElementById("customerName")?.value.trim();

    const email =
        document.getElementById("customerEmail")?.value.trim();

    const phone =
        document.getElementById("customerPhone")?.value.trim();

    const cpf =
        document.getElementById("customerCpf")?.value.trim();

    const cep =
        document.getElementById("customerCep")?.value.trim();

    const street =
        document.getElementById("customerStreet")?.value.trim();

    const number =
        document.getElementById("customerNumber")?.value.trim();

    const complement =
        document.getElementById("customerComplement")?.value.trim();

    const neighborhood =
        document.getElementById("customerNeighborhood")?.value.trim();

    const city =
        document.getElementById("customerCity")?.value.trim();

    const state =
        document.getElementById("customerState")?.value.trim().toUpperCase();


    // 3. Validação
    if (
        !name ||
        !email ||
        !phone ||
        !cpf ||
        !cep ||
        !street ||
        !number ||
        !neighborhood ||
        !city ||
        !state
    ) {

        showToast(
            "Preencha todos os dados do cliente e da entrega."
        );

        return;
    }


    const cpfDigits = cpf.replace(/\D/g, "");

    if (cpfDigits.length !== 11) {
        showToast("Informe um CPF válido com 11 dígitos.");
        return;
    }

    // 4. Frete
    // Fortaleza capital: R$ 15,00.
    // Outras localidades aguardam cotação de transportadora no backend.
    const shipping = getShippingValue();


    // 5. Monta os produtos
    const items = cart
        .map(item => {

            const price =
                Number(item.price);

            const quantity =
                Number(item.quantity) || 1;


            if (
                !Number.isFinite(price) ||
                price <= 0
            ) {
                return null;
            }


            return {

                quantity: quantity,

                price: price,

                description: String(
                    item.name || "Produto MONTÊ"
                ),

                sku: item.variant_sku || item.sku ? String(item.variant_sku || item.sku) : null,
                id: item.id || item.product_id || null,
                product_id: item.id || item.product_id || null,
                variant_id: item.variant_id || null,
                variant_color: item.variant_color || null

            };

        })
        .filter(Boolean);


    // 6. O backend valida novamente a modalidade e o valor do frete.
    if (!selectedShippingOption) {
        showToast("Selecione uma opção de frete antes de finalizar a compra.");
        return;
    }
    const shippingServiceId = String(selectedShippingOption.id || "");

    // Segurança
    if (items.length === 0) {

        showToast(
            "Não foi possível identificar os produtos do carrinho."
        );

        return;
    }


    // 7. Desabilita o botão durante o processamento
    const checkoutButton =
        document.querySelector(".checkout-button");


    if (checkoutButton) {

        checkoutButton.disabled = true;

        checkoutButton.textContent =
            "PREPARANDO PAGAMENTO...";

    }


    showToast(
        "Preparando seu pagamento..."
    );


    try {

        // 8. Envia para o backend do Render
        const response =
            await fetch(
                "/api/criar-checkout",
                {

                    method: "POST",

                    headers: {

                        "Content-Type":
                            "application/json",

                        "Accept":
                            "application/json"

                    },

                    body: JSON.stringify({

                        items: items,

                        payment_method: getSelectedPaymentMethod(),

                        shipping_service_id: shippingServiceId,

                        customer: {

                            name: name,

                            email: email,

                            phone: phone,

                            whatsapp_updates: Boolean(
                                document.getElementById("whatsappUpdates")?.checked
                            ),

                            cpf: cpfDigits,

                            address: {

                                cep: cep,

                                street: street,

                                number: number,

                                complement:
                                    complement || "",

                                neighborhood:
                                    neighborhood,

                                city: city,

                                state: state

                            }

                        }

                    })

                }
            );


        // 9. Tenta ler a resposta como texto primeiro
        // Isso evita quebrar quando o Render retorna HTML
        const responseText =
            await response.text();


        let data = null;


        try {

            data =
                JSON.parse(responseText);

        } catch (jsonError) {

            console.error(
                "Resposta não é JSON:",
                responseText
            );

        }


        // 10. Se o servidor respondeu erro
        if (!response.ok) {

            console.error(
                "Erro HTTP do backend:",
                response.status,
                responseText
            );


            throw new Error(
                data?.message ||
                `Erro do servidor (${response.status}).`
            );
        }


        // 11. Procura a URL do checkout
        const checkoutUrl =
            data?.url ||
            data?.checkoutUrl ||
            data?.paymentUrl ||
            data?.redirectUrl;


        if (!checkoutUrl) {

            console.error(
                "Backend não retornou URL:",
                data
            );


            throw new Error(
                data?.message ||
                "O servidor não retornou o link da InfinitePay."
            );
        }


        // 12. Confirma que parece ser uma URL válida
        let validUrl;

        try {

            validUrl =
                new URL(checkoutUrl);

        } catch {

            throw new Error(
                "O servidor retornou um link de pagamento inválido."
            );
        }


        // 13. Fecha o carrinho
        closeCart();


        // 14. Abre a InfinitePay
        window.location.assign(
            validUrl.href
        );


    } catch (error) {

        console.error(
            "ERRO COMPLETO NO CHECKOUT:",
            error
        );


        showToast(
            error.message ||
            "Não foi possível abrir o pagamento."
        );


        // Reativa o botão
        if (checkoutButton) {

            checkoutButton.disabled = false;

            checkoutButton.textContent =
                "FINALIZAR COMPRA";

        }

    }

}


/* =====================================================
   CARROSSEL
===================================================== */

const slides =
    document.querySelectorAll(
        ".slide"
    );


const dotsContainer =
    document.getElementById(
        "carouselDots"
    );


slides.forEach(
    (_, index) => {

        const dot =
            document.createElement(
                "button"
            );


        dot.className =
            "carousel-dot";


        if (index === 0) {

            dot.classList.add(
                "active"
            );

        }


        dot.addEventListener(
            "click",
            () => {

                currentSlide =
                    index;

                showSlide(
                    currentSlide
                );

            }
        );


        dotsContainer.appendChild(
            dot
        );

    }
);


function showSlide(index) {

    slides.forEach(
        slide =>
            slide.classList
                .remove("active")
    );


    document
        .querySelectorAll(
            ".carousel-dot"
        )
        .forEach(
            dot =>
                dot.classList
                    .remove("active")
        );


    slides[index]
        .classList
        .add("active");


    document
        .querySelectorAll(
            ".carousel-dot"
        )[index]
        .classList
        .add("active");

}


function nextSlide() {

    currentSlide =
        (currentSlide + 1)
        % slides.length;


    showSlide(
        currentSlide
    );

}


function previousSlide() {

    currentSlide =
        (currentSlide - 1 +
            slides.length)
        % slides.length;


    showSlide(
        currentSlide
    );

}


/*
   CARROSSEL AUTOMÁTICO

   20 SEGUNDOS
*/

setInterval(
    nextSlide,
    20000
);


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


    container.innerHTML = "";


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

function subscribeNewsletter(event) {

    event.preventDefault();


    showToast(
        "Cadastro realizado com sucesso."
    );


    event.target.reset();

}


/* =====================================================
   MENU MOBILE
===================================================== */

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
