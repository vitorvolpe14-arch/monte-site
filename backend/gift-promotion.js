// Quantos presentes uma compra ganha numa promoção de presente (backend/sql/promocoes.sql).
//
// A conta usa as peças pelo preço do site (antes do desconto do Pix e do cupom); o frete não
// conta. Promoção comum: um presente a partir do valor mínimo. Promoção "a cada" (gift_every):
// um presente a cada valor mínimo (R$ 998 = 2 presentes numa promoção de R$ 499), até
// max_gifts por pedido (vazio = sem limite, até o teto de PROMOTION_GIFTS_CEILING).
// O site (script.js, giftCountFor) faz a mesma conta para mostrar na sacola.

const PROMOTION_GIFTS_CEILING = 20;

function promotionGiftCount(promotion, productsSubtotal) {
    const minCents = Math.round(Number(promotion?.min_subtotal) * 100);
    const subtotalCents = Math.round(Number(productsSubtotal) * 100);
    if (!Number.isFinite(minCents) || !Number.isFinite(subtotalCents) || minCents <= 0 || subtotalCents < minCents) return 0;
    if (promotion.gift_every !== true) return 1;
    const max = Number(promotion.max_gifts) > 0
        ? Math.min(Math.floor(Number(promotion.max_gifts)), PROMOTION_GIFTS_CEILING)
        : PROMOTION_GIFTS_CEILING;
    return Math.min(Math.floor(subtotalCents / minCents), max);
}

module.exports = { PROMOTION_GIFTS_CEILING, promotionGiftCount };
