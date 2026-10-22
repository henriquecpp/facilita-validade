-- Catálogo inteiro, com todos os campos do produto (reunião de 16/10/2026; docs/requisitos-
-- reuniao-2026-10-16.md, AV28 a AV30).
--
-- Grupo e categoria do ERP servem de filtro na lista de produtos até a API de classificação
-- mercadológica trazer os nomes. O preço de venda dá os valores em R$ do Início. O resto do
-- que a origem devolve fica em erp_attributes, como veio. erp_hash é o resumo do produto na
-- última importação: a leitura de hora em hora grava só os produtos que mudaram.
ALTER TABLE products
  ADD COLUMN erp_group text,
  ADD COLUMN erp_category text,
  ADD COLUMN sale_price numeric(12, 2) CHECK (sale_price >= 0),
  ADD COLUMN erp_attributes jsonb,
  ADD COLUMN erp_hash text;
CREATE INDEX products_by_category ON products (store_id, erp_group, erp_category);

-- Toda loja importa o catálogo inteiro: a escolha de categorias sai. A próxima leitura traz
-- o catálogo com os campos novos.
ALTER TABLE pagonet_sources
  DROP COLUMN categories,
  -- Leitura de um dia já encerrado ainda pendente (fechamento do dia ou dias sem leitura): a
  -- próxima não espera a hora, só a janela de 5 minutos da rota.
  ADD COLUMN sales_catchup boolean NOT NULL DEFAULT false;
UPDATE pagonet_sources SET catalog_hash = NULL, catalog_requested_at = clock_timestamp();
