-- Vendas do pedido MONTÊ-0072 que a Olist já baixou (correção de dados, aplicada em 05/11/2026).
--
-- A cliente comprou no site, em 04/11 às 09:16, a Bag Cambridge caramelo (CMBRID-2) e o
-- Cinto Eslováquia café (CNTSLV-1). A Olist baixou as duas peças minutos depois (caramelo
-- 2 → 1 às 09:22, cinto 3 → 2 às 10:03, pelo histórico de estoque do site), mas a
-- sincronização descontava a venda de novo enquanto o pedido não fosse enviado: o site
-- ficou com caramelo 0 (Olist 1) e cinto 1 (Olist 2).
--
-- A sincronização agora guarda, em cada cor, quantas vendas do site estão na lista (sold)
-- e quantas a Olist ainda não baixou (pend) — veja backend/olist-stock-waiting.js. Antes
-- da mudança não havia esse registro, então estas duas cores recebem o dele à mão:
-- 1 venda na lista, 0 aguardando a Olist. A Bag Versailles Soft rosa (VRSPNK02), do mesmo
-- pedido, fica como está: está com 0 no site e 0 na Olist.
--
-- Aplicar DEPOIS da publicação da mudança (o código anterior regravava a conferência sem o
-- "sold") e fora de um lote da sincronização (lease_until no passado), para o lote não
-- regravar o estado lido antes. Se não atualizar nenhuma linha, rodar de novo em instantes.

update public.kv_store_48db9b7e
set value = jsonb_set(
      jsonb_set(
        value,
        '{snapshot,variants,72822e6a-660d-4601-bad6-e67e200468e9}',
        (value #> '{snapshot,variants,72822e6a-660d-4601-bad6-e67e200468e9}') || '{"sold":1,"pend":0}'::jsonb
      ),
      '{snapshot,variants,b479d9a1-b27b-4e2c-b9a1-865169578967}',
      (value #> '{snapshot,variants,b479d9a1-b27b-4e2c-b9a1-865169578967}') || '{"sold":1,"pend":0}'::jsonb
    )
where key = 'olist_stock_sync'
  and coalesce((value ->> 'lease_until')::bigint, 0) < (extract(epoch from now()) * 1000)::bigint
  and value #> '{snapshot,variants}' ? '72822e6a-660d-4601-bad6-e67e200468e9'
  and value #> '{snapshot,variants}' ? 'b479d9a1-b27b-4e2c-b9a1-865169578967';
