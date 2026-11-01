-- Links curtos da loja (aplicado no Supabase como a migração "monte_short_links").
--
-- As mensagens de WhatsApp para a cliente levam oficialmontee.com.br/s/<código> em vez do
-- link longo da sacola (?sacola=...&utm_...). O site troca o código pelo endereço da sacola.
-- target é sempre um endereço do próprio site começando com "/?" (nunca outro domínio).
-- Os links valem 30 dias e são apagados depois (rotina das 3 horas).
-- Só o servidor (service_role) lê e grava esta tabela.

create table if not exists public.short_links (
  code text primary key check (code ~ '^[A-Za-z0-9]{6,12}$'),
  target text not null check (target like '/?%' and char_length(target) <= 2000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
create index if not exists short_links_expires_idx on public.short_links (expires_at);

alter table public.short_links enable row level security;
revoke all on public.short_links from public, anon, authenticated;
grant all on public.short_links to service_role;
