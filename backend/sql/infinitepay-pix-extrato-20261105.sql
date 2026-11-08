-- Pix de R$ 27,91 recebido na conta da InfinitePay em 05/11/2026 às 13:13, tirado do
-- "Relatório de movimentações" (extrato) de 01 a 08/11/2026 que o dono da loja enviou.
-- Não está no site nem na Olist, e o dono confirmou que é venda: entra no líquido do painel.
--
-- A linha segue o formato que o "Relatório de Vendas" grava para um Pix na conta (Conta
-- Inteligente, plano "Outro"), mas sem o código da transação, que o extrato não traz. Quando um
-- Relatório de Vendas que cubra 05/11 for enviado no painel, a importação apaga as linhas do
-- período gravadas por outra importação (esta inclusa) e grava a dele: o Pix não conta duas vezes.
--
-- A fatura do cartão de crédito (R$ 25,00) paga com o saldo no mesmo dia não é venda e fica
-- fora do líquido.

insert into public.infinitepay_transactions
  (key, data, hora, meio, tipo, identificador, parcelas, status, valor, liquido, taxa, taxa_percentual, plano, batch)
values
  ('2026-11-05|13:13|Conta Inteligente|Pix|1|27.91||0', '2026-11-05', '13:13', 'Pix', 'Conta Inteligente', null, 1,
   'Aprovada', 27.91, 27.91, 0, 0, 'Outro', 'extrato-20261108')
on conflict (key) do nothing;
