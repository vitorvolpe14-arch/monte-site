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
   SUPABASE
===================================================== */

const SUPABASE_URL =
    process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
    process.env.SUPABASE_SECRET_KEY;


async function supabaseRequest(
    table,
    options = {}
) {

    if (
        !SUPABASE_URL ||
        !SUPABASE_SECRET_KEY
    ) {

        throw new Error(
            "Supabase não configurado no ambiente."
        );

    }

    const response =
        await fetch(
            `${SUPABASE_URL}/rest/v1/${table}`,
            {
                ...options,

                headers: {
                    "Content-Type":
                        "application/json",

                    "apikey":
                        SUPABASE_SECRET_KEY,

                    "Authorization":
                        `Bearer ${SUPABASE_SECRET_KEY}`,

                    "Prefer":
                        "return=representation",

                    ...(options.headers || {})
                }
            }
        );


    const text =
        await response.text();


    let data;

    try {

        data =
            text
                ? JSON.parse(text)
                : null;

    } catch {

        data = text;

    }


    if (!response.ok) {

        console.error(
            "❌ Erro Supabase:",
            response.status,
            data
        );

        throw new Error(
            `Supabase ${response.status}`
        );

    }


    return data;

}


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

app.post(
    "/olist/produtos",
    (req, res) => {

        console.log(
            "📦 Atualização de produto recebida do Olist:"
        );

        console.log(req.body);

        res.status(200).json({
            success: true
        });

    }
);


app.post(
    "/olist/estoque",
    (req, res) => {

        console.log(
            "📊 Atualização de estoque recebida do Olist:"
        );

        console.log(req.body);

        res.status(200).json({
            success: true
        });

    }
);


app.post(
    "/olist/precos",
    (req, res) => {

        console.log(
            "💰 Atualização de preço recebida do Olist:"
        );

        console.log(req.body);

        res.status(200).json({
            success: true
        });

    }
);


app.post(
    "/olist/pedidos/status",
    (req, res) => {

        console.log(
            "🛍️ Atualização de pedido recebida do Olist:"
        );

        console.log(req.body);

        res.status(200).json({
            success: true
        });

    }
);


app.post(
    "/olist/rastreio",
    (req, res) => {

        console.log(
            "🚚 Atualização de rastreio recebida do Olist:"
        );

        console.log(req.body);

        res.status(200).json({
            success: true
        });

    }
);


app.post(
    "/olist/notas",
    (req, res) => {

        console.log(
            "🧾 Atualização de nota fiscal recebida do Olist:"
        );

        console.log(req.body);

        res.status(200).json({
            success: true
        });

    }
);


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
               CALCULA VALORES DO PEDIDO
            ----------------------------------------- */

            const shippingItem =
                items.find(
                    (item) => {

                        const description =
                            String(
                                item.description || ""
                            ).toLowerCase();

                        return (
                            description.includes("frete")
                        );

                    }
                );


            const shipping =
                shippingItem
                    ? Number(
                        shippingItem.price
                    ) *
                    Number(
                        shippingItem.quantity || 1
                    )
                    : 0;


            const total =
                items.reduce(
                    (sum, item) => {

                        const price =
                            Number(
                                item.price
                            ) || 0;

                        const quantity =
                            Number(
                                item.quantity
                            ) || 1;

                        return (
                            sum +
                            price * quantity
                        );

                    },
                    0
                );


            const subtotal =
                total - shipping;


            /* -----------------------------------------
               SALVA PEDIDO NO SUPABASE
            ----------------------------------------- */

            try {

                await supabaseRequest(
                    "orders",
                    {

                        method: "POST",

                        body:
                            JSON.stringify({

                                order_nsu:
                                    orderNsu,

                                customer_name:
                                    String(
                                        customer.name
                                    ),

                                customer_email:
                                    String(
                                        customer.email
                                    ),

                                customer_phone:
                                    String(
                                        customer.phone
                                    ),

                                customer_address:
                                    customer.address ||
                                    null,

                                subtotal:
                                    subtotal,

                                shipping:
                                    shipping,

                                total:
                                    total,

                                status:
                                    "pending",

                                items:
                                    items,

                                invoice_slug:
                                    data.invoice_slug ||
                                    data.slug ||
                                    null,

                                created_at:
                                    new Date().toISOString(),

                                updated_at:
                                    new Date().toISOString()

                            })

                    }
                );


                console.log(
                    "✅ PEDIDO SALVO NO SUPABASE:",
                    orderNsu
                );


            } catch (supabaseError) {

                console.error(
                    "❌ ERRO AO SALVAR PEDIDO NO SUPABASE:"
                );

                console.error(
                    supabaseError
                );


                return res.status(500).json({

                    success: false,

                    message:
                        "Não foi possível registrar o pedido."

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
   WEBHOOK INFINITEPAY
===================================================== */

app.post(
    "/webhook-infinitepay",
    async (req, res) => {

        try {

            console.log(
                "===================================="
            );

            console.log(
                "💰 WEBHOOK INFINITEPAY RECEBIDO"
            );

            console.log(
                "===================================="
            );

            console.log(
                JSON.stringify(
                    req.body,
                    null,
                    2
                )
            );


            const {
                invoice_slug,
                amount,
                paid_amount,
                installments,
                capture_method,
                transaction_nsu,
                order_nsu,
                receipt_url,
                items
            } = req.body || {};


            /* -----------------------------------------
               VALIDAÇÃO BÁSICA
            ----------------------------------------- */

            if (!order_nsu) {

                console.error(
                    "❌ Webhook sem order_nsu"
                );


                return res.status(400).json({

                    success: false,

                    message:
                        "order_nsu não informado."

                });

            }


            if (!transaction_nsu) {

                console.error(
                    "❌ Webhook sem transaction_nsu"
                );


                return res.status(400).json({

                    success: false,

                    message:
                        "transaction_nsu não informado."

                });

            }


            /* -----------------------------------------
               PAGAMENTO CONFIRMADO
            ----------------------------------------- */

            console.log(
                "✅ PAGAMENTO APROVADO"
            );

            console.log(
                "Pedido:",
                order_nsu
            );

            console.log(
                "Transação:",
                transaction_nsu
            );

            console.log(
                "Valor:",
                amount
            );

            console.log(
                "Valor pago:",
                paid_amount
            );

            console.log(
                "Forma:",
                capture_method
            );

            console.log(
                "Comprovante:",
                receipt_url
            );


            /* -----------------------------------------
               ATUALIZA PEDIDO NO SUPABASE
            ----------------------------------------- */

            try {

                const updatedOrder =
                    await supabaseRequest(
                        `orders?order_nsu=eq.${encodeURIComponent(order_nsu)}`,
                        {

                            method: "PATCH",

                            body:
                                JSON.stringify({

                                    status:
                                        "paid",

                                    invoice_slug:
                                        invoice_slug ||
                                        null,

                                    transaction_nsu:
                                        transaction_nsu,

                                    receipt_url:
                                        receipt_url ||
                                        null,

                                    amount:
                                        amount != null
                                            ? Number(amount)
                                            : null,

                                    paid_amount:
                                        paid_amount != null
                                            ? Number(paid_amount)
                                            : null,

                                    installments:
                                        installments != null
                                            ? Number(installments)
                                            : null,

                                    capture_method:
                                        capture_method ||
                                        null,

                                    paid_at:
                                        new Date().toISOString(),

                                    updated_at:
                                        new Date().toISOString()

                                })

                        }
                    );


                if (
                    !updatedOrder ||
                    updatedOrder.length === 0
                ) {

                    console.error(
                        "❌ Pedido não encontrado no Supabase:",
                        order_nsu
                    );


                    return res.status(404).json({

                        success: false,

                        message:
                            "Pedido não encontrado no Supabase."

                    });

                }


                console.log(
                    "✅ PEDIDO ATUALIZADO NO SUPABASE:"
                );

                console.log(
                    order_nsu
                );

                console.log(
                    "Status: paid"
                );


            } catch (supabaseError) {

                console.error(
                    "❌ ERRO AO ATUALIZAR PEDIDO NO SUPABASE:"
                );

                console.error(
                    supabaseError
                );


                return res.status(500).json({

                    success: false,

                    message:
                        "Erro ao atualizar pedido no Supabase."

                });

            }


            /* -----------------------------------------
               AQUI ENTRARÁ O OLIST
            ----------------------------------------- */

            // NÃO vamos integrar o Olist ainda.
            //
            // O pedido já está sendo salvo no Supabase.
            //
            // Depois vamos usar:
            //
            // order_nsu
            // transaction_nsu
            // items
            // valor
            // cliente
            //
            // para integrar com o Olist.


            /* -----------------------------------------
               RESPONDE À INFINITEPAY
            ----------------------------------------- */

            return res.status(200).json({

                success: true,

                message: null

            });


        } catch (error) {

            console.error(
                "❌ ERRO NO WEBHOOK INFINITEPAY:"
            );

            console.error(
                error
            );


            return res.status(400).json({

                success: false,

                message:
                    "Erro ao processar webhook."

            });

        }

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
