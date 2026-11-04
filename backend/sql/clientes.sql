-- Cliente que já comprou: a sacola busca a última compra paga pelo CPF (POST /api/clientes/buscar)
-- e preenche os dados (e-mail, WhatsApp e número do endereço voltam escondidos; o checkout completa).
-- Aplicado no Supabase como a migração "monte_orders_customer_cpf_paid".
-- O cadastro usado fica no kv_store_48db9b7e (chave customer_profile:<hash do CPF>), sem tabela nova.
create index if not exists orders_customer_cpf_paid_idx
  on public.orders (customer_cpf, paid_at desc)
  where paid_at is not null;
