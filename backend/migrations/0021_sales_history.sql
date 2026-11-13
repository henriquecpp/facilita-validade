-- Média de vendas dos últimos 6 meses (pedido de 20/11/2026). A média deixa de vir das baixas
-- dos produtos controlados, que só existem desde a contagem de cada um, e passa a vir das
-- vendas do dia de todo o catálogo, como a Pagonet as devolve. O histórico de 6 meses é lido
-- aos poucos, um dia por vez, nas janelas livres da rota de vendas.

-- Unidades vendidas de cada produto em cada dia já encerrado, de todo o catálogo. A leitura de
-- um dia substitui as linhas dele: um item cancelado depois some da conta.
CREATE TABLE product_daily_sales (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  day date NOT NULL,
  product_id uuid NOT NULL,
  -- Itens vendidos por peso trazem fração.
  units numeric(14, 3) NOT NULL CHECK (units > 0),
  PRIMARY KEY (store_id, day, product_id),
  FOREIGN KEY (store_id, product_id) REFERENCES products(store_id, id) ON DELETE CASCADE
);

-- Dias encerrados já lidos inteiros. Dia lido sem nenhum item (loja fechada, ou a origem sem
-- dados daquele dia) fica registrado para não ser lido de novo, mas não entra na média.
CREATE TABLE sales_days (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  day date NOT NULL,
  items integer NOT NULL CHECK (items >= 0),
  units numeric(16, 3) NOT NULL CHECK (units >= 0),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (store_id, day)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['product_daily_sales', 'sales_days'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I TO app_runtime
      USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
      WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_runtime', t);
  END LOOP;
END $$;

-- Leitura do histórico: a última tentativa e a última falha. A falha do histórico não aparece
-- como erro da leitura de vendas do dia; ela só espera algumas horas para tentar de novo.
ALTER TABLE pagonet_sources
  ADD COLUMN history_attempted_at timestamptz,
  ADD COLUMN history_error text,
  ADD COLUMN history_error_at timestamptz;

-- `history_days` passa a ser o número de dias com venda lidos na janela de 6 meses. As médias
-- antigas (28 dias, das baixas) saem; a primeira leitura de um dia encerrado refaz todas.
DELETE FROM product_sales_rates;
