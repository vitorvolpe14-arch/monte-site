# Teste de legítimo interesse — contagem anônima de visitas

**Rascunho para revisão jurídica.** Este documento registra a avaliação de legítimo interesse
(LGPD, art. 7º, IX, e art. 10) para a contagem anônima de visitas do site da MONTÊ. A estrutura
segue o Guia Orientativo sobre Legítimo Interesse da ANPD (finalidade, necessidade, balanceamento
e salvaguardas). Deve ser revisado por um advogado antes de ser considerado final, e revisto
sempre que a contagem mudar.

- **Controladora:** MONTÊ (oficialmontee.com.br)
- **Tratamento avaliado:** contagem anônima de visitas do site
- **Data:** 12/11/2026
- **Onde está no código:** `backend/anonymous-visits.js`, `script.js` (bloco "Contagem anônima de
  visitas"), `backend/sql/visitas-anonimas.sql`, rota `POST /api/analytics/hit` em `backend/server.js`

## 1. O que é feito

Quando a loja abre, o site manda ao servidor um aviso com:

- o tipo do aviso: entrada no site, outra página, uma peça posta na sacola ou o começo do
  pagamento (os dois últimos no máximo uma vez por página aberta);
- na entrada no site, o domínio de onde a visita veio (por exemplo, `l.instagram.com`) ou o
  `utm_source` do link, se houver.

O servidor transforma isso em categorias fixas e soma 1 no total do dia:

- **origem:** Instagram, Facebook, Google, WhatsApp, SMS, TikTok, e-mail, YouTube, Pinterest, X,
  outros buscadores, "outros sites", "outras campanhas" ou "direto". Um site qualquer vira só
  "outros sites", sem guardar o domínio. Um `utm_source` desconhecido vira só "outras campanhas",
  sem guardar o texto;
- **aparelho:** celular ou computador, deduzido do navegador na hora.

**O que é guardado (tabela `site_hits_daily`):** dia, tipo do aviso, origem, aparelho e total.
Exemplo: "12/11 · entrada · Instagram · celular · 142".

**O que não é guardado:** IP, navegador (user agent), código de identificação, cookie ou
qualquer informação no aparelho da pessoa. A requisição vai sem cookies (`credentials: "omit"`).
Os testes automatizados (`scripts/anonymous-visits.test.mjs`) conferem que nada do que é
gravado identifica a visitante.

**O que é usado só na hora, sem gravar:**

- o IP, para o limite de requisições contra abuso (já usado em todo o site);
- o navegador, para separar celular de computador, descartar robôs e ler o "Não rastrear" e o
  Global Privacy Control.

## 2. Finalidade legítima

Saber quantas pessoas visitam a loja, de onde vêm e quantas chegam à sacola e ao pagamento, para:

- avaliar o resultado das divulgações (Instagram, SMS, WhatsApp, anúncios);
- calcular a conversão corretamente. Antes, a loja só via as visitas de quem aceitava os cookies
  de estatística, enquanto os pedidos contavam todo mundo, e a conversão saía inflada;
- planejar o dia e a hora das postagens e campanhas.

É um interesse concreto, atual e lícito da loja, ligado à atividade comercial normal.

## 3. Necessidade (o mínimo de dados)

- **Por que totais por dia:** são a forma mais simples de responder "quantas visitas e de onde",
  sem acompanhar pessoas.
- **Visitantes únicos:** de propósito, não há contagem exata. Ela exigiria um identificador. O
  painel mostra "visitas", e a mesma pessoa pode contar mais de uma vez.
- **Sem histórico por pessoa:** não há caminho de navegação por pessoa, lista de páginas por
  pessoa nem ligação com pedido, nome, e-mail ou telefone.
- **O que continua com consentimento:** as estatísticas detalhadas (código no navegador, Google
  Analytics, Cloudflare Web Analytics). O lembrete da sacola passou para o legítimo interesse em
  14/11/2026, com teste próprio (`docs/teste-legitimo-interesse-lembrete-sacola.md`).
- **Alternativa menos invasiva:** não encontramos uma que atenda à finalidade. Com o modelo só de
  consentimento, faltava a maior parte das visitas, e os números ficavam distorcidos.

## 4. Balanceamento

**Expectativa da visitante**

Numa loja on-line, é esperado que a loja saiba quantas visitas recebe e de onde elas vêm. A
contagem é informada no aviso de cookies ("As visitas são contadas de forma anônima, sem
cookies") e na Política de Privacidade (seções 2, 3, 4, 7 e 8).

**Impacto para a visitante**

Mínimo. Os totais por dia não permitem identificar, acompanhar ou criar perfil de ninguém. Não há
decisão automatizada nem uso para publicidade direcionada. O risco de reidentificação é
desprezível: não existe chave que ligue um total a uma pessoa.

**Direitos e liberdades**

- A visitante pode se opor a qualquer momento: "Não contar minhas visitas" nas preferências de
  cookies, "Não rastrear" ou Global Privacy Control do navegador.
- A opção não é uma caixa pré-marcada de consentimento: é um mecanismo de oposição. Recusar os
  cookies continua tão fácil quanto aceitar.
- Pessoas vulneráveis e crianças não ficam mais expostas, porque nada identifica ninguém.

**Conclusão do balanceamento:** o interesse da loja prevalece. O impacto é mínimo, o tratamento
é transparente e há oposição simples.

## 5. Salvaguardas

1. Sem cookies, sem armazenamento no aparelho (exceto o próprio pedido de oposição) e sem
   identificador.
2. Origem em categorias fixas; nada de domínio ou texto livre gravado.
3. IP e navegador não são gravados.
4. Respeito ao "Não rastrear", ao Global Privacy Control e à opção "Não contar minhas visitas".
5. Robôs e o monitor da loja não contam.
6. Tabela acessível só pelo servidor (`service_role`; RLS ligado, sem acesso público).
7. Guarda por 25 meses, com exclusão automática (`purgeExpiredAnalytics`).
8. Testes automatizados das regras de privacidade.
9. Transparência: aviso de cookies e Política de Privacidade.

## 6. Pontos para o advogado confirmar

- Se os totais por dia podem ser tratados como dados anonimizados (art. 12). Se sim, a LGPD nem
  se aplica a eles; o legítimo interesse cobre o tratamento momentâneo do IP e do navegador.
- Se o texto do aviso de cookies e da política está adequado e suficiente.
- O prazo de 25 meses.
- Se convém registrar este teste no relatório de impacto (RIPD) da loja, caso exista.

## 7. Revisão

Revisar este documento se a contagem passar a guardar outro dado, se mudar a finalidade ou se a
ANPD publicar orientação nova sobre o tema.
