-- Relatório de Vendas da InfinitePay no painel (aplicado no Supabase como a migração
-- "monte_infinitepay_transactions").
--
-- A InfinitePay não tem um extrato que o servidor possa consultar. O dono da loja baixa o
-- "Relatório de Vendas" em PDF no app, envia no painel (Visão geral) e o painel grava aqui
-- cada transação. Com isso o líquido do painel fica igual ao da conta da InfinitePay, também
-- nas vendas feitas fora do site (link de pagamento, Pix na conta, InfiniteTap).
-- Sem dados pessoais: só data, meio, tipo, código da transação e valores.
-- Só o servidor (service_role) lê e grava esta tabela.

create table if not exists public.infinitepay_transactions (
  key text primary key,                     -- data|hora|tipo|meio|parcelas|valor|identificador|n
  data date not null,                       -- dia da venda (horário de Brasília, como no relatório)
  hora text,                                -- HH:MM
  meio text,                                -- Crédito, Débito, Pix
  tipo text,                                -- Link Integrado (site), Link de Pagamento, Conta Inteligente,
                                            -- InfiniteTap, Cobrança
  identificador text,                       -- código da transação na InfinitePay
  parcelas smallint not null default 1,
  status text not null,                     -- Aprovada, Cancelada, Negada...
  valor numeric(12,2) not null,             -- valor cobrado (com os juros, quando a cliente paga)
  liquido numeric(12,2) not null,           -- o que cai na conta
  taxa numeric(12,2) not null default 0,
  taxa_percentual numeric(6,2),
  plano text,                               -- 1 Dia Útil, Outro...
  batch text not null,                      -- importação que gravou a linha
  imported_at timestamptz not null default now()
);
create index if not exists infinitepay_transactions_data_idx on public.infinitepay_transactions (data desc);
create index if not exists infinitepay_transactions_batch_idx on public.infinitepay_transactions (batch);

alter table public.infinitepay_transactions enable row level security;
revoke all on public.infinitepay_transactions from public, anon, authenticated;
grant all on public.infinitepay_transactions to service_role;

-- Os períodos já conferidos ficam no kv_store_48db9b7e, chave "infinitepay_report".
-- O relatório de 04/11/2026 (vendas desde 18/02/2026) foi gravado direto no banco na criação
-- da tabela: as 621 vendas aprovadas, lote "relatorio-20261104". Os próximos vêm pelo painel.
