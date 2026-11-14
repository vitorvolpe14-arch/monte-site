# Teste de legítimo interesse — lembrete da sacola por e-mail

**Rascunho para revisão jurídica.** Este documento registra a avaliação de legítimo interesse
(LGPD, art. 7º, IX, e art. 10) para o lembrete da sacola do site da MONTÊ. A estrutura segue o
Guia Orientativo sobre Legítimo Interesse da ANPD (finalidade, necessidade, balanceamento e
salvaguardas) e o Guia Orientativo sobre Cookies e Proteção de Dados Pessoais da ANPD. Deve ser
revisado por um advogado antes de ser considerado final, e revisto sempre que o lembrete mudar.

- **Controladora:** MONTÊ (oficialmontee.com.br)
- **Tratamento avaliado:** guardar o nome, o e-mail e as peças de quem começa o checkout, para
  enviar um e-mail, uma vez, se a compra não for concluída
- **Data:** 14/11/2026
- **Histórico:** até 13/11/2026 o lembrete dependia do consentimento no aviso de cookies, e a loja
  era avisada para chamar a cliente pelo WhatsApp. O site não tem integração com o WhatsApp (o
  aviso chegava à loja por e-mail), e a loja decidiu que o lembrete vai por e-mail para a cliente.
- **Onde está no código:** `backend/cart-reminder.js`; em `backend/server.js`, a rota
  `POST /api/analytics/cart`, `remindAbandonedCarts` e `/api/lembrete-sacola/sair`; `script.js`
  (bloco "Lembrete da sacola por e-mail"); aviso no checkout em `index.html` (`#cartContactNote`);
  `backend/sql/lembrete-sacola-sem-cookies.sql`

## 1. O que é feito

1. No checkout, nos dados da cliente, ela lê: "Se a compra não for concluída, podemos te mandar
   um e-mail uma vez com a sua sacola. **Não quero** · Saiba mais".
2. Quando ela digita um e-mail válido, o site manda ao servidor as peças da sacola, o nome e o
   e-mail, com um código aleatório da sacola que fica só na memória da página (some quando a
   página fecha). Não é usado cookie nem armazenamento no aparelho para isso.
3. Se a sacola ficar parada por 30 minutos sem pedido, a cliente recebe um e-mail ("Sua sacola na
   MONTÊ ficou guardada") com as peças que ainda têm estoque, o botão "Voltar para a sacola", o
   WhatsApp da loja para dúvidas e, no rodapé, o motivo do e-mail ("Você recebeu este e-mail porque
   começou uma compra no site da MONTÊ. É o único lembrete desta sacola.") e o link "Não quero
   receber lembretes da sacola". O e-mail leva também o cabeçalho `List-Unsubscribe`, para o
   aplicativo de e-mail mostrar o botão de cancelar.

**O que é guardado (tabela `cart_snapshots`):** peças, valores, nome, e-mail, horários e o
resultado do envio. Com a permissão de estatísticas (consentimento), a mesma linha também guarda o
código de visitante das estatísticas, como antes.

**Lista de quem não quer receber (`kv_store`, chave `cart_reminder_optout:`):** só o sha-256 do
e-mail, nunca o e-mail.

**O que não é guardado para o lembrete:** WhatsApp, CPF, endereço, IP, navegador, código de
visitante ou qualquer informação no aparelho (exceto o próprio pedido de oposição,
`monte_sem_lembrete`, quando a cliente toca em "Não quero").

## 2. Finalidade legítima

Ajudar quem começou uma compra e não terminou: muitas vezes a cliente se distraiu, teve dúvida de
tamanho, frete, prazo ou pagamento, ou o pagamento não abriu. Um e-mail único, logo depois, com a
sacola pronta, ajuda a cliente a voltar e recupera a venda. É um interesse concreto, atual e lícito
da loja (art. 10, I: apoio e promoção das atividades do controlador) e também atende à cliente
(art. 10, II: prestação de serviço que a beneficia, respeitadas as suas expectativas).

**Por que deixou de ser consentimento:** no aviso de cookies o lembrete se misturava às
estatísticas, num momento (a entrada no site) em que a cliente ainda nem pensava em comprar.
Depois que o aviso ficou mais discreto (12/11/2026), quase ninguém respondia a ele: em 13/11
houve 101 visitas, 3 permissões e nenhuma sacola com contato guardada, inclusive de uma cliente
que chegou ao pagamento. O lembrete também não depende de cookies. O aviso foi para o lugar e
para a hora em que o e-mail é pedido.

## 3. Necessidade (o mínimo de dados)

- **Nome:** só para cumprimentar ("Oi, Ana!").
- **E-mail:** é o canal do lembrete. Sem um e-mail válido, nada é guardado para o lembrete.
- **Peças:** para o e-mail mostrar o que ficou na sacola e para o botão que refaz a sacola.
- **WhatsApp:** não é usado (antes era).
- **Código da sacola:** só na memória da página. Recarregar a página cria outro; para o mesmo
  e-mail, o servidor envia no máximo um lembrete a cada 7 dias.
- **Alternativa menos invasiva:** o consentimento no aviso de cookies não funcionou (seção 2).
  Pedir "Quero receber o lembrete" numa caixa no checkout seria consentimento e pode ser adotado
  se o advogado preferir (seção 6).

## 4. Balanceamento

**Expectativa da cliente**

Quem digita o e-mail no checkout e lê, logo abaixo, que pode receber um e-mail uma vez com a
sacola, espera esse e-mail. Ele é sobre a compra que ela mesma começou, minutos antes, e não
sobre outras ofertas.

**Impacto para a cliente**

Baixo: um e-mail, sobre a sacola dela, no endereço que ela informou. Não há decisão automatizada,
perfil, publicidade de outros produtos nem compartilhamento para marketing de terceiros. Não
envolve dado sensível nem dados de crianças (a loja vende para adultos; o checkout pede CPF).

**Direitos e liberdades**

- Oposição simples, antes e depois (art. 18, § 2º): "Não quero" no checkout (apaga na hora o que
  já tinha sido enviado) e o link "Não quero receber lembretes da sacola" em todo e-mail, que
  funciona com um toque, sem login.
- Oposição lembrada: no navegador (`monte_sem_lembrete`) e no servidor (lista com o sha-256 do
  e-mail), para as próximas sacolas.
- Transparência (art. 9º e art. 10, § 2º): aviso no checkout, motivo do e-mail no rodapé, link
  "Saiba mais" para a Política de Privacidade (seções 2, 3, 4, 5, 7 e 8).

**Conclusão do balanceamento:** o interesse da loja prevalece. O e-mail é único, esperado, ligado
à compra que a cliente começou, com o mínimo de dados, prazo curto e oposição simples.

## 5. Salvaguardas

1. Sem cookies e sem armazenamento no aparelho para o lembrete (só o pedido de oposição).
2. Só com e-mail válido digitado pela cliente; sem ele, nada é guardado (no site e no servidor).
3. Só nome, e-mail e peças; o WhatsApp não é guardado.
4. Um e-mail por sacola, no máximo um a cada 7 dias por endereço, só nas 24 horas seguintes e só
   com peças em estoque; nenhum e-mail se a cliente já fez o pedido.
5. "Não quero" no checkout; link para não receber e `List-Unsubscribe` em todo e-mail; a lista de
   quem não quer guarda só o sha-256 do e-mail.
6. Nome e e-mail apagados depois de 30 dias; a sacola guardada só para o lembrete é apagada
   inteira nesse prazo (exclusão automática, `purgeExpiredAnalytics`).
7. Tabelas acessíveis só pelo servidor (`service_role`; RLS ligado, sem acesso público).
8. Testes automatizados das regras (`scripts/cart-reminder.test.mjs` e
   `scripts/cart-reminder-site.test.mjs`).

## 6. Pontos para o advogado confirmar

- Se o legítimo interesse é a base adequada ou se é preferível consentimento por uma caixa
  "Quero receber o lembrete" no checkout, desmarcada.
- Se o texto do aviso no checkout, do e-mail e da política está adequado e suficiente.
- O prazo de 30 dias para o nome e o e-mail, e o de guarda da lista de quem não quer receber.
- Transferência internacional (art. 33): o e-mail é enviado pela Resend (fora do Brasil).
  Confirmar que os termos da Resend trazem as cláusulas-padrão da ANPD (Resolução CD/ANPD
  nº 19/2024).
- Se convém registrar este teste no relatório de impacto (RIPD) da loja, caso exista.

## 7. Revisão

Revisar este documento se o lembrete passar a guardar outro dado, mudar de canal, enviar mais de
um e-mail, mudar a finalidade ou se a ANPD publicar orientação nova.
