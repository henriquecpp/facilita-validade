-- A Bridge da Pagonet tem um token só, da aplicação (PAGONET_TOKEN), e devolve os dados
-- do CNPJ pedido. Cada loja passa a ler sempre o próprio CNPJ (stores.cnpj_normalized):
-- a origem deixa de guardar token e CNPJ. Antes o CNPJ era digitado no painel da loja, e
-- uma loja podia pedir os dados de outra que o token alcançasse.
ALTER TABLE pagonet_sources
  DROP COLUMN cnpj,
  DROP COLUMN token_ciphertext,
  DROP COLUMN token_hint;
