# Instruções para o Claude

## Fluxo de trabalho (pedido do dono da loja)

- Pedido de implementação: implementar, testar, abrir o PR e fazer o merge na `main` sem pedir autorização.
  O merge na `main` publica o site (Cloudflare Workers Builds). Depois do merge, conferir no site no ar que a mudança apareceu.
- As verificações "Workers Builds: monte-site" e "Workers Builds: monte-guardian-trigger" falham na hora em
  branches que não são a `main` (não há build de preview); isso não bloqueia o merge.
- Mudanças no banco (Supabase) ficam em `backend/sql/` e são aplicadas no projeto antes do merge.
