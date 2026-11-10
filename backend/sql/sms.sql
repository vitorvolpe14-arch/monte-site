-- Campanhas de SMS do painel (aba SMS), enviadas pela Mobizon
-- (aplicado no Supabase como a migração "monte_sms_campaigns").
--
-- sms_campaigns: cada disparo do painel (texto, público e quantos SMS cada mensagem gasta).
-- sms_messages: uma linha por número. O painel manda em lotes pequenos (o Worker faz no
--   máximo 50 chamadas externas por requisição): sms_claim_batch separa o próximo lote e o
--   marca como "sending" antes de chamar a Mobizon, para o mesmo número nunca receber duas
--   vezes (duas abas abertas, clique repetido). Se a resposta da Mobizon se perder, a linha
--   fica "sending" e não é reenviada.
-- sms_optouts: quem pediu para não receber mais. Nunca entra num disparo, nem num que já
--   estava na fila quando a pessoa saiu.
-- Só o servidor (service_role) lê e grava estas tabelas e funções.

create table public.sms_campaigns (
  id bigint generated always as identity primary key,
  text text not null check (char_length(text) between 1 and 1000),
  audience text[] not null default '{}',
  encoding text not null check (encoding in ('gsm', 'unicode')),
  segments integer not null check (segments between 1 and 10),
  recipients integer not null default 0 check (recipients >= 0),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.sms_messages (
  id bigint generated always as identity primary key,
  campaign_id bigint not null references public.sms_campaigns(id) on delete cascade,
  -- Celular brasileiro no formato internacional, sem o "+": 55 + DDD + 9 dígitos.
  phone text not null check (phone ~ '^55[1-9]{2}9[0-9]{8}$'),
  name text,
  source text not null check (source in ('compradora', 'nao_pagou', 'lista')),
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped')),
  provider_id text,
  provider_status text,
  error text,
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (campaign_id, phone)
);
create index sms_messages_queue_idx on public.sms_messages (campaign_id, id) where status = 'queued';
create index sms_messages_sent_idx on public.sms_messages (campaign_id, id) where status = 'sent';

create table public.sms_optouts (
  phone text primary key check (phone ~ '^55[1-9]{2}9[0-9]{8}$'),
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now()
);

alter table public.sms_campaigns enable row level security;
alter table public.sms_messages enable row level security;
alter table public.sms_optouts enable row level security;
revoke all on public.sms_campaigns, public.sms_messages, public.sms_optouts from public, anon, authenticated;
grant all on public.sms_campaigns, public.sms_messages, public.sms_optouts to service_role;

-- Próximo lote da fila: quem saiu da lista vira "skipped"; os demais (até p_limit, no máximo
-- 25) passam para "sending" e voltam para o servidor mandar.
create or replace function public.sms_claim_batch(p_campaign bigint, p_limit integer)
returns setof public.sms_messages
language plpgsql
set search_path to 'public'
as $function$
begin
  update public.sms_messages m
     set status = 'skipped', error = 'Saiu da lista de SMS', updated_at = now()
   where m.campaign_id = p_campaign
     and m.status = 'queued'
     and exists (select 1 from public.sms_optouts o where o.phone = m.phone);

  return query
  update public.sms_messages m
     set status = 'sending', updated_at = now()
   where m.id in (
     select q.id
       from public.sms_messages q
      where q.campaign_id = p_campaign
        and q.status = 'queued'
      order by q.id
      limit greatest(1, least(coalesce(p_limit, 1), 25))
      for update skip locked
   )
  returning m.*;
end;
$function$;

-- Grava o resultado de vários SMS de uma vez: [{id, status, provider_id, provider_status, error, sent}].
create or replace function public.sms_save_results(p_results jsonb)
returns integer
language sql
set search_path to 'public'
as $function$
  with r as (
    select *
      from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
        as x(id bigint, status text, provider_id text, provider_status text, error text, sent boolean)
  ), u as (
    update public.sms_messages m
       set status = coalesce(r.status, m.status),
           provider_id = coalesce(r.provider_id, m.provider_id),
           provider_status = coalesce(r.provider_status, m.provider_status),
           error = case when r.status in ('sent', 'delivered') then null else coalesce(r.error, m.error) end,
           sent_at = case when r.sent then coalesce(m.sent_at, now()) else m.sent_at end,
           updated_at = now()
      from r
     where m.id = r.id
    returning 1
  )
  select count(*)::integer from u;
$function$;

-- Campanhas com a contagem de cada situação (as mais recentes primeiro).
create or replace function public.sms_campaigns_summary(p_limit integer)
returns table (
  id bigint, text text, audience text[], encoding text, segments integer, recipients integer,
  created_at timestamptz, finished_at timestamptz,
  queued integer, sending integer, sent integer, delivered integer, failed integer, skipped integer
)
language sql
stable
set search_path to 'public'
as $function$
  select c.id, c.text, c.audience, c.encoding, c.segments, c.recipients, c.created_at, c.finished_at,
         count(*) filter (where m.status = 'queued')::integer,
         count(*) filter (where m.status = 'sending')::integer,
         count(*) filter (where m.status = 'sent')::integer,
         count(*) filter (where m.status = 'delivered')::integer,
         count(*) filter (where m.status = 'failed')::integer,
         count(*) filter (where m.status = 'skipped')::integer
    from public.sms_campaigns c
    left join public.sms_messages m on m.campaign_id = c.id
   group by c.id
   order by c.created_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 100));
$function$;

revoke all on function public.sms_claim_batch(bigint, integer) from public, anon, authenticated;
revoke all on function public.sms_save_results(jsonb) from public, anon, authenticated;
revoke all on function public.sms_campaigns_summary(integer) from public, anon, authenticated;
grant execute on function public.sms_claim_batch(bigint, integer) to service_role;
grant execute on function public.sms_save_results(jsonb) to service_role;
grant execute on function public.sms_campaigns_summary(integer) to service_role;
