-- Busca de produtos no catálogo inteiro (pedido de 17/10/2026).
--
-- A pesquisa do coletor e a lista de Produtos do painel levavam de 0,6 a 0,8 s nos 24,7 mil
-- produtos da loja-piloto: o código de barras de cada produto era procurado sem índice, e a
-- descrição era comparada sem normalizar, então "maçã" não achava "MACA".
--
-- search_key é a forma de comparação: sem acento e em minúsculas. A descrição já fica guardada
-- assim em search_text, calculada pelo banco a cada gravação. Um índice de trigramas não
-- serviria: com a segurança por loja (RLS), o LIKE não é "leakproof" e não pode usar índice.
CREATE FUNCTION search_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN pg_catalog.lower(pg_catalog.translate(value,
  'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
  'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'));
GRANT EXECUTE ON FUNCTION search_key(text) TO app_runtime;

ALTER TABLE products ADD COLUMN search_text text GENERATED ALWAYS AS (search_key(description)) STORED;

-- Os códigos de um produto: o primeiro de cada linha da lista, a tela do produto e a busca.
CREATE INDEX product_barcodes_by_product ON product_barcodes (store_id, product_id);
