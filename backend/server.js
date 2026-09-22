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

const SUPABASE_URL = process.env.SUPABASE_URL || "https://uvrhougaurupvkxmezwy.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseRequest(path, options = {}) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY não configurada no backend.");
    }

    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
            ...(options.headers || {})
        }
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
        throw new Error(`Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }

    return data;
}



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
   OLIST
   DIAGNÓSTICO DE PEDIDO
===================================================== */

app.get(
    "/olist/diagnostico/pedido/:numero",
    async (req, res) => {

        try {

            const numero =
                safeString(
                    req.params.numero
                );

            if (!numero) {

                return res.status(400).json({
                    success: false,
                    message: "Número do pedido não informado."
                });

            }

            console.log(
                "🔎 Diagnóstico Olist - procurando pedido:",
                numero
            );

            const data =
                await olistRequest(
                    `/pedidos?numeroPedidoEcommerce=${encodeURIComponent(numero)}`
                );

            console.log(
                "📦 Resultado da consulta:",
                data
            );

            return res.status(200).json({
                success: true,
                numero_consultado: numero,
                resultado: data
            });

        } catch (error) {

            console.error(
                "❌ Erro no diagnóstico Olist:",
                error
            );

            return res.status(500).json({
                success: false,
                message: error.message
            });

        }

    }
);
/* =====================================================
   OLIST
   DIAGNÓSTICO DE INTEGRAÇÕES / E-COMMERCE
===================================================== */

app.get(
    "/olist/diagnostico/integracoes",
    async (req, res) => {

        const resultados = {};

        /*
         * Vamos consultar somente endpoints de leitura.
         * Nenhum pedido será criado ou alterado.
         */

        const endpoints = [
            "/ecommerce",
            "/ecommerces",
            "/integracoes",
            "/integracoes/ecommerce"
        ];

        for (
            const endpoint
            of endpoints
        ) {

            try {

                console.log(
                    "🔎 Testando endpoint Olist:",
                    endpoint
                );

                const data =
                    await olistRequest(
                        endpoint
                    );

                resultados[endpoint] = {
                    sucesso: true,
                    resposta: data
                };

                console.log(
                    "✅ Endpoint respondeu:",
                    endpoint
                );

            } catch (error) {

                resultados[endpoint] = {
                    sucesso: false,
                    erro: error.message
                };

                console.log(
                    "ℹ️ Endpoint não disponível:",
                    endpoint,
                    error.message
                );

            }

        }

        return res.status(200).json({

            success: true,

            mensagem:
                "Diagnóstico concluído. Nenhum dado foi alterado.",

            resultados

        });

    }
);
/* =====================================================
   OLIST
   DIAGNÓSTICO DE PEDIDO POR ID
===================================================== */

app.get(
    "/olist/diagnostico/pedido-id/:id",
    async (req, res) => {

        try {

            const id =
                safeString(
                    req.params.id
                );

            if (!id) {

                return res.status(400).json({
                    success: false,
                    message: "ID do pedido não informado."
                });

            }

            console.log(
                "🔎 Consultando pedido Olist pelo ID:",
                id
            );

            const data =
                await olistRequest(
                    `/pedidos/${encodeURIComponent(id)}`
                );

            console.log(
                "📦 Pedido retornado pelo Olist:",
                data
            );

            return res.status(200).json({
                success: true,
                id_consultado: id,
                pedido: data
            });

        } catch (error) {

            console.error(
                "❌ Erro ao consultar pedido por ID:",
                error
            );

            return res.status(500).json({
                success: false,
                message: error.message
            });

        }

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
               VALIDA VARIAÇÕES E ESTOQUE NO SUPABASE
            ================================================= */
            for (const item of productItems) {
                if (!item.id || !item.variant_id) {
                    return res.status(400).json({
                        success: false,
                        message: "Produto precisa ter uma variação/cor selecionada."
                    });
                }

                const variants = await supabaseRequest(
                    "product_variants?id=eq." + encodeURIComponent(item.variant_id) +
                    "&product_id=eq." + encodeURIComponent(item.id) +
                    "&active=eq.true&select=id,color,sku,stock",
                    { method: "GET" }
                );

                const variant = Array.isArray(variants) ? variants[0] : null;
                if (!variant) {
                    return res.status(400).json({
                        success: false,
                        message: "A variação selecionada não está disponível."
                    });
                }

                if (Number(variant.stock || 0) < Number(item.quantity || 0)) {
                    return res.status(409).json({
                        success: false,
                        message: "Estoque insuficiente para " + item.description +
                            (item.variant_color ? " (" + item.variant_color + ")" : "") + "."
                    });
                }

                item.variant_color = variant.color;
                item.variant_sku = variant.sku || item.sku || null;
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


            const subtotal = productItems.reduce(
                (sum, item) => sum + Number(item.price) * Number(item.quantity), 0
            );

            const savedOrders = await supabaseRequest("orders", {
                method: "POST",
                body: JSON.stringify({
                    order_nsu: orderNsu,
                    customer_name: pendingOrder.customer.name,
                    customer_email: pendingOrder.customer.email,
                    customer_phone: pendingOrder.customer.phone,
                    customer_address: pendingOrder.customer.address,
                    subtotal: Number(subtotal.toFixed(2)),
                    shipping: Number(shippingValue.toFixed(2)),
                    total: Number((subtotal + shippingValue).toFixed(2)),
                    status: "pending",
                    items: productItems
                })
            });

            const savedOrder = Array.isArray(savedOrders) ? savedOrders[0] : savedOrders;

            await supabaseRequest("order_items", {
                method: "POST",
                body: JSON.stringify(productItems.map(item => ({
                    order_id: savedOrder.id,
                    product_id: item.id || null,
                    variant_id: item.variant_id || null,
                    variant_color: item.variant_color || null,
                    sku: item.variant_sku || item.sku || null,
                    product_name: item.name,
                    quantity: item.quantity,
                    unit_price: item.price,
                    total_price: Number((item.price * item.quantity).toFixed(2))
                })))
            });

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

            const paidAmount = Number(
                webhook.paid_amount ??
                webhook.amount ??
                order.total ??
                0
            );

            const orderRows = await supabaseRequest(
                `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({
                        status: "paid",
                        transaction_nsu: transactionNsu || null,
                        paid_amount: paidAmount,
                        paid_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                }
            );

            const persisted = await supabaseRequest(
                `orders?order_nsu=eq.${encodeURIComponent(orderNsu)}&select=id`,
                { method: "GET" }
            );

            if (Array.isArray(persisted) && persisted[0]?.id) {
                const stockResult = await supabaseRequest("rpc/decrement_order_stock", {
                    method: "POST",
                    body: JSON.stringify({ p_order_id: persisted[0].id })
                });
                console.log("📦 Baixa de estoque:", stockResult);
            }

            if (Array.isArray(persisted) && persisted[0]?.id && transactionNsu) {
                await supabaseRequest("payments", {
                    method: "POST",
                    body: JSON.stringify({
                        order_id: persisted[0].id,
                        order_nsu: orderNsu,
                        transaction_nsu: transactionNsu,
                        invoice_slug: webhook.invoice_slug || null,
                        amount: order.total || paidAmount,
                        paid_amount: paidAmount,
                        installments: webhook.installments || null,
                        capture_method: webhook.capture_method || null,
                        receipt_url: webhook.receipt_url || null,
                        status: "paid",
                        webhook_data: webhook
                    })
                });
            }

            processedPayments.add(orderNsu);
            console.log("✅ Pagamento salvo no Supabase. Olist não é acionado.");

        } catch (error) {

            console.error("❌ ERRO NO WEBHOOK DA INFINITEPAY:", error);

            if (!res.headersSent) {
                return res.status(500).json({
                    success: false,
                    message: "Erro interno no webhook."
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
