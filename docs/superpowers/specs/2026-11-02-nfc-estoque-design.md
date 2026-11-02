# Entrada e saída de bolsas por NFC (iPhone) — design

Data: 2026-11-02 · Status: aguardando revisão da dona da loja

## 1. Objetivo

Hoje a MONTÊ lança à mão, na Olist, três movimentos de estoque:

1. **Entrada** das bolsas que chegam do fornecedor;
2. **Saída para influenciadora** (envio de cortesia);
3. **Venda fora do site** (venda avulsa).

Muitas saídas são esquecidas. O objetivo é que cada movimento seja feito
**encostando o iPhone numa etiqueta NFC escondida na bolsa**, sem digitar,
e que a Olist e o site fiquem sempre iguais.

**Sucesso:** dar saída numa bolsa em ~2 toques; nenhum movimento some sem aviso;
o estoque da Olist e o do site batem no máximo 1 minuto depois.

## 2. Decisões tomadas na conversa

- **NFC, não QR.** Nenhum código visível na bolsa (estética). Gravar as
  etiquetas não é problema para a dona.
- **Uma etiqueta por modelo e cor (SKU), igual para todas as bolsas daquele SKU.**
  Produto novo = gravar etiquetas novas daquele SKU.
- **Etiqueta**: adesivo NTAG213/NTAG215 (~25 mm), colado no forro, longe da
  ferragem. Gravado pelo app NFC Tools com um único registro de link:
  `https://oficialmontee.com.br/n/<SKU>`.
- **Influenciadora**: só baixa o estoque na Olist (com o nome dela na observação).
- **Venda fora do site**: cria o pedido na Olist **e** baixa o estoque por esse pedido.
- **Entrada**: lança entrada de estoque na Olist.
- A Olist continua sendo a dona do estoque; o site segue a Olist (rotina que já existe).

## 3. Limite do iPhone (registrado para não virar surpresa)

O Safari não lê NFC dentro da página (Web NFC não existe no iOS). O iPhone lê a
etiqueta em segundo plano: ao encostar, aparece uma notificação e, ao tocar nela,
o Safari abre o link. Portanto o fluxo é **encostar + tocar na notificação**.
Cada leitura abre uma aba nova no Safari; isso é aceito.

## 4. Como a dona usa

### 4.1 Modo atual

Na aba nova **Movimentar** do `/admin`, ela escolhe o modo, que fica guardado no
celular (localStorage, por aparelho) até ela trocar:

- **Entrada** (observação opcional, ex.: nome do fornecedor);
- **Saída · Influenciadora** — escolhe o nome numa lista (que o sistema guarda
  e vai crescendo) ou digita um novo;
- **Venda avulsa**.

O modo aparece sempre no topo da página de leitura, com cor diferente para cada
um (para ela nunca dar entrada achando que está dando saída).

### 4.2 Encostar na bolsa → página `/n/<SKU>`

| Situação | O que acontece |
|---|---|
| Não está logada no admin | Redireciona para a página do produto no site (cliente que encostar o celular vê a bolsa). |
| Logada, SKU não existe | Mensagem "Etiqueta sem produto: <SKU>" e link para a aba Movimentar. |
| Logada, modo **Entrada** | Lança na hora. Mostra foto, nome, cor, "✓ Entrada lançada · estoque agora N" e **Desfazer** (15 s). |
| Logada, modo **Influenciadora** | Lança na hora. "✓ Saída lançada · Influenciadora Maria" e **Desfazer**. |
| Logada, modo **Venda avulsa** | Mostra um formulário curto (ver 4.3). Só lança ao tocar **Confirmar venda**. |
| Nenhum modo escolhido | Pergunta o modo ali mesmo (três botões) e segue. |

**Leitura repetida:** se o mesmo SKU foi lançado pelo mesmo aparelho nos últimos
20 segundos, a página não lança direto: mostra "Você acabou de lançar esta bolsa.
Lançar outra?" com os botões **Lançar mais 1** e **Não**.

### 4.3 Venda avulsa

Formulário em uma tela, com o mínimo de digitação:

- **Valor**: já vem com o preço atual do site (com SALE, se houver); editável.
- **Forma de pagamento**: Pix · Cartão · Dinheiro (botões).
- **Cliente** (opcional): nome e CPF. Sem cliente, o pedido vai para o contato
  "Consumidor final" (criado uma vez na Olist e reaproveitado).
- **Mais uma bolsa**: botão "+ adicionar outra bolsa" mostra "encoste na próxima";
  as próximas leituras em até 3 minutos entram no mesmo pedido (carrinho guardado no
  aparelho). Assim uma cliente que leva duas bolsas gera um pedido só.
- **Confirmar venda** → cria o pedido e baixa o estoque (seção 5.3).

### 4.4 Histórico

A aba Movimentar mostra os últimos movimentos (data, tipo, foto, SKU, quantidade,
influenciadora ou pedido, situação na Olist) com filtros por tipo e por
influenciadora, e um resumo "o que está com cada influenciadora" (soma das
saídas por nome). Linhas com falha mostram **Tentar de novo**.

### 4.5 Sem etiqueta

Na mesma aba, uma busca por nome/cor/SKU com foto permite fazer o mesmo
lançamento sem encostar (bolsa sem etiqueta ou etiqueta estragada).

### 4.6 Gravar etiquetas

Em cada cor do produto, no painel, um botão **Link da etiqueta NFC** copia
`https://oficialmontee.com.br/n/<SKU>` para colar no NFC Tools.

## 5. Como funciona por trás

### 5.1 Rotas novas (backend/server.js)

- `GET /n/:sku` — página de leitura. Sem sessão de admin: redireciona 302 para
  `/produto/<id>/<slug>` (ou `/` se o SKU não existir). Com sessão: devolve a
  página `nfc.html` (estática), que chama a API abaixo. `Cache-Control: no-store`.
  Precisa entrar em `run_worker_first` no `wrangler.jsonc`.
- `GET /api/admin/nfc/variant?sku=` — foto, nome, cor, preço, estoque do SKU.
- `POST /api/admin/nfc/movements` — corpo `{request_id, mode, sku, quantity,
  influencer?, note?}` para Entrada e Influenciadora.
- `POST /api/admin/nfc/sales` — corpo `{request_id, items:[{sku, quantity,
  unit_price}], payment_method, customer?}` para Venda avulsa.
- `POST /api/admin/nfc/movements/:id/undo` — desfaz (seção 5.4).
- `POST /api/admin/nfc/movements/:id/retry` — tenta de novo um movimento com falha.
- `GET /api/admin/nfc/movements` e `GET /api/admin/nfc/influencers`.

Todas com `requireAdmin` (sessão do painel e proteção contra outra origem que já existem).

### 5.2 Entrada e Influenciadora → Olist

1. Acha a variação pelo SKU no Supabase e o produto na Olist pelo
   `olist_product_id` (ou pela busca por SKU, como `olistStockForVariant` já faz).
2. `POST /estoque/{idProduto}` com `tipo` `E` (entrada) ou `S` (saída),
   `quantidade`, `precoUnitario` (custo cadastrado na Olist, ou 0) e
   `observacoes` = "MONTÊ NFC · Entrada" / "MONTÊ NFC · Influenciadora <nome>".
   Guarda o `idLancamento` devolvido.
3. Ajusta o estoque do site na hora pela função `adjust_product_variant_stock`
   (que já registra em `inventory_movements`), para o site não esperar a rotina.
   A rotina de 1 em 1 minuto continua deixando o site igual à Olist.
4. Saída maior que o estoque disponível na Olist: recusa com
   "Estoque da Olist é 0 para este SKU" (não deixa ficar negativo).

### 5.3 Venda avulsa → Olist

1. Contato: CPF informado → acha ou cria (reaproveita `findOrCreateOlistContact`);
   sem CPF → contato "Consumidor final".
2. `POST /pedidos` com os itens (produto da Olist, quantidade, valor), forma de
   recebimento (Pix/Cartão/Dinheiro, pela lista de formas de recebimento da Olist),
   situação aprovada, `numeroOrdemCompra` = código `AVULSA-0001` (sequencial no Supabase) e
   observação "Venda fora do site (NFC)".
3. `POST /pedidos/{id}/lancar-estoque` — a baixa fica ligada ao pedido na Olist.
4. Ajuste imediato do site como em 5.2.
5. Se o passo 3 falhar depois do 2, o movimento fica "pedido criado, estoque
   pendente" e o **Tentar de novo** repete só o passo 3.

Vendas avulsas **não** entram na tabela `orders` do site (não têm pagamento
InfinitePay nem entrega); ficam só no histórico NFC e na Olist.

### 5.4 Desfazer

- Entrada/Influenciadora: lança o movimento contrário na Olist (`S` desfaz `E` e
  vice-versa) com observação "Desfeito", e devolve o estoque do site.
- Venda avulsa: `POST /pedidos/{id}/estornar-estoque` e muda a situação do
  pedido para cancelado.
- Disponível por 15 s na tela de confirmação e, depois, pelo histórico (com
  confirmação "Tem certeza?").

### 5.5 Tabela nova no Supabase — `backend/sql/estoque-nfc.sql`

`nfc_movements`: `id`, `request_id` (único — evita lançar duas vezes no toque
duplo ou na rede lenta), `mode` (`entrada` | `influenciadora` | `venda`),
`variant_id`, `sku`, `quantity`, `influencer`, `note`, `sale_code`,
`olist_launch_id`, `olist_order_id`, `status` (`ok` | `pendente` | `falhou` |
`desfeito`), `error`, `created_by`, `created_at`, `undone_at`.
`nfc_influencers`: `name` (único), `created_at`.
RLS ligada, sem acesso para `anon`/`authenticated` (só o servidor, como as outras tabelas).
Aplicada no projeto antes do merge.

### 5.6 Página `nfc.html` + `nfc.js`

Página leve (sem o painel inteiro) feita para iPhone: modo no topo, foto grande,
resultado, Desfazer. Gera o `request_id` no aparelho antes de enviar. Segue as
cores e fontes do admin.

### 5.7 Limite de chamadas

Cada lançamento usa 2–4 chamadas à Olist; cabe folgado no limite de 50 chamadas
externas por execução do Cloudflare. Se a Olist estiver fora, o movimento fica
"pendente" e a tela avisa em vermelho; o histórico mostra o número de pendentes.

## 6. Testes

- Testes automáticos das rotas novas com a Olist e o Supabase simulados: modo
  certo vira o tipo certo; `request_id` repetido não lança de novo; saída sem
  estoque é recusada; falha da Olist deixa "pendente"; desfazer faz o contrário;
  `/n/<SKU>` sem sessão redireciona para o produto.
- **Teste real antes do merge**, com uma bolsa: entrada +1 e Desfazer
  (saldo volta ao de antes) para confirmar que a conexão da Olist tem permissão de
  lançar estoque. Se não tiver, a dona reconecta a Olist pelo botão que já existe.
  A venda avulsa real é testada pela dona depois do merge, com um pedido de
  teste que ela mesma cancela pelo Desfazer.
- Depois do merge: conferir no site no ar que `/n/<SKU>` abre e redireciona.

## 7. Fora do escopo

- Leitura sem tocar na notificação (limite do iOS).
- Etiqueta única por bolsa (rastrear unidade).
- Entrada por foto da nota fiscal, ditado ou reconhecimento da bolsa por foto.
- Notas fiscais das vendas avulsas (continuam pela Olist, como hoje).
