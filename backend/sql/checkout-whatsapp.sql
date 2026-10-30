-- Checkout sem pedidos repetidos e aviso da loja para chamar a cliente no WhatsApp
-- (aplicado no Supabase como a migração "monte_checkout_reuse_whatsapp_followup").
--
-- orders.checkout_fingerprint: a mesma compra (cliente, endereço, peças, frete, pagamento,
--   cupom e presente). Tocar de novo em FINALIZAR em até 1 hora reaproveita o pedido
--   e o link de pagamento (orders.checkout_url) em vez de criar outro pedido.
-- store_followup_*: e-mail interno para a loja chamar a cliente no WhatsApp com um toque
--   (pedido sem pagamento há 30 minutos ou sacola com WhatsApp parada há 2 horas).

alter table public.orders
  add column if not exists checkout_url text,
  add column if not exists checkout_fingerprint text,
  add column if not exists store_followup_sent_at timestamptz,
  add column if not exists store_followup_status text;

create index if not exists orders_checkout_fingerprint_idx
  on public.orders (checkout_fingerprint, created_at desc)
  where status = 'pending';

alter table public.cart_snapshots
  add column if not exists store_followup_sent_at timestamptz,
  add column if not exists store_followup_status text;
