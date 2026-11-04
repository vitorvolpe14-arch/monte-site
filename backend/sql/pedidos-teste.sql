-- Pedidos de teste (aplicado no Supabase como a migração "monte_order_is_test").
--
-- Pedidos marcados como teste ficam fora da Visão geral e do Analytics do painel e
-- escondidos na lista de Pedidos (com a opção de mostrar). Nada é apagado: o pedido
-- continua no banco e pode ser desmarcado no painel (detalhes do pedido → NÃO É TESTE).

alter table public.orders add column if not exists is_test boolean not null default false;

-- Testes que a própria loja fez com o e-mail da loja, de 23/09 a 04/11/2026: compras de
-- R$ 0,10 a R$ 1,50 em peças, os primeiros pedidos de cartão e os links de pagamento.
-- Os pedidos de clientes (a partir de 08/10) não entram aqui.
update public.orders
set is_test = true
where id in (10, 11, 12, 13, 14, 15, 16, 17, 28, 29, 30, 40, 41, 42, 43, 44, 47, 48, 67, 87, 88);
