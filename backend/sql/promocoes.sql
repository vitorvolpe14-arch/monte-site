-- Promoções de presente da MONTÊ (aplicado no Supabase como a migração "monte_promotions").
--
-- Cada promoção dá um presente à escolha da cliente (uma peça da categoria escolhida, com
-- estoque) quando as peças da compra somam pelo menos min_subtotal. O frete não conta.
-- A loja define início e fim no painel (aba Promoções). Com mais de uma promoção no ar,
-- elas viram degraus: vale o presente do maior degrau alcançado.
-- Só o servidor (service_role) lê e grava esta tabela.

create table public.promotions (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 2 and 80),
  kind text not null default 'gift_choice' check (kind in ('gift_choice')),
  min_subtotal numeric(10,2) not null check (min_subtotal > 0),
  gift_category text not null check (gift_category in ('cintos', 'acessorios', 'bolsas')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default true,
  banner_text text check (banner_text is null or char_length(banner_text) <= 90),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint promotions_valid_window check (ends_at > starts_at)
);
create index promotions_window_idx on public.promotions (active, ends_at);

alter table public.promotions enable row level security;
revoke all on public.promotions from public, anon, authenticated;
grant all on public.promotions to service_role;

-- Promoção de novembro de 2026: cinto de presente a partir de R$ 499 em peças.
insert into public.promotions (name, min_subtotal, gift_category, starts_at, ends_at, banner_text)
values (
  'Cinto de presente em novembro',
  499,
  'cintos',
  '2026-11-01 00:00:00-03',
  '2026-12-01 00:00:00-03',
  'NOVEMBRO: GANHE UM CINTO NAS COMPRAS A PARTIR DE R$ 499'
);

-- Aviso para a cliente sobre o presente (migração "monte_promotions_terms"), por exemplo
-- "Durante a ação, não fazemos troca do brinde." Aparece na escolha do presente, na
-- sacola e no e-mail de confirmação.
alter table public.promotions
  add column terms_text text check (terms_text is null or char_length(terms_text) <= 200);
