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
   OLIST API V3
===================================================== */

const OLIST_API_BASE =
    process.env.OLIST_API_BASE ||
    "https://api.tiny.com.br/public-api/v3";

const OLIST_CLIENT_ID =
    process.env.OLIST_CLIENT_ID;

const OLIST_CLIENT_SECRET =
    process.env.OLIST_CLIENT_SECRET;

const OLIST_AUTH_URL =
    "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth";

const OLIST_TOKEN_URL =
    "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token";

const OLIST_REDIRECT_URI =
    `${SITE_URL}/olist/oauth/callback`;

const OLIST_SCOPE =
    "openid";


/* =====================================================
   TOKEN OLIST
===================================================== */

let olistAccessToken = null;

let olistRefreshToken =
    process.env.OLIST_REFRESH_TOKEN || null;

let olistTokenExpiresAt = 0;


/* =====================================================
   MIDDLEWARES
===================================================== */

app.use(
    cors({
        origin: true,
        methods: [
            "GET",
            "POST",
            "OPTIONS"
        ],
        allowedHeaders: [
            "Content-Type",
            "Authorization"
        ]
    })
);

app.options(
    "*",
    cors()
);

app.use(
    express.json()
);


/* =====================================================
   ARQUIVOS DO SITE
===================================================== */

app.use(
    express.static(
        path.join(
            __dirname,
            ".."
        )
    )
);


/* =====================================================
   TESTE DO SERVIDOR
===================================================== */

app.get(
    "/",
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
   OLIST API V3
   FUNÇÃO PARA OBTER TOKEN
===================================================== */

async function getOlistAccessToken() {

    /* -----------------------------------------
       TOKEN ATUAL AINDA VÁLIDO
    ----------------------------------------- */

    if (
        olistAccessToken &&
        Date.now() <
            olistTokenExpiresAt - 60000
    ) {

        return olistAccessToken;

    }


    /* -----------------------------------------
       RENOVAR COM REFRESH TOKEN
    ----------------------------------------- */

    if (
        olistRefreshToken &&
        OLIST_CLIENT_ID &&
        OLIST_CLIENT_SECRET
    ) {

        console.log(
            "🔄 Renovando token da Olist..."
        );

        const response =
            await fetch(
                OLIST_TOKEN_URL,
                {
                    method: "POST",

                    headers: {
                        "Accept":
                            "application/json",

                        "Content-Type":
                            "application/x-www-form-urlencoded"
                    },

                    body:
                        new URLSearchParams({

                            grant_type:
                                "refresh_token",

                            client_id:
                                OLIST_CLIENT_ID,

                            client_secret:
                                OLIST_CLIENT_SECRET,

                            refresh_token:
                                olistRefreshToken

                        })
                }
            );


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


        if (
            response.ok &&
            data.access_token
        ) {

            olistAccessToken =
                data.access_token;

            if (
                data.refresh_token
            ) {

                olistRefreshToken =
                    data.refresh_token;

            }

            olistTokenExpiresAt =
                Date.now() +
                (
                    Number(
                        data.expires_in
                    ) || 3600
                ) *
                1000;


            console.log(
                "✅ Token da Olist renovado."
            );


            return olistAccessToken;

        }


        console.error(
            "❌ Não foi possível renovar o token da Olist."
        );

        console.error(
            data
        );

    }


    throw new Error(
        "OLIST_AUTH_REQUIRED"
    );

}


/* =====================================================
   OLIST API V3
   REQUISIÇÃO AUTENTICADA
===================================================== */

async function olistRequest(
    endpoint,
    options = {}
) {

    const token =
        await getOlistAccessToken();


    const response =
        await fetch(
            `${OLIST_API_BASE}${endpoint}`,
            {
                ...options,

                headers: {

                    "Accept":
                        "application/json",

                    "Content-Type":
                        "application/json",

                    "Authorization":
                        `Bearer ${token}`,

                    ...(options.headers || {})

                }
            }
        );


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


    if (
        !response.ok
    ) {

        console.error(
            "❌ Erro na API V3 da Olist:"
        );

        console.error(
            "Status:",
            response.status
        );

        console.error(
            "Resposta:",
            data
        );

        throw new Error(
            `Olist API ${response.status}`
        );

    }


    return data;

}


/* =====================================================
   OLIST
   INICIAR AUTORIZAÇÃO OAUTH
===================================================== */

app.get(
    "/olist/oauth",
    (req, res) => {

        console.log(
            "🔐 Iniciando autorização OAuth da Olist..."
        );


        if (
            !OLIST_CLIENT_ID ||
            !OLIST_CLIENT_SECRET
        ) {

            console.error(
                "❌ Client ID ou Client Secret da Olist não configurado."
            );

            return res.status(500).send(
                "Client ID ou Client Secret da Olist não configurado no Render."
            );

        }


        const params =
            new URLSearchParams({

                client_id:
                    OLIST_CLIENT_ID,

                redirect_uri:
                    OLIST_REDIRECT_URI,

                scope:
                    OLIST_SCOPE,

                response_type:
                    "code"

            });


        const authorizationUrl =
            `${OLIST_AUTH_URL}?${params.toString()}`;


        console.log(
            "➡️ Redirecionando para a Olist..."
        );


        res.redirect(
            authorizationUrl
        );

    }
);


/* =====================================================
   OLIST
   CALLBACK OAUTH
===================================================== */

app.get(
    "/olist/oauth/callback",
    async (req, res) => {

        try {

            console.log(
                "🔐 Callback da Olist recebido."
            );


            const code =
                req.query.code;


            const error =
                req.query.error;


            /* -----------------------------------------
               ERRO DEVOLVIDO PELA OLIST
            ----------------------------------------- */

            if (
                error
            ) {

                console.error(
                    "❌ Olist retornou erro OAuth:",
                    error
                );


                return res.status(400).send(`
                    <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>MONTÊ - Erro Olist</title>
                        </head>

                        <body style="
                            font-family: Arial;
                            padding: 40px;
                            text-align: center;
                        ">

                            <h1>
                                Erro na autorização
                            </h1>

                            <p>
                                A Olist recusou ou cancelou a autorização.
                            </p>

                            <p>
                                ${String(error)}
                            </p>

                        </body>
                    </html>
                `);

            }


            /* -----------------------------------------
               SEM CODE
            ----------------------------------------- */

            if (
                !code
            ) {

                console.error(
                    "❌ Código de autorização não recebido."
                );


                return res.status(400).send(`
                    <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>MONTÊ - Olist</title>
                        </head>

                        <body style="
                            font-family: Arial;
                            padding: 40px;
                            text-align: center;
                        ">

                            <h1>
                                Código não recebido
                            </h1>

                            <p>
                                A Olist não retornou o código de autorização.
                            </p>

                        </body>
                    </html>
                `);

            }


            /* -----------------------------------------
               TROCAR CODE POR TOKEN
            ----------------------------------------- */

            console.log(
                "🔄 Trocando código por token da Olist..."
            );


            const response =
                await fetch(
                    OLIST_TOKEN_URL,
                    {
                        method: "POST",

                        headers: {

                            "Accept":
                                "application/json",

                            "Content-Type":
                                "application/x-www-form-urlencoded"

                        },

                        body:
                            new URLSearchParams({

                                grant_type:
                                    "authorization_code",

                                client_id:
                                    OLIST_CLIENT_ID,

                                client_secret:
                                    OLIST_CLIENT_SECRET,

                                redirect_uri:
                                    OLIST_REDIRECT_URI,

                                code:
                                    code

                            })
                    }
                );


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
               ERRO AO OBTER TOKEN
            ----------------------------------------- */

            if (
                !response.ok
            ) {

                console.error(
                    "❌ Erro ao obter token da Olist."
                );

                console.error(
                    "Status:",
                    response.status
                );

                console.error(
                    "Resposta:",
                    data
                );


                return res.status(500).send(`
                    <html>
                        <head>
                            <meta charset="UTF-8">
                            <title>MONTÊ - Erro Olist</title>
                        </head>

                        <body style="
                            font-family: Arial;
                            padding: 40px;
                            text-align: center;
                        ">

                            <h1>
                                Erro ao conectar com a Olist
                            </h1>

                            <p>
                                O servidor recebeu a autorização,
                                mas a Olist não liberou o token.
                            </p>

                            <p>
                                Verifique os logs do Render.
                            </p>

                        </body>
                    </html>
                `);

            }


            /* -----------------------------------------
               SALVA TOKEN EM MEMÓRIA
            ----------------------------------------- */

            olistAccessToken =
                data.access_token;


            olistRefreshToken =
                data.refresh_token ||
                null;


            olistTokenExpiresAt =
                Date.now() +
                (
                    Number(
                        data.expires_in
                    ) || 3600
                ) *
                1000;


            console.log(
                "✅ Olist API V3 autenticada com sucesso."
            );


            /* -----------------------------------------
               RESPOSTA PARA O USUÁRIO
            ----------------------------------------- */

            return res.send(`
                <!DOCTYPE html>

                <html>

                    <head>

                        <meta charset="UTF-8">

                        <title>
                            MONTÊ - Olist
                        </title>

                    </head>


                    <body style="
                        font-family: Arial, sans-serif;
                        padding: 50px;
                        text-align: center;
                        background: #f7f7f5;
                    ">

                        <div style="
                            max-width: 600px;
                            margin: 0 auto;
                            background: white;
                            padding: 40px;
                            border-radius: 12px;
                        ">

                            <h1>
                                Olist conectada!
                            </h1>

                            <p>
                                A API V3 da Olist foi autorizada
                                com sucesso.
                            </p>

                            <p>
                                O MONTÊ agora pode se comunicar
                                com o Olist ERP.
                            </p>

                            <p style="
                                margin-top: 30px;
                                font-size: 13px;
                                color: #777;
                            ">
                                Próximo passo:
                                testar a comunicação com a API
                                e depois enviar o pedido de teste.
                            </p>

                        </div>

                    </body>

                </html>
            `);

        } catch (error) {

            console.error(
                "❌ ERRO NO CALLBACK OLIST:"
            );

            console.error(
                error
            );


            return res.status(500).send(`
                <html>

                    <head>
                        <meta charset="UTF-8">
                        <title>
                            MONTÊ - Erro
                        </title>
                    </head>

                    <body style="
                        font-family: Arial;
                        padding: 40px;
                        text-align: center;
                    ">

                        <h1>
                            Erro interno
                        </h1>

                        <p>
                            Ocorreu um erro ao conectar
                            o MONTÊ à Olist.
                        </p>

                        <p>
                            Consulte os logs do Render.
                        </p>

                    </body>

                </html>
            `);

        }

    }
);


/* =====================================================
   OLIST
   STATUS DA AUTENTICAÇÃO
===================================================== */

app.get(
    "/olist/oauth/status",
    (req, res) => {

        const authenticated =
            Boolean(
                olistAccessToken &&
                Date.now() <
                    olistTokenExpiresAt
            );


        res.json({

            success:
                true,

            authenticated:
                authenticated,

            token_configured:
                Boolean(
                    olistAccessToken
                )

        });

    }
);


/* =====================================================
   ROTAS DO OLIST
   WEBHOOKS
===================================================== */

app.post(
    "/olist/produtos",
    (req, res) => {

        console.log(
            "📦 Atualização de produto recebida do Olist:"
        );

        console.log(
            req.body
        );


        res.status(200).json({

            success:
                true

        });

    }
);


app.post(
    "/olist/estoque",
    (req, res) => {

        console.log(
            "📊 Atualização de estoque recebida do Olist:"
        );

        console.log(
            req.body
        );


        res.status(200).json({

            success:
                true

        });

    }
);


app.post(
    "/olist/precos",
    (req, res) => {

        console.log(
            "💰 Atualização de preço recebida do Olist:"
        );

        console.log(
            req.body
        );


        res.status(200).json({

            success:
                true

        });

    }
);


app.post(
    "/olist/pedidos/status",
    (req, res) => {

        console.log(
            "🛍️ Atualização de pedido recebida do Olist:"
        );

        console.log(
            req.body
        );


        res.status(200).json({

            success:
                true

        });

    }
);


app.post(
    "/olist/rastreio",
    (req, res) => {

        console.log(
            "🚚 Atualização de rastreio recebida do Olist:"
        );

        console.log(
            req.body
        );


        res.status(200).json({

            success:
                true

        });

    }
);


app.post(
    "/olist/notas",
    (req, res) => {

        console.log(
            "🧾 Atualização de nota fiscal recebida do Olist:"
        );

        console.log(
            req.body
        );


        res.status(200).json({

            success:
                true

        });

    }
);


/* =====================================================
   OLIST
   NOVA VENDA RECEBIDA
===================================================== */

app.post(
    "/olist/pedidos",
    (req, res) => {

        console.log(
            "🛒 Nova venda recebida do Olist:"
        );

        console.log(
            req.body
        );


        res.status(200).json({

            success:
                true,

            message:
                "Pedido recebido pelo MONTÊ"

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

                    success:
                        false,

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

                    success:
                        false,

                    message:
                        "Dados do cliente incompletos."

                });

            }


            /* -----------------------------------------
               NORMALIZA PRODUTOS
            ----------------------------------------- */

            const infinitePayItems =
                items

                    .map(
                        (item) => {

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
                                !Number.isFinite(
                                    price
                                ) ||
                                price <= 0
                            ) {

                                return null;

                            }


                            if (
                                !Number.isFinite(
                                    quantity
                                ) ||
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

                        }
                    )

                    .filter(
                        Boolean
                    );


            /* -----------------------------------------
               CONFIRMA PRODUTOS VÁLIDOS
            ----------------------------------------- */

            if (
                infinitePayItems.length === 0
            ) {

                return res.status(400).json({

                    success:
                        false,

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

                        method:
                            "POST",

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

                    success:
                        false,

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

                    success:
                        false,

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

                success:
                    true,

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

                success:
                    false,

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

        console.log(
            `🔗 Olist API V3: ${OLIST_API_BASE}`
        );

        console.log(
            `🔐 Olist OAuth callback: ${OLIST_REDIRECT_URI}`
        );

    }
);
