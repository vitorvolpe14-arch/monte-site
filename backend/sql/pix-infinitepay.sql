-- Desconto do Pix aplicado pela própria InfinitePay
-- (aplicado no Supabase como a migração "monte_orders_payment_options").
--
-- O link de pagamento sai com o preço cheio e a InfinitePay tira o desconto só se a
-- cliente pagar no Pix (options.discounts.pix). Assim o desconto não vale no cartão.
--
-- orders.payment_options: o valor de cada forma de pagamento, calculado no checkout.
--   { "mode": "infinitepay_pix_discount", "link_total": 1028.00, "pix_discount_percent": 4.9027,
--     "pix": { "total": 977.60, "coupon_discount": 0 },
--     "credit_card": { "total": 1028.00, "coupon_discount": 0 } }
--   Cada peça em orders.items leva charged_units_by_method (o cobrado no Pix e no cartão).
--   O aviso de pagamento usa o valor da forma que a cliente usou. Vazio nos pedidos com o
--   desconto já no preço do link (sem a chave da InfinitePay ou pedidos antigos).

alter table public.orders
  add column if not exists payment_options jsonb;
