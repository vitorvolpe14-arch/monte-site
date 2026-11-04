-- Vendas da Olist no painel (aplicado no Supabase como a migração "monte_olist_sales").
--
-- O servidor lê os pedidos da Olist (API v3) de tempos em tempos e guarda aqui um resumo,
-- para a Visão geral mostrar também o que foi vendido fora do site (loja, PDV, WhatsApp...).
-- Os pedidos que o próprio site criou na Olist ficam marcados com from_site = true e não
-- entram como "fora do site" (o painel já conta esses pelos pedidos do site).
-- Sem dados pessoais: nem nome, CPF, e-mail ou endereço da cliente.
-- Só o servidor (service_role) lê e grava esta tabela.

create table if not exists public.olist_sales (
  id bigint primary key,                        -- id do pedido na Olist
  numero bigint,                                -- número do pedido na Olist
  data date,                                    -- data do pedido
  situacao smallint,                            -- 0 aberta, 1 faturada, 2 cancelada, 3 aprovada, 4 preparando envio,
                                                -- 5 enviada, 6 entregue, 7 pronto para envio, 8 dados incompletos,
                                                -- 9 não entregue, 10 em devolução
  total numeric(12,2) not null default 0,       -- valor do pedido
  origem smallint,                              -- 0 pedido de venda, 1 PDV
  canal text,                                   -- e-commerce / canal de venda informado na Olist
  numero_ecommerce text,                        -- número do pedido no e-commerce (o site usa MONTE-...)
  envio text,                                   -- forma de envio
  from_site boolean not null default false,     -- pedido criado pelo site
  itens jsonb,                                  -- [{sku, descricao, quantidade, valor}] (do detalhe do pedido)
  pagamento text,                               -- meio de pagamento (do detalhe do pedido)
  detail_at timestamptz,                        -- quando o detalhe foi lido
  updated_at timestamptz not null default now()
);
create index if not exists olist_sales_data_idx on public.olist_sales (data desc);

alter table public.olist_sales enable row level security;
revoke all on public.olist_sales from public, anon, authenticated;
grant all on public.olist_sales to service_role;
