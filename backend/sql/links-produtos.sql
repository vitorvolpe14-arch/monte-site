-- Link curto fixo de cada bolsa (aplicado no Supabase como a migração "monte_product_short_codes").
--
-- products.short_code: oficialmontee.com.br/p/<código>. A página mostra a foto e o nome da
-- bolsa na prévia (WhatsApp, Instagram) e leva a cliente para a loja com a bolsa aberta.
-- O painel mostra o link em cada produto, com o botão COPIAR LINK. O código é criado
-- sozinho para cada produto novo e não muda quando o produto é editado.

create or replace function public.monte_short_code(len int default 6)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text := '';
begin
  for i in 1..len loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return code;
end;
$$;
revoke all on function public.monte_short_code(int) from public, anon, authenticated;
grant execute on function public.monte_short_code(int) to service_role;

alter table public.products add column if not exists short_code text;
update public.products set short_code = public.monte_short_code(6) where short_code is null;
alter table public.products alter column short_code set default public.monte_short_code(6);
alter table public.products alter column short_code set not null;
alter table public.products add constraint products_short_code_key unique (short_code);
alter table public.products add constraint products_short_code_format check (short_code ~ '^[A-Za-z0-9]{6,12}$');
