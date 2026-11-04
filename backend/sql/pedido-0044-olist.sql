-- Pedido MONTÊ-0044 ligado ao pedido nº 175 da Olist (correção de dados, aplicada em 04/11/2026).
--
-- O envio automático deste pedido para a Olist deu erro (10/10/2026) e a loja lançou a venda à
-- mão na Olist (pedido nº 175, id 363658894, R$ 999,53 = valor pago em 10x). Sem o vínculo, a
-- Visão geral contava a venda duas vezes em "Site + Olist" (no site e como venda da loja).
-- Com o olist_order_id, a importação das vendas da Olist marca esse pedido como do site.
-- O pedido já está entregue: o site não reenvia para a Olist (só reenvia pedidos "paid").

update public.orders
set olist_order_id = 363658894, olist_sync_status = 'completed', olist_sync_error = null
where id = 53 and olist_order_id is null and status = 'delivered';

update public.olist_sales set from_site = true where id = 363658894;
