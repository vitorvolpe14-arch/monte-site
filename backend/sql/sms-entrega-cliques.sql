-- SMS: entrega automática (webhook da Mobizon), cliques no link e configurações
-- (aplicado no Supabase como a migração "monte_sms_delivery_clicks"). Vem depois de sms.sql.
--
-- sms_campaigns.track_links: a Mobizon encurta o link de cada SMS (um link por pessoa) e
--   conta os cliques. Cada SMS enviado pelo site vira uma campanha na Mobizon
--   (provider_campaign_id); os cliques de cada pessoa são os do link dessa campanha.
-- sms_save_delivery: grava a situação de entrega que o webhook da Mobizon manda (pelo id da
--   mensagem) e anota no kv_store a hora do último aviso, para o painel mostrar que está ligado.
-- As configurações (valor do aviso de saldo baixo e a chave secreta do webhook) ficam no
--   kv_store_48db9b7e, chave "sms_settings".

alter table public.sms_campaigns
  add column track_links boolean not null default false;

alter table public.sms_messages
  add column provider_campaign_id text,
  add column clicks integer check (clicks is null or clicks >= 0),
  add column clicks_checked_at timestamptz;

create index sms_messages_provider_idx on public.sms_messages (provider_id) where provider_id is not null;

-- Situação de entrega vinda do webhook. Devolve quantos SMS do painel foram atualizados
-- (0 = mensagem que não saiu pelo painel, ou cujo lote ainda não foi gravado).
create or replace function public.sms_save_delivery(p_provider_id text, p_provider_status text, p_status text, p_error text)
returns integer
language plpgsql
set search_path to 'public'
as $function$
declare
  v_count integer;
begin
  update public.sms_messages m
     set status = p_status,
         provider_status = p_provider_status,
         error = case when p_status in ('sent', 'delivered') then null else coalesce(p_error, m.error) end,
         updated_at = now()
   where m.provider_id = p_provider_id
     and m.status in ('sent', 'delivered', 'failed');
  get diagnostics v_count = row_count;

  insert into public.kv_store_48db9b7e (key, value)
  values ('sms_webhook_last', jsonb_build_object('at', now()))
  on conflict (key) do update set value = excluded.value;

  return v_count;
end;
$function$;

-- Também grava a campanha da Mobizon de cada SMS e os cliques.
create or replace function public.sms_save_results(p_results jsonb)
returns integer
language sql
set search_path to 'public'
as $function$
  with r as (
    select *
      from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
        as x(id bigint, status text, provider_id text, provider_status text, error text, sent boolean,
             provider_campaign_id text, clicks integer, clicks_checked boolean)
  ), u as (
    update public.sms_messages m
       set status = coalesce(r.status, m.status),
           provider_id = coalesce(r.provider_id, m.provider_id),
           provider_status = coalesce(r.provider_status, m.provider_status),
           provider_campaign_id = coalesce(r.provider_campaign_id, m.provider_campaign_id),
           error = case when r.status in ('sent', 'delivered') then null else coalesce(r.error, m.error) end,
           sent_at = case when r.sent then coalesce(m.sent_at, now()) else m.sent_at end,
           clicks = coalesce(r.clicks, m.clicks),
           clicks_checked_at = case when r.clicks_checked then now() else m.clicks_checked_at end,
           updated_at = now()
      from r
     where m.id = r.id
    returning 1
  )
  select count(*)::integer from u;
$function$;

-- O resumo ganha os cliques: quantas pessoas clicaram e o total de cliques.
drop function public.sms_campaigns_summary(integer);
create function public.sms_campaigns_summary(p_limit integer)
returns table (
  id bigint, text text, audience text[], encoding text, segments integer, recipients integer,
  created_at timestamptz, finished_at timestamptz, track_links boolean,
  queued integer, sending integer, sent integer, delivered integer, failed integer, skipped integer,
  clicked integer, clicks integer, clicks_checked_at timestamptz
)
language sql
stable
set search_path to 'public'
as $function$
  select c.id, c.text, c.audience, c.encoding, c.segments, c.recipients, c.created_at, c.finished_at, c.track_links,
         count(*) filter (where m.status = 'queued')::integer,
         count(*) filter (where m.status = 'sending')::integer,
         count(*) filter (where m.status = 'sent')::integer,
         count(*) filter (where m.status = 'delivered')::integer,
         count(*) filter (where m.status = 'failed')::integer,
         count(*) filter (where m.status = 'skipped')::integer,
         count(*) filter (where m.clicks > 0)::integer,
         coalesce(sum(m.clicks), 0)::integer,
         max(m.clicks_checked_at)
    from public.sms_campaigns c
    left join public.sms_messages m on m.campaign_id = c.id
   group by c.id
   order by c.created_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$function$;

revoke all on function public.sms_save_delivery(text, text, text, text) from public, anon, authenticated;
revoke all on function public.sms_save_results(jsonb) from public, anon, authenticated;
revoke all on function public.sms_campaigns_summary(integer) from public, anon, authenticated;
grant execute on function public.sms_save_delivery(text, text, text, text) to service_role;
grant execute on function public.sms_save_results(jsonb) to service_role;
grant execute on function public.sms_campaigns_summary(integer) to service_role;
