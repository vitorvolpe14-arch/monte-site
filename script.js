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
        id: 1,

        name: "Bag Oslo",

        category: "bolsas",

        price: 499,

        description:
            "Bolsa em couro croco legítimo, com acabamento marcante e design contemporâneo.",

        images: [
            "assets/produtos/oslo-1.jpg",
            "assets/produtos/oslo-2.jpg",
            "assets/produtos/oslo-3.jpg"
        ],

        newProduct: true,

        sale: false
    },


    {
        id: 2,

        name: "Bag Vienna",

        category: "bolsas",

        price: 549,

        description:
            "Design estruturado e acabamento cuidadosamente desenvolvido para compor diferentes produções.",

        images: [
            "assets/produtos/vienna-1.jpg",
            "assets/produtos/vienna-2.jpg",
            "assets/produtos/vienna-3.jpg"
        ],

        newProduct: true,

        sale: false
    },


    {
        id: 3,

        name: "Bag Milão",

        category: "bolsas",

        price: 499,

        description:
            "Uma peça versátil da coleção MONTÊ.",

        images: [
            "assets/produtos/milao-1.jpg",
            "assets/produtos/milao-2.jpg"
        ],

        newProduct: true,

        sale: false
    },


    {
        id: 4,

        name: "Bag Cannes",

        category: "bolsas",

        price: 579,

        description:
            "Bolsa com acabamento premium e proporções pensadas para o uso diário.",

        images: [
            "assets/produtos/cannes-1.jpg",
            "assets/produtos/cannes-2.jpg"
        ],

        newProduct: false,

        sale: false
    },


    {
        id: 5,

        name: "Bag Louvre",

        category: "bolsas",

        price: 519,

        description:
            "Design inspirado na arquitetura e estética europeia.",

        images: [
            "assets/produtos/louvre-1.jpg",
            "assets/produtos/louvre-2.jpg"
        ],

        newProduct: false,

        sale: false
    },


    {
        id: 6,

        name: "Bag Atena",

        category: "bolsas",

        price: 459,

        description:
            "Uma bolsa compacta desenvolvida para acompanhar diferentes momentos.",

        images: [
            "assets/produtos/atena-1.jpg",
            "assets/produtos/atena-2.jpg"
        ],

        newProduct: false,

        sale: false
    },


    {
        id: 7,

        name: "Cinto MONTÊ",

        category: "acessorios",

        price: 229,

        description:
            "Cinto fino com acabamento premium.",

        images: [
            "assets/produtos/cinto-1.jpg",
            "assets/produtos/cinto-2.jpg"
        ],

        newProduct: true,

        sale: false
    },


    /*
       PRODUTO EM SALE
    */

    {
        id: 8,

        name: "Bag Malta",

        category: "bolsas",

        price: 399,

        oldPrice: 499,

        description:
            "Peça selecionada da coleção MONTÊ.",

        images: [
            "assets/produtos/malta-1.jpg",
            "assets/produtos/malta-2.jpg"
        ],

        newProduct: false,

        sale: true
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
            formatPrice(product.price);

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
                src="${product.images[0]}"
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
   CHECKOUT
===================================================== */

function checkout() {

    if (cart.length === 0) {

        showToast(
            "Seu carrinho está vazio."
        );

        return;

    }


    /*
       =================================================
       INTEGRAÇÃO INFINITEPAY
       =================================================

       AQUI SERÁ INSERIDA A INTEGRAÇÃO
       DO CHECKOUT DA SUA CONTA INFINITEPAY.

       NÃO COLOQUE SUA SENHA OU TOKEN
       DIRETAMENTE NESTE ARQUIVO.

       O ideal é enviar o pedido para
       seu backend/API e criar o checkout
       de forma segura.

    */


    const order = {

        items: cart.map(item => ({

            id: item.id,

            name: item.name,

            quantity: item.quantity,

            price: item.price

        })),

        total: cart.reduce(
            (total, item) =>
                total +
                item.price *
                item.quantity,
            0
        )

    };


    console.log(
        "Pedido preparado:",
        order
    );


    /*
       EXEMPLO DO FLUXO:

       1. Cliente clica em FINALIZAR COMPRA.

       2. Seu site envia "order" para
          seu servidor.

       3. Seu servidor cria o checkout
          através da integração InfinitePay.

       4. InfinitePay retorna a URL
          de pagamento.

       5. Cliente é redirecionada para
          o checkout.

    */


    showToast(
        "Checkout preparado. Configure a integração InfinitePay."
    );

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