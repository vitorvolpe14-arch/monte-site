const express = require("express");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;

/* =====================================================
   CONFIGURAÇÕES
===================================================== */

const SITE_URL =
    process.env.SITE_URL ||
    "https://monte-site-itjk.onrender.com";

const INFINITEPAY_API =
    "https://api.checkout.infinitepay.io/links";

const INFINITEPAY_HANDLE =
    process.env.INFINITEPAY_HANDLE ||
    "monte-64839705-0z9";

/* =====================================================
   MIDDLEWARES
===================================================== */

app.use(
    cors({
        origin: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type"]
    })
);

app.options("*", cors());

app.use(express.json());

/* =====================================================
   ARQUIVOS DO SITE
===================================================== */

app.use(
    express.static(
        path.join(__dirname, "..")
    )
);

/* =====================================================
   TESTE DO SERVIDOR
===================================================== */

app.get("/", (req, res) => {
    res.sendFile(
        path.join(
            __dirname,
            "..",
            "index.html"
        )
    );
});

/* =====================================================
   ROTAS DO OLIST
===================================================== */

app.post("/olist/produtos", (req, res) => {
    console.log(
        "📦 Atualização de produto recebida do Olist:"
    );

    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

app.post("/olist/estoque", (req, res) => {
    console.log(
        "📊 Atualização de estoque recebida do Olist:"
    );

    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

app.post("/olist/precos", (req, res) => {
    console.log(
        "💰 Atualização de preço recebida do Olist:"
    );

    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

app.post("/olist/pedidos/status", (req, res) => {
    console.log(
        "🛍️ Atualização de pedido recebida do Olist:"
    );

    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

app.post("/olist/rastreio", (req, res) => {
    console.log(
        "🚚 Atualização de rastreio recebida do Olist:"
    );

    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

app.post("/olist/notas", (req, res) => {
    console.log(
        "🧾 Atualização de nota fiscal recebida do Olist:"
    );

    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

/* =====================================================
   INFINITEPAY
   CRIAR CHECKOUT
===================================================== */

app.post(
    "/api/criar-checkout",
    async (req, res) => {

        try {

            console.log(
                "🛒 Solicitação de checkout recebida"
            );

            const {
                items,
                customer
            } = req.body || {};

            /* -----------------------------------------
               VALIDAÇÃO DO CARRINHO
            ----------------------------------------- */

            if (
                !Array.isArray(items) ||
                items.length === 0
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Carrinho vazio."
                });

            }

            /* -----------------------------------------
               VALIDAÇÃO DO CLIENTE
            ----------------------------------------- */

            if (
                !customer ||
                !customer.name ||
                !customer.email ||
                !customer.phone
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Dados do cliente incompletos."
                });

            }

            /* -----------------------------------------
               NORMALIZA PRODUTOS
            ----------------------------------------- */

            const infinitePayItems =
                items
                    .map((item) => {

                        const quantity =
                         Number(
                              item.quantity
                            ) || 1;

                        const price =
                            Number(
                                item.price
                            );

                        const description =
                            String(
                                item.description ||
                                "Produto MONTÊ"
                            );

                        if (
                            !Number.isFinite(price) ||
                            price <= 0
                        ) {
                            return null;
                        }

                        if (
                            !Number.isFinite(quantity) ||
                            quantity <= 0
                        ) {
                            return null;
                        }

                        return {
                            quantity:
                                quantity,

                            price:
                                Math.round(
                                    price * 100
                                ),

                            description:
                                description
                        };

                    })
                    .filter(Boolean);

            /* -----------------------------------------
               CONFIRMA PRODUTOS VÁLIDOS
            ----------------------------------------- */

            if (
                infinitePayItems.length === 0
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Nenhum produto válido foi encontrado."
                });

            }

            /* -----------------------------------------
               ORDER NSU
            ----------------------------------------- */

            const orderNsu =
                `MONTE-${Date.now()}`;

            /* -----------------------------------------
               PAYLOAD INFINITEPAY
            ----------------------------------------- */

            const payload = {

                handle:
                    INFINITEPAY_HANDLE,

                order_nsu:
                    orderNsu,

                redirect_url:
                    `${SITE_URL}/pagamento-sucesso`,
                    
                webhook_url:
                    `${SITE_URL}/webhook-infinitepay`,    

                items:
                    infinitePayItems,

                customer: {
                    name:
                        String(
                            customer.name
                        ),

                    email:
                        String(
                            customer.email
                        ),

                    phone_number:
                        String(
                            customer.phone
                        )
                }

            };

            /* -----------------------------------------
               ENDEREÇO
            ----------------------------------------- */

            if (
                customer.address
            ) {

                payload.address = {

                    cep:
                        customer.address.cep ||
                        "",

                    street:
                        customer.address.street ||
                        "",

                    neighborhood:
                        customer.address.neighborhood ||
                        "",

                    number:
                        customer.address.number ||
                        "",

                    complement:
                        customer.address.complement ||
                        ""

                };

            }

            console.log(
                "📤 Enviando checkout para InfinitePay..."
            );

            console.log(
                "Order NSU:",
                orderNsu
            );

            /* -----------------------------------------
               CHAMADA REAL DA INFINITEPAY
            ----------------------------------------- */

            const response =
                await fetch(
                    INFINITEPAY_API,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",

                            "Accept":
                                "application/json"
                        },

                        body:
                            JSON.stringify(
                                payload
                            )
                    }
                );

            /* -----------------------------------------
               LÊ RESPOSTA
            ----------------------------------------- */

            const responseText =
                await response.text();

            let data;

            try {

                data =
                    JSON.parse(
                        responseText
                    );

            } catch {

                data = {
                    raw:
                        responseText
                };

            }

            /* -----------------------------------------
               ERRO DA INFINITEPAY
            ----------------------------------------- */

            if (
                !response.ok
            ) {

                console.error(
                    "❌ InfinitePay respondeu com erro"
                );

                console.error(
                    "Status:",
                    response.status
                );

                console.error(
                    "Resposta:",
                    data
                );

                return res.status(
                    response.status
                ).json({

                    success: false,

                    message:
                        "A InfinitePay recusou a criação do checkout.",

                    error:
                        data

                });

            }

            /* -----------------------------------------
               VERIFICA URL
            ----------------------------------------- */

            if (
                !data ||
                !data.url
            ) {

                console.error(
                    "❌ InfinitePay não retornou URL"
                );

                console.error(
                    data
                );

                return res.status(502).json({

                    success: false,

                    message:
                        "A InfinitePay não retornou o link de pagamento.",

                    error:
                        data

                });

            }

            /* -----------------------------------------
               SUCESSO
            ----------------------------------------- */

            console.log(
                "✅ Checkout InfinitePay criado"
            );

            console.log(
                "URL recebida com sucesso"
            );

            return res.status(200).json({

                success: true,

                url:
                    data.url,

                order_nsu:
                    orderNsu

            });

        } catch (error) {

            console.error(
                "❌ ERRO INTERNO NO CHECKOUT:"
            );

            console.error(
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "Erro interno ao criar checkout.",

                error:
                    process.env.NODE_ENV ===
                    "development"
                        ? error.message
                        : undefined

            });

        }

    }
);

/* =====================================================
   PÁGINA DE SUCESSO
===================================================== */

app.get(
    "/pagamento-sucesso",
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "..",
                "index.html"
            )
        );

    }
);

/* =====================================================
   INICIAR SERVIDOR
===================================================== */

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 Backend MONTÊ rodando na porta ${PORT}`
        );

        console.log(
            `💳 InfinitePay configurada para: ${INFINITEPAY_HANDLE}`
        );

    }
);