-- Origem que o próprio servidor consulta: a Bridge da Pagonet, rotas do Facilita Validade
-- (catálogo, códigos de barras e vendas do dia). Uma por loja, ligada a uma conexão de
-- integração: produtos e movimentos importados ficam nessa conexão, como os de qualquer
-- outra origem.
--
-- O token fica cifrado com a chave do servidor (INTEGRATION_SECRET_KEY): o banco, os
-- backups e os logs nunca o têm em claro. Para o painel basta o final dele.
CREATE TABLE pagonet_sources (
  store_id uuid PRIMARY KEY REFERENCES stores(id),
  connection_id uuid NOT NULL,
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  token_ciphertext text NOT NULL,
  token_hint text NOT NULL CHECK (length(token_hint) <= 4),
  -- Grupo/categoria do ERP a importar ('529/889' ou o grupo inteiro, '529'); vazio
  -- importa o catálogo inteiro.
  categories text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  -- Cada rota da Pagonet aceita uma chamada a cada 5 minutos, e as que falham também
  -- contam: a tentativa é registrada antes da chamada, e a próxima espera a janela.
  catalog_requested_at timestamptz,
  catalog_attempted_at timestamptz,
  catalog_synced_at timestamptz,
  catalog_hash text,
  catalog_products integer,
  sales_attempted_at timestamptz,
  sales_synced_at timestamptz,
  -- Data e hora local ('AAAA-MM-DD HH:MM') da venda mais recente lida, para o painel.
  sales_through text,
  -- Leituras finais de cada dia e vendas que sumiram da origem, à espera de confirmação.
  sales_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store_id, connection_id),
  FOREIGN KEY (store_id, connection_id) REFERENCES integration_connections (store_id, id)
);

ALTER TABLE pagonet_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagonet_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pagonet_sources TO app_runtime
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON pagonet_sources TO app_runtime;
