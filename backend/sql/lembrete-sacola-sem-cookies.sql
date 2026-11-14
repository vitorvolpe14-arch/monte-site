-- Lembrete da sacola sem cookies (legítimo interesse; veja backend/cart-reminder.js e
-- docs/teste-legitimo-interesse-lembrete-sacola.md).
-- (aplicado no Supabase como a migração "monte_cart_reminder_without_cookies").
--
-- cart_snapshots.visitor_id passa a ser opcional: sem a permissão de estatísticas, a sacola chega
--   sem código de visitante, só com a chave da página (cart_key), as peças, o nome e o WhatsApp.
--   O servidor só guarda essa sacola com um celular válido, e ela sai inteira depois de 30 dias;
--   nas outras, o nome e o celular saem nesse prazo (purgeExpiredAnalytics em backend/server.js).

alter table public.cart_snapshots
  alter column visitor_id drop not null;
