-- Como cada venda da Olist foi paga (aplicado no Supabase como a migração "monte_olist_sales_payment_info").
--
-- O detalhe do pedido da Olist traz a forma de recebimento, o meio de pagamento, a condição
-- (ex.: "30 60 90") e as parcelas. O painel usa isso para estimar a taxa da maquininha da
-- InfinitePay nas vendas da loja (Pix, débito ou crédito em N vezes) e mostrar o líquido.
-- Só nomes e números: as observações das parcelas, que podem ter dados da cliente, ficam de fora.
-- Formato: {"forma", "meio", "condicao", "parcelas", "meios_parcelas": [...], "dias": [...]}

alter table public.olist_sales add column if not exists pagamento_info jsonb;

-- Depois de publicar o servidor que grava o campo, os detalhes já importados são lidos de novo:
-- update public.olist_sales set detail_at = null where detail_at is not null and pagamento_info is null;
