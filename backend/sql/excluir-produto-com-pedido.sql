-- Excluir produto que já tem pedido (aplicado no Supabase como a migração "monte_delete_product_with_orders").
--
-- Os itens dos pedidos guardam uma fotografia da venda (nome, cor, SKU, quantidade e valor),
-- então o pedido continua completo no painel mesmo sem a peça no catálogo. A ligação
-- order_items.variant_id -> product_variants impedia apagar uma cor que já foi vendida; ela sai,
-- e o variant_id antigo fica guardado no item (como já acontece com order_items.product_id).

alter table public.order_items drop constraint if exists order_items_variant_id_fkey;

-- Pedido expirado ainda pode ser pago depois. Se uma peça dele foi excluída nesse meio-tempo,
-- o pagamento é confirmado normalmente e só a baixa de estoque dessa peça é pulada (ela volta
-- em "missing_variants", no log do servidor). Antes, o erro travava a confirmação do pagamento.
create or replace function public.decrement_order_stock(p_order_id bigint)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_updated_id uuid;
  v_missing jsonb := '[]'::jsonb;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido % não encontrado.', p_order_id;
  end if;

  if v_order.stock_decremented then
    return jsonb_build_object('success', true, 'already_processed', true);
  end if;

  for v_item in
    select oi.variant_id, oi.quantity,
           exists (
             select 1
             from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) e
             where e->>'variant_id' = oi.variant_id::text
               and coalesce((e->>'presale')::boolean, false)
           ) as presale
    from public.order_items oi
    where oi.order_id = p_order_id
  loop
    if v_item.variant_id is null then
      raise exception 'Item do pedido % está sem variant_id.', p_order_id;
    end if;

    if v_item.presale then
      continue;
    end if;

    -- Peça excluída do catálogo depois do pedido: não há estoque para baixar.
    if not exists (select 1 from public.product_variants where id = v_item.variant_id) then
      v_missing := v_missing || to_jsonb(v_item.variant_id::text);
      continue;
    end if;

    v_updated_id := null;
    update public.product_variants
    set stock = stock - v_item.quantity,
        updated_at = now()
    where id = v_item.variant_id
      and active = true
      and stock >= v_item.quantity
    returning id into v_updated_id;

    if v_updated_id is null then
      raise exception 'Estoque insuficiente para a variação % no pedido %.', v_item.variant_id, p_order_id;
    end if;
  end loop;

  update public.orders
  set stock_decremented = true,
      updated_at = now()
  where id = p_order_id;

  return jsonb_build_object('success', true, 'already_processed', false, 'missing_variants', v_missing);
end;
$function$;
