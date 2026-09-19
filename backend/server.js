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
   MONTÊ → OLIST
   MEMÓRIA DOS PEDIDOS AGUARDANDO PAGAMENTO
===================================================== */

const pendingOrders = new Map();
const processedPayments = new Set();

/* =====================================================
   NORMALIZAR VALOR
===================================================== */

function normalizeMoney(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Number(number.toFixed(2));
}

/* =====================================================
   NORMALIZAR TEXTO
===================================================== */

function safeString(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return String(value).trim();
}

/* =====================================================
   GUARDAR PEDIDO ANTES DO PAGAMENTO
===================================================== */

function savePendingOrder(order) {

    if (!order || !order.order_nsu) {
        throw new Error("Pedido sem order_nsu.");
    }

    pendingOrders.set(
        order.order_nsu,
        {
            ...order,
            created_at: Date.now(),
            payment_confirmed: false,
            olist_created: false
        }
    );

    console.log(
        "💾 Pedido salvo aguardando pagamento:",
        order.order_nsu
    );
}

/* =====================================================
   RECUPERAR PEDIDO
===================================================== */

function getPendingOrder(orderNsu) {

    if (!orderNsu) {
        return null;
    }

    return pendingOrders.get(orderNsu) || null;
}

/* =====================================================
   LIMPEZA DE PEDIDOS ANTIGOS
===================================================== */

function cleanupPendingOrders() {

    const expiration =
        1000 *
        60 *
        60 *
        24;

    const now = Date.now();

    for (
        const [orderNsu, order]
        of pendingOrders.entries()
    ) {

        if (
            order.created_at &&
            now - order.created_at > expiration
        ) {

            pendingOrders.delete(orderNsu);

            console.log(
                "🧹 Pedido pendente removido:",
                orderNsu
            );
        }
    }
}

setInterval(
    cleanupPendingOrders,
    1000 * 60 * 60
);

/* =====================================================
   LOCALIZAR PRODUTO NO OLIST PELO SKU
===================================================== */

async function findOlistProductBySku(sku) {

    const cleanSku =
        safeString(sku);

    if (!cleanSku) {

        throw new Error(
            "Produto sem SKU."
        );

    }

    console.log(
        "🔎 Procurando produto no Olist pelo SKU:",
        cleanSku
    );

    const data =
        await olistRequest(
            `/produtos?codigo=${encodeURIComponent(cleanSku)}`
        );

    /*
       A API V3 retorna a listagem dentro de "itens".
       O modelo de listagem utiliza "sku".
    */

    const products =
        Array.isArray(data)
            ? data
            : (
                Array.isArray(data?.itens)
                    ? data.itens
                    : (
                        Array.isArray(data?.items)
                            ? data.items
                            : (
                                Array.isArray(data?.produtos)
                                    ? data.produtos
                                    : (
                                        Array.isArray(data?.data)
                                            ? data.data
                                            : []
                                    )
                            )
                    )
            );

    console.log(
        "📦 Produtos retornados pelo Olist:",
        products.length
    );

    /*
       A API V3 pode apresentar o identificador
       do produto como "sku" na listagem.
       Mantemos "codigo" como fallback.
    */

    const product =
        products.find(
            item => {

                const itemSku =
                    safeString(
                        item?.sku ??
                        item?.codigo ??
                        item?.codigoSku
                    );

                return (
                    itemSku.toLowerCase()
                    ===
                    cleanSku.toLowerCase()
                );

            }
        );

    if (!product) {

        console.error(
            "❌ SKU não encontrado na resposta do Olist:",
            cleanSku
        );

        console.error(
            "📦 Produtos retornados:",
            products.map(
                item => ({
                    id: item?.id,
                    sku: item?.sku,
                    codigo: item?.codigo,
                    descricao: item?.descricao,
                    nome: item?.nome
                })
            )
        );

        throw new Error(
            `Produto com SKU ${cleanSku} não encontrado no Olist.`
        );

    }

    if (!product.id) {

        throw new Error(
            `Produto ${cleanSku} foi encontrado, mas não possui ID.`
        );

    }

    console.log(
        "✅ Produto encontrado no Olist:",
        {
            id: product.id,
            sku:
                product.sku ??
                product.codigo ??
                cleanSku,
            descricao:
                product.descricao ??
                product.nome ??
                ""
        }
    );

    return product;
}
/* =====================================================
   LOCALIZAR CLIENTE NO OLIST
===================================================== */

async function findOlistContact(customer) {

    const email =
        safeString(
            customer?.email
        );

    if (!email) {
        throw new Error(
            "Cliente sem e-mail."
        );
    }

    console.log(
        "🔎 Procurando cliente no Olist:",
        email
    );

    const data =
        await olistRequest(
            `/contatos?email=${encodeURIComponent(email)}`
        );

    const contacts =
        Array.isArray(data)
            ? data
            : (
                data?.itens ||
                data?.items ||
                data?.contatos ||
                data?.data ||
                []
            );

    const contact =
        contacts.find(
            item =>
                safeString(
                    item?.email
                ).toLowerCase()
                ===
                email.toLowerCase()
        );

    if (contact?.id) {

        console.log(
            "✅ Cliente já existe no Olist:",
            contact.id
        );

        return contact;
    }

    return null;
}

/* =====================================================
   CRIAR CLIENTE NO OLIST
===================================================== */

async function createOlistContact(customer) {

    console.log(
        "👤 Cliente não encontrado. Criando no Olist..."
    );

    const payload = {

        nome:
            safeString(
                customer?.name
            ),

        email:
            safeString(
                customer?.email
            ),

        telefone:
            safeString(
                customer?.phone
            )
    };

    if (
        customer?.address
    ) {

        payload.endereco = {

            cep:
                safeString(
                    customer.address.cep
                ),

            logradouro:
                safeString(
                    customer.address.street
                ),

            numero:
                safeString(
                    customer.address.number
                ),

            complemento:
                safeString(
                    customer.address.complement
                ),

            bairro:
                safeString(
                    customer.address.neighborhood
                ),

            cidade:
                safeString(
                    customer.address.city
                ),

            uf:
                safeString(
                    customer.address.state
                )
        };
    }

    const data =
        await olistRequest(
            "/contatos",
            {
                method: "POST",
                body: JSON.stringify(
                    payload
                )
            }
        );

    const contact =
        data?.id
            ? data
            : (
                data?.data ||
                data?.contato ||
                data?.item ||
                null
            );

    if (
        !contact?.id
    ) {

        throw new Error(
            "Olist não retornou o ID do cliente criado."
        );
    }

    console.log(
        "✅ Cliente criado no Olist:",
        contact.id
    );

    return contact;
}

/* =====================================================
   OBTER OU CRIAR CLIENTE
===================================================== */

async function getOrCreateOlistContact(customer) {

    const existing =
        await findOlistContact(
            customer
        );

    if (existing) {
        return existing;
    }

    return await createOlistContact(
        customer
    );
}

/* =====================================================
   CRIAR PEDIDO NO OLIST
===================================================== */

async function findOlistOrderByEcommerceNumber(orderNsu) {

    const cleanOrderNsu = safeString(orderNsu);

    if (!cleanOrderNsu) {
        return null;
    }

    console.log(
        "🔎 Procurando pedido existente no Olist pelo número:",
        cleanOrderNsu
    );

    const data = await olistRequest(
        `/pedidos?numeroPedidoEcommerce=${encodeURIComponent(cleanOrderNsu)}`
    );

    const orders =
        Array.isArray(data)
            ? data
            : (
                Array.isArray(data?.itens)
                    ? data.itens
                    : (
                        Array.isArray(data?.items)
                            ? data.items
                            : (
                                Array.isArray(data?.pedidos)
                                    ? data.pedidos
                                    : (
                                        Array.isArray(data?.data)
                                            ? data.data
                                            : []
                                    )
                            )
                    )
            );

    console.log(
        "📦 Pedidos encontrados no Olist:",
        orders.length
    );

    const existingOrder =
        orders.find(item => {

            const ecommerceNumber =
                safeString(
                    item?.numeroPedidoEcommerce ??
                    item?.numero_pedido_ecommerce ??
                    item?.ecommerce?.numeroPedidoEcommerce
                );

            return (
                ecommerceNumber === cleanOrderNsu
            );

        });

    if (existingOrder) {

        console.log(
            "✅ Pedido já existe no Olist:",
            {
                id: existingOrder.id,
                numero:
                    existingOrder.numero ??
                    existingOrder.numeroPedido
            }
        );

        return existingOrder;
    }

    console.log(
        "ℹ️ Pedido ainda não existe no Olist."
    );

    return null;
}


/* =====================================================
   CRIAR PEDIDO NO OLIST
===================================================== */

async function createOlistOrder(order) {

    console.log(
        "📦 Preparando pedido para o Olist:",
        order.order_nsu
    );

    /*
       PRIMEIRO:
       verifica se o pedido já existe.
       Isso evita duplicidade.
    */

    const existingOrder =
        await findOlistOrderByEcommerceNumber(
            order.order_nsu
        );

    if (existingOrder) {

        console.log(
            "♻️ Reutilizando pedido já existente no Olist."
        );

        return existingOrder;
    }


    /*
       LOCALIZA OU CRIA CLIENTE
    */

    const contact =
        await getOrCreateOlistContact(
            order.customer
        );


    /*
       CONVERTE PRODUTOS
    */

    const olistItems = [];

    for (
        const item
        of order.items
    ) {

        const sku =
            safeString(
                item.sku
            );

        if (!sku) {

            throw new Error(
                `Produto "${item.description}" está sem SKU.`
            );

        }

        const product =
            await findOlistProductBySku(
                sku
            );

        olistItems.push({

            produto: {
                id: product.id
            },

            quantidade:
                Number(
                    item.quantity
                ) || 1,

            valorUnitario:
                normalizeMoney(
                    item.price
                )

        });

    }


    /*
       PAYLOAD DO PEDIDO
    */

    const payload = {

        idContato:
            contact.id,

        numeroPedidoEcommerce:
            safeString(
                order.order_nsu
            ),

        itens:
            olistItems,

        valorFrete:
            normalizeMoney(
                order.shipping?.value || 0
            )

    };


    /*
       ENDEREÇO DE ENTREGA
    */

    if (
        order.customer?.address
    ) {

        const address =
            order.customer.address;

        payload.enderecoEntrega = {

            cep:
                safeString(
                    address.cep
                ),

            logradouro:
                safeString(
                    address.street
                ),

            numero:
                safeString(
                    address.number
                ),

            complemento:
                safeString(
                    address.complement
                ),

            bairro:
                safeString(
                    address.neighborhood
                ),

            cidade:
                safeString(
                    address.city
                ),

            uf:
                safeString(
                    address.state
                )

        };

    }


    console.log(
        "📤 Enviando pedido para Olist..."
    );

    console.log(
        "🧾 Número externo do pedido:",
        payload.numeroPedidoEcommerce
    );


    /*
       TENTA CRIAR O PEDIDO
    */

    try {

        const data =
            await olistRequest(
                "/pedidos",
                {
                    method: "POST",

                    body:
                        JSON.stringify(
                            payload
                        )
                }
            );

        console.log(
            "✅ PEDIDO CRIADO NO OLIST:",
            data
        );

        return data;

    } catch (error) {

        /*
           Se a API disser que o registro já existe,
           fazemos uma nova consulta antes de considerar
           o processo como erro.
        */

        const errorMessage =
            safeString(
                error?.message
            );

        if (
            errorMessage.includes(
                "Olist API 409"
            )
        ) {

            console.log(
                "⚠️ Olist retornou 409."
            );

            console.log(
                "🔎 Verificando se o pedido foi criado mesmo assim..."
            );

            const orderAfterConflict =
                await findOlistOrderByEcommerceNumber(
                    order.order_nsu
                );

            if (
                orderAfterConflict
            ) {

                console.log(
                    "✅ Pedido encontrado após o 409."
                );

                return orderAfterConflict;
            }

        }

        throw error;

    }

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
   COM PEDIDO SALVO ANTES DO PAGAMENTO
===================================================== */

app.post(
    "/api/criar-checkout",
    async (req, res) => {

        try {

            console.log(
                "🛒 Solicitação de checkout recebida."
            );

            const {
                items,
                customer
            } = req.body || {};


            /* =================================================
               VALIDAÇÃO DO CARRINHO
            ================================================= */

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


            /* =================================================
               VALIDAÇÃO DO CLIENTE
            ================================================= */

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


            /* =================================================
               NORMALIZA PRODUTOS
            ================================================= */

            const normalizedItems =
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
                                    item.name ||
                                    "Produto MONTÊ"
                                );


                            const sku =
                                String(
                                    item.sku ||
                                    ""
                                ).trim();


                            /*
                               Produto normal
                            */

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


                            /*
                               Para integração com Olist,
                               produtos precisam ter SKU.
                            */

                            if (
                                !sku
                            ) {

                                console.warn(
                                    "⚠️ Produto sem SKU:",
                                    description
                                );

                            }


                            return {

                                id:
                                    item.id ||
                                    null,

                                name:
                                    item.name ||
                                    description,

                                description:
                                    description,

                                sku:
                                    sku,

                                quantity:
                                    quantity,

                                price:
                                    Number(
                                        price.toFixed(2)
                                    )

                            };

                        }
                    )
                    .filter(
                        Boolean
                    );


            /* =================================================
               CONFIRMA PRODUTOS VÁLIDOS
            ================================================= */

            if (
                normalizedItems.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Nenhum produto válido foi encontrado."

                });

            }


            /* =================================================
               SEPARA FRETE DOS PRODUTOS
            ================================================= */

            let productItems =
                normalizedItems;

            let shippingValue =
                0;


            /*
               O frontend da MONTÊ envia o frete como
               um item com SKU = FRETE.

               Esse item não deve virar produto no Olist.
            */

            const shippingItem =
                normalizedItems.find(
                    item =>
                        item.sku
                            .toUpperCase()
                            ===
                        "FRETE"
                );


            if (
                shippingItem
            ) {

                shippingValue =
                    Number(
                        shippingItem.price
                    ) *
                    Number(
                        shippingItem.quantity
                    );


                productItems =
                    normalizedItems.filter(
                        item =>
                            item.sku
                                .toUpperCase()
                                !==
                            "FRETE"
                    );

            }


            /* =================================================
               VERIFICA SE SOBROU PRODUTO
            ================================================= */

            if (
                productItems.length === 0
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Nenhum produto foi encontrado no pedido."

                });

            }


            /* =================================================
               ORDER NSU
            ================================================= */

            const orderNsu =
                `MONTE-${Date.now()}`;


            /* =================================================
               SALVA O PEDIDO ANTES DO PAGAMENTO
            ================================================= */

            const pendingOrder = {

                order_nsu:
                    orderNsu,

                customer: {

                    name:
                        String(
                            customer.name
                        ),

                    email:
                        String(
                            customer.email
                        ),

                    phone:
                        String(
                            customer.phone
                        ),

                    address:
                        customer.address
                            ? {

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
                                    "",

                                city:
                                    customer.address.city ||
                                    "",

                                state:
                                    customer.address.state ||
                                    ""

                            }
                            : null

                },

                items:
                    productItems,

                shipping: {

                    value:
                        Number(
                            shippingValue.toFixed(2)
                        )

                },

                created_at:
                    Date.now(),

                payment_confirmed:
                    false,

                olist_created:
                    false

            };


            savePendingOrder(
                pendingOrder
            );


            /* =================================================
               CONVERTE PRODUTOS PARA INFINITEPAY
            ================================================= */

            const infinitePayItems =
                normalizedItems
                    .map(
                        (item) => {

                            return {

                                quantity:
                                    item.quantity,

                                price:
                                    Math.round(
                                        item.price *
                                        100
                                    ),

                                description:
                                    item.description

                            };

                        }
                    );


            /* =================================================
               PAYLOAD INFINITEPAY
            ================================================= */

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


            /* =================================================
               ENDEREÇO PARA INFINITEPAY
            ================================================= */

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


            /* =================================================
               LOG
            ================================================= */

            console.log(
                "📦 Pedido salvo:",
                orderNsu
            );

            console.log(
                "💰 Valor do frete:",
                shippingValue
            );

            console.log(
                "🛍️ Quantidade de produtos:",
                productItems.length
            );

            console.log(
                "📤 Enviando checkout para InfinitePay..."
            );


            /* =================================================
               CHAMADA REAL DA INFINITEPAY
            ================================================= */

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


            /* =================================================
               LÊ RESPOSTA
            ================================================= */

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


            /* =================================================
               ERRO INFINITEPAY
            ================================================= */

            if (
                !response.ok
            ) {

                /*
                   Se o checkout falhar, removemos o pedido
                   temporário para não deixar lixo na memória.
                */

                pendingOrders.delete(
                    orderNsu
                );


                console.error(
                    "❌ InfinitePay respondeu com erro."
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


            /* =================================================
               VERIFICA URL
            ================================================= */

            if (
                !data ||
                !data.url
            ) {

                pendingOrders.delete(
                    orderNsu
                );


                console.error(
                    "❌ InfinitePay não retornou URL."
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


            /* =================================================
               SUCESSO
            ================================================= */

            console.log(
                "✅ Checkout InfinitePay criado."
            );

            console.log(
                "🔑 Order NSU:",
                orderNsu
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
   INFINITEPAY
   WEBHOOK DE PAGAMENTO
===================================================== */

app.post(
    "/webhook-infinitepay",
    async (req, res) => {

        try {

            console.log(
                "💳 Webhook da InfinitePay recebido."
            );

            console.log(
                "📩 Dados recebidos:",
                req.body
            );

            const webhook =
                req.body || {};

            const orderNsu =
                safeString(
                    webhook.order_nsu
                );

            const transactionNsu =
                safeString(
                    webhook.transaction_nsu
                );

            if (!orderNsu) {

                console.error(
                    "❌ Webhook recebido sem order_nsu."
                );

                return res.status(400).json({
                    success: false,
                    message: "order_nsu não informado."
                });

            }

            console.log(
                "🔑 Order NSU:",
                orderNsu
            );

            console.log(
                "💳 Transaction NSU:",
                transactionNsu || "não informado"
            );

            /*
             * Respondemos à InfinitePay somente depois
             * de validar que recebemos um order_nsu.
             */

            res.status(200).json({
                success: true
            });

            /*
             * Evita processar o mesmo pagamento duas vezes.
             */

            if (
                processedPayments.has(
                    orderNsu
                )
            ) {

                console.log(
                    "ℹ️ Pagamento já processado:",
                    orderNsu
                );

                return;
            }

            /*
             * Recupera o pedido salvo quando o checkout
             * foi criado.
             */

            const order =
                getPendingOrder(
                    orderNsu
                );

            if (!order) {

                console.error(
                    "❌ Pedido não encontrado na memória:"
                );

                console.error(
                    orderNsu
                );

                return;
            }

            /*
             * Verifica o status enviado pela InfinitePay.
             */

            const status =
                safeString(
                    webhook.status ||
                    webhook.payment_status ||
                    webhook.current_status ||
                    webhook.transaction_status
                ).toLowerCase();

            console.log(
                "💰 Status recebido:",
                status || "não informado"
            );

            /*
             * Status que NÃO devem gerar pedido no Olist.
             */

            const failedStatuses = [

                "failed",
                "failure",
                "cancelled",
                "canceled",
                "refused",
                "rejected",
                "denied",
                "expired"

            ];

            if (
                failedStatuses.includes(
                    status
                )
            ) {

                console.log(
                    "❌ Pagamento não aprovado."
                );

                console.log(
                    "🚫 Pedido não será enviado ao Olist."
                );

                return;
            }

            /*
             * Marca o pedido como pago.
             */

            order.payment_confirmed =
                true;

            order.transaction_nsu =
                transactionNsu;

            order.payment_data =
                webhook;

            console.log(
                "✅ Pagamento confirmado."
            );

            console.log(
                "📦 Enviando pedido para o Olist..."
            );

            try {

                const olistResult =
                    await createOlistOrder(
                        order
                    );

                order.olist_created =
                    true;

                order.olist_result =
                    olistResult;

                order.olist_created_at =
                    new Date().toISOString();

                processedPayments.add(
                    orderNsu
                );

                console.log(
                    "=========================================="
                );

                console.log(
                    "✅ PEDIDO ENVIADO PARA O OLIST"
                );

                console.log(
                    "🔑 Order NSU:",
                    orderNsu
                );

                console.log(
                    "💳 Transaction NSU:",
                    transactionNsu
                );

                console.log(
                    "📦 Resposta do Olist:",
                    olistResult
                );

                console.log(
                    "=========================================="
                );

            } catch (
                olistError
            ) {

                console.error(
                    "=========================================="
                );

                console.error(
                    "❌ ERRO AO ENVIAR PEDIDO PARA O OLIST"
                );

                console.error(
                    "Order NSU:",
                    orderNsu
                );

                console.error(
                    olistError
                );

                console.error(
                    "=========================================="
                );

            }

        } catch (
            error
        ) {

            console.error(
                "❌ ERRO NO WEBHOOK DA INFINITEPAY:"
            );

            console.error(
                error
            );

            /*
             * Se o erro ocorrer antes da resposta HTTP,
             * informamos erro ao remetente.
             */

            if (!res.headersSent) {

                return res.status(500).json({

                    success: false,

                    message:
                        "Erro interno no webhook."

                });

            }

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
