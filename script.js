/* =====================================================
   PRODUTOS
===================================================== */

/*
    AQUI VOCÊ CADASTRA OS PRODUTOS DA MONTÊ.

    Cada produto pode ter QUANTAS FOTOS você quiser.

    Exemplo:

    images: [
        "assets/produtos/oslo-1.jpg",
        "assets/produtos/oslo-2.jpg",
        "assets/produtos/oslo-3.jpg"
    ]
*/


const products = [

    {
        id: "TESTE",
        name: "PRODUTO TESTE",
        category: "teste",
        price: 0.01,
        description: "Produto temporário para teste de checkout.",
        images: [
            "data:image/svg+xml;charset=UTF-8," +
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
                          font-size="28"
                          letter-spacing="4"
                          fill="#222">
                        TESTE
                    </text>
                </svg>
            `)
        ],
        newProduct: true,
        sale: false,
        sku: "TESTE001"
    },

    {
        id: 1,
        name: "Bag Oslo",
        category: "bolsas",
        price: 699,
        description: "Bolsa em couro croco legítimo, com design marcante e acabamento premium.",
        images: [
            "assets/Oslo1.jpg,jpeg",
            "assets/Oslo 2.jpg",
            "assets/Oslo 3.jpg"
        ],
        newProduct: true,
        sale: false,
        sku: "BGSLO"
    },

    {
        id: 2,
        name: "Bag Vienna",
        category: "bolsas",
        price: 499,
        description: "Bolsa de design sofisticado e acabamento premium.",
        images: [
            "assets/Vienna 1.jpg",
            "assets/Vienna 2.jpg",
            "assets/Vienna 3.jpg"
        ],
        newProduct: true,
        sale: false,
        sku: "VIENNA"
    },

    {
        id: 3,
        name: "Bag Milão",
        category: "bolsas",
        price: 499,
        description: "Bolsa inspirada no estilo italiano, com acabamento elegante e contemporâneo.",
        images: [
            "assets/Milao 1.jpg",
            "assets/Milao 2.jpg"
        ],
        newProduct: false,
        sale: false,
        sku: "BGMILA"
    },

    {
        id: 4,
        name: "Bag Cannes",
        category: "bolsas",
        price: 579,
        description: "Bolsa com design marcante e acabamento premium.",
        images: [
            "assets/Cannes7.JPG.jpeg",
            "assets/Cannes1.JPG.jpeg",
            "assets/Cannes2.JPG.jpeg",
            "assets/Cannes3.JPG.jpeg",
            "assets/Cannes4.JPG.jpeg",
            "assets/Cannes5.JPG.jpeg",
            "assets/Cannes6.JPG.jpeg"
        ],
        newProduct: false,
        sale: false,
        sku: "BAGCNS"
    },

    {
        id: 5,
        name: "Bag Louvre",
        category: "bolsas",
        price: 519,
        description: "Bolsa de linhas sofisticadas e acabamento premium.",
        images: [
            "assets/Louvre1.jpg",
            "assets/Louvre 2.jpg",
            "assets/Louvre 3.jpg"
        ],
        newProduct: false,
        sale: false,
        sku: "BAGLVR"
    },

    {
        id: 6,
        name: "Bag Atenas",
        category: "bolsas",
        price: 459,
        description: "Bolsa de design contemporâneo e acabamento premium.",
        images: [
            "assets/Atena 1.jpg",
            "assets/Atena 2.jpg",
            "assets/Atena 3.jpg"
        ],
        newProduct: false,
        sale: false
    },

    {
        id: 7,
        name: "Cinto MONTÊ",
        category: "acessorios",
        price: 229,
        description: "Cinto MONTÊ com acabamento premium.",
        images: [
            "assets/Cinto 1.jpg",
            "assets/Cinto 2.jpg"
        ],
        newProduct: false,
        sale: false
    },

    {
        id: 8,
        name: "Bag Malta",
        category: "bolsas",
        price: 399,
        oldPrice: 499,
        description: "Bolsa com design versátil e acabamento premium.",
        images: [
            "assets/Malta 1.jpg",
            "assets/Malta 2.jpg",
            "assets/Malta 3.jpg"
        ],
        newProduct: false,
        sale: true,
        sku: "MALTAO"
    },

    {
        id: 9,
        name: "Bag Atenas",
        category: "bolsas",
        sku: "IRL01"
    },

    {
        id: 10,
        name: "Bag Austria",
        category: "bolsas",
        sku: "ASTRAO"
    },

    {
        id: 11,
        name: "Bag Berlim",
        category: "bolsas",
        sku: "BERLIM"
    },

    {
        id: 12,
        name: "Bag Charm",
        category: "bolsas",
        sku: "BAGCHR"
    },

    {
        id: 13,
        name: "Bag Coliseu",
        category: "bolsas",
        sku: "COLSUM"
    },

    {
        id: 14,
        name: "Bag Croácia",
        category: "bolsas",
        sku: "CRTIVA"
    },

    {
        id: 15,
        name: "Bag Holanda",
        category: "bolsas",
        sku: "NEDLND"
    },

    {
        id: 16,
        name: "Bag Hungria",
        category: "bolsas",
        sku: "BAGHNG"
    },

    {
        id: 17,
        name: "Bag Ibiza",
        category: "bolsas",
        sku: "IBIZA"
    },

    {
        id: 18,
        name: "Bag Instambul",
        category: "bolsas",
        sku: "INSTAM"
    },

    {
        id: 19,
        name: "Bag Irlanda",
        category: "bolsas"
    },

    {
        id: 20,
        name: "Bag Londres",
        category: "bolsas",
        sku: "LONDON"
    },

    {
        id: 21,
        name: "Bag Louvre Baby",
        category: "bolsas",
        sku: "LVRBBY"
    },

    {
        id: 22,
        name: "Bag Oxford",
        category: "bolsas",
        sku: "OXFORD"
    },

    {
        id: 23,
        name: "Bag Paris",
        category: "bolsas",
        sku: "PARISO"
    },

    {
        id: 24,
        name: "Bag Porto Fino",
        category: "bolsas",
        sku: "PORTFIN"
    },

    {
        id: 25,
        name: "Bag Positano",
        category: "bolsas",
        sku: "PSTANO"
    },

    {
        id: 26,
        name: "Bag Saint-Tropez",
        category: "bolsas",
        sku: "SNTROP"
    },

    {
        id: 27,
        name: "Bag Suecia",
        category: "bolsas",
        sku: "SWESLD"
    },

    {
        id: 28,
        name: "Bag Suíça",
        category: "bolsas",
        sku: "SWZLND"
    },

    {
        id: 29,
        name: "Bag Valencia",
        category: "bolsas",
        sku: "VLNCA10"
    },

    {
        id: 30,
        name: "Bag Versailles",
        category: "bolsas",
        sku: "VERSLL"
    },

    {
        id: 31,
        name: "Bag Versailles Soft",
        category: "bolsas",
        sku: "VERSFT"
    },

    {
        id: 32,
        name: "Bag Zurique",
        category: "bolsas",
        sku: "ZURQUE"
    }

];

/* =====================================================
   ESTADO
===================================================== */

let cart = [];

let selectedProduct = null;

let selectedQuantity = 1;

let currentSlide = 0;


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

    const allContainer =
        document.getElementById("allProducts");

    const newContainer =
        document.getElementById("newProducts");

    const saleContainer =
        document.getElementById("saleProducts");


    allContainer.innerHTML = "";

    newContainer.innerHTML = "";

    saleContainer.innerHTML = "";


    products.forEach(product => {

        allContainer.appendChild(
            createProductCard(product)
        );


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


/* =====================================================
   FILTRO
===================================================== */

function filterProducts(category) {

    const container =
        document.getElementById("allProducts");

    container.innerHTML = "";


    document
        .querySelectorAll(".filter-button")
        .forEach(button => {

            button.classList.remove("active");

        });


    document
        .querySelector(
            `[data-filter="${category}"]`
        )
        .classList.add("active");


    products
        .filter(product => {

            if (category === "all") {

                return true;

            }

            return product.category === category;

        })
        .forEach(product => {

            container.appendChild(
                createProductCard(product)
            );

        });

}


/* =====================================================
   MODAL PRODUTO
===================================================== */

function openProductModal(productId) {

    selectedProduct =
        products.find(
            product => product.id === productId
        );


    selectedQuantity = 1;


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

    selectedQuantity += amount;


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


        const existing =
            cart.find(
                item =>
                    item.id === selectedProduct.id
            );


        if (existing) {

            existing.quantity +=
                selectedQuantity;

        } else {

            cart.push({

                ...selectedProduct,

                quantity:
                    selectedQuantity

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


    cart.forEach(item => {

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
                    ${item.name}
                </div>

                <div class="cart-item-price">
                    ${formatPrice(
                        item.price
                    )}
                </div>


                <div class="cart-quantity">

                    <button
                        onclick="updateItemQuantity(
                            ${item.id},
                            -1
                        )">

                        −

                    </button>


                    <span>
                        ${item.quantity}
                    </span>


                    <button
                        onclick="updateItemQuantity(
                            ${item.id},
                            1
                        )">

                        +

                    </button>

                </div>

            </div>


            <button
                class="cart-item-remove"
                onclick="removeFromCart(
                    ${item.id}
                )">

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

}


/* =====================================================
   QUANTIDADE DO CARRINHO
===================================================== */

function updateItemQuantity(
    productId,
    amount
) {

    const item =
        cart.find(
            item => item.id === productId
        );


    if (!item) return;


    item.quantity += amount;


    if (item.quantity <= 0) {

        cart =
            cart.filter(
                item =>
                    item.id !== productId
            );

    }


    updateCart();

}


/* =====================================================
   REMOVER
===================================================== */

function removeFromCart(productId) {

    cart =
        cart.filter(
            item =>
                item.id !== productId
        );


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


function getShippingValue() {

    const cityInput =
        document.getElementById("customerCity");

    const stateInput =
        document.getElementById("customerState");

    if (!cityInput || !stateInput) {
        return null;
    }

    const city =
        normalizeCity(cityInput.value);

    const state =
        stateInput.value
            .trim()
            .toUpperCase();

    if (
        city === "FORTALEZA" &&
        state === "CE"
    ) {

        return 15;

    }

    if (
        state === "CE" &&
        metropolitanCities.includes(city)
    ) {

        return 20;

    }

    return null;

}


/* =====================================================
   ATUALIZAR FRETE
===================================================== */

function updateShipping() {

    const shippingValueElement =
        document.getElementById(
            "shippingValue"
        );

    if (!shippingValueElement) {
        return;
    }

    const shipping =
        getShippingValue();

    if (shipping === 15) {

        shippingValueElement.textContent =
            "R$ 15,00";

    } else if (shipping === 20) {

        shippingValueElement.textContent =
            "R$ 20,00";

    } else {

        shippingValueElement.textContent =
            "Informe cidade e estado";

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
        !cep ||
        !street ||
        !number ||
        !neighborhood ||
        !city ||
        !state
    ) {

        showToast(
            "Preencha todos os dados de entrega."
        );

        return;
    }


    // 4. Calcula frete
    const shipping =
        getShippingValue();


    if (shipping === null) {

        showToast(
            "Informe uma cidade válida de Fortaleza ou região metropolitana."
        );

        return;
    }


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

                sku:
                    item.sku
                    ? String(item.sku)
                    : null

            };

        })
        .filter(Boolean);


    // 6. Adiciona frete
    items.push({

        quantity: 1,

        price: Number(shipping),

        description: "Frete de entrega",

        sku: "FRETE"

    });


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
                "https://monte-site-itjk.onrender.com/api/criar-checkout",
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

                        customer: {

                            name: name,

                            email: email,

                            phone: phone,

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
    () => {

        renderProducts();

        loadCart();

    }
);
