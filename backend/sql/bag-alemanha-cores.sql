-- Bag Alemanha: as cores Marrom e Verde saem do site (correção de dados, aplicada em 25/11/2026).
--
-- Na Olist, a Bag Alemanha de hoje só tem a preta (produto pai 371863373, 3 disponíveis). A Marrom
-- (SKU Germmarr) e a Verde (SKU Germaverd) estão no produto antigo da Olist (pai 363863332), que
-- ainda marca 1 disponível de cada. Toda vez que o painel zerava essas cores, a sincronização com a
-- Olist voltava o estoque para 1, e o painel não deixava remover uma cor com estoque.
-- Inativas, as cores somem do site e a sincronização não mexe mais nelas. A Marrom continua no
-- banco porque está num pedido antigo (18/10/2026).

select public.adjust_product_variant_stock(id, -stock, 'adjustment', 'Cor tirada do site: na Olist só há a preta', 'correção manual')
from public.product_variants
where id in ('746138f7-05b7-4468-b27b-ca0a7d159089', '1d6e158a-b687-4fd3-9551-2466217e3a0b')
  and stock > 0;

update public.product_variants
set active = false, updated_at = now()
where id in ('746138f7-05b7-4468-b27b-ca0a7d159089', '1d6e158a-b687-4fd3-9551-2466217e3a0b');
