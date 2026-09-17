const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================================
// TESTE DO SERVIDOR
// ================================

app.get("/", (req, res) => {
    res.json({
        status: "online",
        loja: "MONTÊ",
        mensagem: "Backend da MONTÊ funcionando!"
    });
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


app.listen(PORT, () => {
    console.log(`🚀 Backend MONTÊ rodando na porta ${PORT}`);
});