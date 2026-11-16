-- Notificações do painel no celular (aplicado no Supabase como a migração "monte_admin_push_notifications").
--
-- Cada aparelho que ativou as notificações no sino do painel (admin-push.js) é uma linha: o endereço
-- do serviço de notificações do aparelho (Apple, Google, Mozilla, Microsoft) e as duas chaves
-- públicas que cifram a mensagem (backend/web-push.js). Nada disso identifica uma pessoa.
--   topics: avisos que o aparelho quer receber
--     sales     venda nova (pagamento confirmado; na pré-venda, aceitar ou recusar)
--     pending   pedido sem pagamento há 30 minutos (chamar a cliente no WhatsApp)
--     security  login do painel bloqueado por senhas erradas
-- O aparelho que desinstala o app ou desliga as notificações é apagado no envio seguinte (resposta 404/410).
-- A chave da loja (VAPID) fica no kv_store_48db9b7e, chave "admin_push_vapid", criada pelo servidor.
-- Só o servidor (service_role) lê e escreve.

create table public.admin_push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  device text not null default '' check (length(device) <= 40),
  topics text[] not null default array['sales', 'pending', 'security']
    check (topics <@ array['sales', 'pending', 'security']),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error text check (length(last_error) <= 300),
  last_error_at timestamptz
);

alter table public.admin_push_subscriptions enable row level security;
revoke all on public.admin_push_subscriptions from public, anon, authenticated;
grant all on public.admin_push_subscriptions to service_role;

-- Venda nova: uma notificação por pedido. O servidor marca a hora antes de mandar
-- (PATCH ... admin_push_sent_at=is.null): se o aviso de pagamento chegar repetido, não manda de novo.
alter table public.orders add column admin_push_sent_at timestamptz;
