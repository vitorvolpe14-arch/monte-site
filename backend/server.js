const express = require("express");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.static(path.join(__dirname, "..")));
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
};
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================================
// TESTE DO SERVIDOR
// ================================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "index.html"));
});

// ================================
// ROTAS DO OLIST
// ================================

// Receber produtos / atualizações de produtos
app.post("/olist/produtos", (req, res) => {
    console.log("📦 Atualização de produto recebida do Olist:");
    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

// Receber atualizações de estoque
app.post("/olist/estoque", (req, res) => {
    console.log("📊 Atualização de estoque recebida do Olist:");
    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

// Receber atualizações de preços
app.post("/olist/precos", (req, res) => {
    console.log("💰 Atualização de preço recebida do Olist:");
    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

// Receber alteração de situação dos pedidos
app.post("/olist/pedidos/status", (req, res) => {
    console.log("🛍️ Atualização de pedido recebida do Olist:");
    console.log(req.body);

    res.status(200).json({
        success: true
    });
});

// Receber rastreamento
app.post("/olist/rastreio", (req, res) => {
    console.log("🚚 Atualização de rastreio recebida do Olist:");
    console.log(req.body);

    res.status(200).json({
        success: true
    });
});
// receber atualização de nota fiscal
app.post("/olist/notas", (req, res) => {
    console.log("🧾 Atualização de nota fiscal recebida do Olist:");
    console.log(req.body);

    res.status(200).json({
        success: true
    });
});
// ================================
// INICIAR SERVIDOR
// ================================
// ==========================================
// INFINITEPAY - CRIAR CHECKOUT
// ==========================================

app.post("/api/criar-checkout", async (req, res) => {
  try {
    const { items, customer } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Carrinho vazio."
      });
    }

    if (
      !customer ||
      !customer.name ||
      !customer.email ||
      !customer.phone
    ) {
      return res.status(400).json({
        success: false,
        message: "Dados do cliente incompletos."
      });
    }

    const orderNsu = 'MONTE-${Date.now()}';

    // A InfinitePay recebe os valores em centavos
    const infinitePayItems = items.map((item) => ({
      quantity: Number(item.quantity) || 1,
      price: Math.round(Number(item.price) * 100),
      description: item.description
    }));

    const payload = {
      handle: "monte-64839705-0z9",

      order_nsu: orderNsu,

    redirect_url:
        "https://monte-site-itjk.onrender.com/pagamento-sucesso",

      items: infinitePayItems,

      customer: {
        name: customer.name,
        email: customer.email,
        phone_number: customer.phone
      },

      address: customer.address
        ? {
            cep: customer.address.cep,
            street: customer.address.street,
            number: customer.address.number,
            neighborhood: customer.address.neighborhood,
            complement: customer.address.complement || ""
          }
        : undefined
    };

    const response = await fetch(
      "/api/criar-checkout",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro InfinitePay:", data);

      return res.status(400).json({
        success: false,
        message: "Não foi possível criar o checkout.",
        error: data
      });
    }

    console.log("Checkout InfinitePay criado:", data);

    return res.json({
      success: true,
      url: data.url,
      order_nsu: orderNsu
    });

  } catch (error) {
    console.error("Erro ao criar checkout:", error);

    return res.status(500).json({
      success: false,
      message: "Erro interno ao criar checkout."
    });
  }
});

app.listen(PORT, () => {
    console.log(`🚀 Backend MONTÊ rodando na porta ${PORT}`);
});