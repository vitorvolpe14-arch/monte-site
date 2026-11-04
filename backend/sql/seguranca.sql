-- Auditoria de segurança (novembro de 2026), aplicada no Supabase como a migração
-- "monte_revoke_anon_catalog_read".
--
-- O site da MONTÊ nunca lê o banco direto do navegador: tudo passa pelo servidor, que usa a
-- service_role. A leitura pública (anon) de products e product_variants sobrou de uma versão
-- antiga e deixava qualquer pessoa com a chave pública do Supabase ler colunas internas
-- (images_original, IDs da Olist, estoque exato) direto na API do banco.
-- Para voltar atrás: grant select on public.products, public.product_variants to anon;
revoke select on public.products from anon;
revoke select on public.product_variants from anon;
