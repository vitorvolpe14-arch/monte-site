-- Cupons de desconto da MONTÊ (aplicado no Supabase como a migração "monte_coupons").
--
-- Cada cupom é de porcentagem ou de valor em R$, tem validade (início e fim opcionais) e
-- um limite de pessoas que podem usar (1 = cupom único). Uma mesma pessoa (CPF ou e-mail)
-- nunca usa o mesmo cupom duas vezes.
--
-- O uso é ligado ao pedido: conta enquanto o pedido está aguardando pagamento ou pago.
-- Pedido expirado (2 dias sem pagamento) ou cancelado devolve o cupom.
-- Só o servidor (service_role) lê e grava estas tabelas e funções.

create table public.coupons (
  id bigint generated always as identity primary key,
  code text not null check (code ~ '^[A-Z0-9_-]{3,30}$'),
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  discount_value numeric(10,2) not null check (discount_value > 0),
  max_uses integer not null default 1 check (max_uses between 1 and 100000),
  starts_at timestamptz,
  expires_at timestamptz,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coupons_percent_range check (discount_type <> 'percent' or discount_value <= 100),
  constraint coupons_valid_window check (starts_at is null or expires_at is null or expires_at > starts_at)
);
create unique index coupons_code_key on public.coupons (code);

create table public.coupon_redemptions (
  id bigint generated always as identity primary key,
  coupon_id bigint not null references public.coupons(id) on delete restrict,
  order_id bigint not null unique references public.orders(id) on delete cascade,
  customer_cpf text not null,
  customer_email text not null,
  customer_name text,
  discount_amount numeric(10,2) not null check (discount_amount >= 0),
  created_at timestamptz not null default now()
);
create index coupon_redemptions_coupon_idx on public.coupon_redemptions (coupon_id);

alter table public.orders
  add column coupon_code text,
  add column coupon_discount numeric(10,2);

alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
revoke all on public.coupons, public.coupon_redemptions from public, anon, authenticated;
grant all on public.coupons, public.coupon_redemptions to service_role;

-- Motivo para o cupom não valer para esta pessoa agora (null = pode usar).
create or replace function public.coupon_block_reason(p_coupon public.coupons, p_cpf text, p_email text)
returns text
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_people integer;
begin
  if p_coupon.id is null or not p_coupon.active then
    return 'invalid';
  end if;
  if p_coupon.starts_at is not null and now() < p_coupon.starts_at then
    return 'not_started';
  end if;
  if p_coupon.expires_at is not null and now() >= p_coupon.expires_at then
    return 'expired';
  end if;

  if coalesce(p_cpf, '') <> '' or coalesce(p_email, '') <> '' then
    if exists (
      select 1
      from public.coupon_redemptions r
      join public.orders o on o.id = r.order_id
      where r.coupon_id = p_coupon.id
        and (r.customer_cpf = p_cpf or r.customer_email = lower(p_email))
        and o.status in ('paid', 'processing', 'shipped', 'delivered')
    ) then
      return 'already_used';
    end if;
  end if;

  -- Pessoas que já usaram ou estão com um pedido aguardando pagamento. A própria pessoa
  -- não conta: ela pode refazer o checkout enquanto o pedido anterior não foi pago.
  select count(distinct r.customer_cpf) into v_people
  from public.coupon_redemptions r
  join public.orders o on o.id = r.order_id
  where r.coupon_id = p_coupon.id
    and o.status in ('pending', 'paid', 'processing', 'shipped', 'delivered')
    and r.customer_cpf is distinct from p_cpf
    and r.customer_email is distinct from lower(p_email);

  if v_people >= p_coupon.max_uses then
    return 'exhausted';
  end if;

  return null;
end;
$function$;

-- Consulta (sem reservar): usada pela sacola e antes de criar o pedido.
create or replace function public.check_coupon(p_code text, p_cpf text default null, p_email text default null)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_coupon public.coupons%rowtype;
  v_reason text;
begin
  select * into v_coupon from public.coupons where code = upper(trim(p_code));
  v_reason := public.coupon_block_reason(v_coupon, p_cpf, p_email);
  if v_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;
  return jsonb_build_object(
    'ok', true,
    'coupon', jsonb_build_object(
      'id', v_coupon.id,
      'code', v_coupon.code,
      'discount_type', v_coupon.discount_type,
      'discount_value', v_coupon.discount_value
    )
  );
end;
$function$;

-- Registra o uso no pedido. A trava no cupom (for update) faz dois checkouts ao mesmo
-- tempo serem conferidos um depois do outro: um cupom único nunca sai para duas pessoas.
create or replace function public.claim_coupon(
  p_coupon_id bigint,
  p_order_id bigint,
  p_cpf text,
  p_email text,
  p_name text,
  p_discount numeric
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_coupon public.coupons%rowtype;
  v_reason text;
begin
  select * into v_coupon from public.coupons where id = p_coupon_id for update;
  v_reason := public.coupon_block_reason(v_coupon, p_cpf, p_email);
  if v_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;

  insert into public.coupon_redemptions (coupon_id, order_id, customer_cpf, customer_email, customer_name, discount_amount)
  values (v_coupon.id, p_order_id, p_cpf, lower(p_email), p_name, p_discount);

  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.coupon_block_reason(public.coupons, text, text) from public, anon, authenticated;
revoke all on function public.check_coupon(text, text, text) from public, anon, authenticated;
revoke all on function public.claim_coupon(bigint, bigint, text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.coupon_block_reason(public.coupons, text, text) to service_role;
grant execute on function public.check_coupon(text, text, text) to service_role;
grant execute on function public.claim_coupon(bigint, bigint, text, text, text, numeric) to service_role;
