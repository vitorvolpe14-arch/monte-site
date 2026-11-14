# Teste de legítimo interesse — lembrete da sacola pelo WhatsApp

**Rascunho para revisão jurídica.** Este documento registra a avaliação de legítimo interesse
(LGPD, art. 7º, IX, e art. 10) para o lembrete da sacola do site da MONTÊ. A estrutura segue o
Guia Orientativo sobre Legítimo Interesse da ANPD (finalidade, necessidade, balanceamento e
salvaguardas) e o Guia Orientativo sobre Cookies e Proteção de Dados Pessoais da ANPD. Deve ser
revisado por um advogado antes de ser considerado final, e revisto sempre que o lembrete mudar.

- **Controladora:** MONTÊ (oficialmontee.com.br)
- **Tratamento avaliado:** guardar o nome, o WhatsApp e as peças de quem começa o checkout, para
  a loja chamar a cliente uma vez pelo WhatsApp se a compra não for concluída
- **Data:** 14/11/2026
- **Substitui:** o modelo anterior, em que o lembrete dependia do consentimento no aviso de cookies
  ("Lembrete de sacola pelo WhatsApp")
- **Onde está no código:** `backend/cart-reminder.js`, rota `POST /api/analytics/cart` e
  `storeFollowupAbandonedCarts` em `backend/server.js`, `script.js` (bloco "Lembrete da sacola"),
  aviso no checkout em `index.html` (`#cartContactNote`), `backend/sql/lembrete-sacola-sem-cookies.sql`

## 1. O que é feito

1. No checkout, embaixo do campo do WhatsApp, a cliente lê: "Se a compra não for concluída, a
   MONTÊ pode te chamar uma vez neste WhatsApp para ajudar. **Não quero** · Saiba mais".
2. Quando ela digita um celular válido, o site manda ao servidor as peças da sacola, o nome e o
   WhatsApp, com um código aleatório da sacola que fica só na memória da página (some quando a
   página fecha). Não é usado cookie nem armazenamento no aparelho para isso.
3. Se a sacola ficar parada por 30 minutos sem pedido, o servidor avisa a loja (no WhatsApp da
   loja, ou por e-mail interno). A loja toca no botão e manda a mensagem pronta para a cliente,
   pelo próprio WhatsApp da loja. A mensagem termina com: "Se preferir não receber esse tipo de
   mensagem, é só me avisar."

**O que é guardado (tabela `cart_snapshots`):** peças, valores, nome, WhatsApp, horários e o
resultado do aviso. Com a permissão de estatísticas (consentimento), a mesma linha também guarda o
código de visitante das estatísticas, como antes.

**O que não é guardado para o lembrete:** e-mail, CPF, endereço, IP, navegador, código de
visitante ou qualquer informação no aparelho (exceto o próprio pedido de oposição,
`monte_sem_lembrete`, quando a cliente toca em "Não quero").

## 2. Finalidade legítima

Ajudar quem começou uma compra e não terminou: muitas vezes a cliente teve dúvida de tamanho,
frete, prazo ou pagamento, ou o pagamento não abriu. Um contato humano, único e logo depois,
resolve a dúvida e recupera a venda. É um interesse concreto, atual e lícito da loja (art. 10, I:
apoio e promoção das atividades do controlador) e também atende à cliente (art. 10, II: prestação
de serviço que a beneficia, respeitadas as suas expectativas).

**Por que deixou de ser consentimento:** no aviso de cookies o lembrete se misturava às
estatísticas, num momento (a entrada no site) em que a cliente ainda nem pensava em comprar.
Depois que o aviso ficou mais discreto (12/11/2026), quase ninguém respondia a ele: em 13/11
houve 101 visitas, 3 permissões e nenhuma sacola com WhatsApp guardada, inclusive de uma cliente
que chegou ao pagamento. O lembrete também não depende de cookies, então não fazia sentido estar
naquele aviso. O aviso foi para o lugar e para a hora em que o WhatsApp é pedido.

## 3. Necessidade (o mínimo de dados)

- **Nome:** só para cumprimentar ("Oi, Ana!") e para a loja saber com quem fala.
- **WhatsApp:** é o canal do contato. Sem um celular válido, nada é guardado para o lembrete.
- **Peças:** para a mensagem dizer o que ficou na sacola e para o link que refaz a sacola.
- **E-mail:** não é usado, porque o contato é pelo WhatsApp (antes era guardado).
- **Código da sacola:** só na memória da página. Recarregar a página cria outro; para o mesmo
  número, o servidor faz no máximo um contato a cada 7 dias.
- **Alternativa menos invasiva:** um aviso por e-mail automático foi descartado pela loja; o
  consentimento no aviso de cookies não funcionou (seção 2). Pedir "Quero ser chamada" numa caixa
  no checkout seria consentimento e pode ser adotado se o advogado preferir (seção 6).

## 4. Balanceamento

**Expectativa da cliente**

Quem digita o WhatsApp no checkout de uma loja que diz "Enviamos o código de rastreio do pedido
pelo WhatsApp" e lê, logo abaixo, que a loja pode chamá-la uma vez se a compra não for concluída,
espera esse contato. Ele é sobre a compra que ela mesma começou, minutos antes, e não sobre
outras ofertas.

**Impacto para a cliente**

Baixo: uma mensagem, de uma pessoa da loja, pelo canal que ela informou, sobre a sacola dela. Não
há decisão automatizada, perfil, publicidade direcionada nem compartilhamento para fins de
marketing de terceiros. Não envolve dado sensível nem dados de crianças (a loja vende para
adultos; o checkout pede CPF).

**Direitos e liberdades**

- Oposição simples, antes e depois (art. 18, § 2º): "Não quero" no checkout (apaga na hora o que
  já tinha sido enviado) e a frase de saída na própria mensagem.
- Oposição lembrada: o navegador guarda só esse pedido (`monte_sem_lembrete`), e ele vale para as
  próximas compras naquele aparelho.
- Transparência (art. 10, § 2º): aviso no checkout, link "Saiba mais" para a Política de
  Privacidade (seções 2, 3, 4, 7 e 8).

**Conclusão do balanceamento:** o interesse da loja prevalece. O contato é único, esperado,
ligado à compra que a cliente começou, com o mínimo de dados, prazo curto e oposição simples.

## 5. Salvaguardas

1. Sem cookies e sem armazenamento no aparelho para o lembrete (só o pedido de oposição).
2. Só com celular válido digitado pela cliente; sem ele, nada é guardado (no site e no servidor).
3. Só nome, WhatsApp e peças; o e-mail não é guardado.
4. Um contato por sacola, no máximo um a cada 7 dias por número, só nas 24 horas seguintes e só
   com peças em estoque; não há contato se a cliente já fez o pedido.
5. "Não quero" no checkout e frase de saída na mensagem.
6. Nome e WhatsApp apagados depois de 30 dias; a sacola guardada só para o lembrete é apagada
   inteira nesse prazo (exclusão automática, `purgeExpiredAnalytics`).
7. Tabela acessível só pelo servidor (`service_role`; RLS ligado, sem acesso público).
8. Testes automatizados das regras (`scripts/cart-reminder.test.mjs` e
   `scripts/cart-reminder-site.test.mjs`).

## 6. Pontos para o advogado confirmar

- Se o legítimo interesse é a base adequada ou se é preferível consentimento por uma caixa
  "Quero ser chamada" no checkout, desmarcada.
- Se o texto do aviso no checkout, da mensagem e da política está adequado e suficiente.
- O prazo de 30 dias para o nome e o WhatsApp.
- Pedido de "não receber mais" feito por resposta no WhatsApp: hoje a loja atende manualmente
  (não chama de novo aquele número). Avaliar se convém uma lista de bloqueio no sistema.
- Transferência internacional (art. 33): o aviso para a loja passa pela API do WhatsApp (Meta) com
  o nome e o WhatsApp da cliente. Confirmar que os termos da Meta (e da Resend, no e-mail interno)
  trazem as cláusulas-padrão da ANPD (Resolução CD/ANPD nº 19/2024).
- Política do WhatsApp Business (Meta): pede que a pessoa tenha dado o número e aceitado ser
  contatada pelo WhatsApp. O aviso junto do campo atende a isso na leitura da loja; confirmar.
- Se convém registrar este teste no relatório de impacto (RIPD) da loja, caso exista.

## 7. Revisão

Revisar este documento se o lembrete passar a guardar outro dado, mudar de canal (por exemplo,
mensagens automáticas em vez da loja), mudar a finalidade ou se a ANPD publicar orientação nova.
