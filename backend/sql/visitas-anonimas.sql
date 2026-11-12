-- Contagem anônima de visitas (aplicado no Supabase como a migração "monte_anonymous_visit_counts").
--
-- Vale para todas as visitantes, com ou sem a permissão de cookies (legítimo interesse, LGPD
-- art. 7º, IX). Não há código de identificação, IP nem navegador: só o total de cada dia por
-- tipo de aviso, origem da visita e celular/computador (backend/anonymous-visits.js).
--   event:  visit (entrada no site), page_view, cart (pôs peça na sacola), checkout (começou o checkout)
--   source: instagram, facebook, google, whatsapp, sms, tiktok, email, youtube, pinterest, x,
--           buscador, outros, campanha, direto; "-" nos avisos que não são entrada no site
--   device: mobile ou desktop
-- Só o servidor (service_role) lê e escreve. Os totais ficam 25 meses (comparar com o ano anterior);
-- a limpeza roda junto com a das estatísticas (purgeExpiredAnalytics em backend/server.js).

create table public.site_hits_daily (
  day date not null,
  event text not null check (event in ('visit', 'page_view', 'cart', 'checkout')),
  source text not null check (source ~ '^[a-z-]{1,20}$'),
  device text not null check (device in ('mobile', 'desktop')),
  hits integer not null default 0 check (hits >= 0),
  primary key (day, event, source, device)
);

alter table public.site_hits_daily enable row level security;
revoke all on public.site_hits_daily from public, anon, authenticated;
grant all on public.site_hits_daily to service_role;

-- Soma 1 no total do dia (cria a linha na primeira visita do dia).
create function public.increment_site_hit(p_day date, p_event text, p_source text, p_device text)
returns void
language sql
set search_path to 'public'
as $function$
  insert into public.site_hits_daily (day, event, source, device, hits)
  values (p_day, p_event, p_source, p_device, 1)
  on conflict (day, event, source, device) do update set hits = public.site_hits_daily.hits + 1;
$function$;

revoke all on function public.increment_site_hit(date, text, text, text) from public, anon, authenticated;
grant execute on function public.increment_site_hit(date, text, text, text) to service_role;
