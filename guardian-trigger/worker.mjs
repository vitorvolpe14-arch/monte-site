// Despertador do guardião da loja MONTÊ.
//
// O GitHub às vezes atrasa ou ignora execuções agendadas (cron do Actions é "melhor esforço").
// O relógio da Cloudflare é pontual, então este Worker só faz uma coisa: a cada 5 minutos
// pede ao GitHub para rodar a varredura (.github/workflows/guardian.yml). Quem testa a loja
// e abre o aviso continua sendo o workflow; este Worker não olha a loja e não usa IA.
//
// Precisa do segredo GITHUB_TOKEN (token com permissão "Actions: Read and write" só neste repositório).
// Não responde a requisições da internet: só o relógio (cron) o aciona.
const REPO = "vitorvolpe14-arch/monte-site";
const WORKFLOW = "guardian.yml";

async function dispatch(env) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN não configurado");

  const api = env.GITHUB_API ?? "https://api.github.com";
  const res = await fetch(`${api}/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "monte-guardian-trigger",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });

  // O GitHub responde 204 (sem corpo) quando aceita o pedido.
  if (res.status !== 204) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`GitHub respondeu ${res.status}: ${detail}`);
  }
}

export default {
  async scheduled(event, env) {
    await dispatch(env);
  },
};
