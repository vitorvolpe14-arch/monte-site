-- Cliente que já comprou: a sacola busca a última compra paga pelo CPF (POST /api/clientes/codigo)
-- para mandar o código ao e-mail do cadastro e, com ele, preencher os dados.
-- Aplicado no Supabase como a migração "monte_orders_customer_cpf_paid".
-- O código fica no kv_store_48db9b7e (chave customer_code:<hash do CPF>), sem tabela nova.
create index if not exists orders_customer_cpf_paid_idx
  on public.orders (customer_cpf, paid_at desc)
  where paid_at is not null;
