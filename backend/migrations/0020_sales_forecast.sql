-- Previsão de venda (pedido do piloto, 20/11/2026): a média diária de vendas de cada produto
-- controlado, recalculada na avaliação dos alertas. A sobra prevista de cada lote é calculada
-- na leitura, com o saldo atual, e não fica gravada.
CREATE TABLE product_sales_rates (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  -- Unidades por dia na janela; nula quando o histórico do produto ainda é curto demais.
  daily_sales numeric(14, 4) CHECK (daily_sales >= 0),
  history_days numeric(6, 2) NOT NULL CHECK (history_days >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (store_id, product_id),
  -- Dado derivado: some com o produto.
  FOREIGN KEY (store_id, product_id) REFERENCES products(store_id, id) ON DELETE CASCADE
);
ALTER TABLE product_sales_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_sales_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_sales_rates TO app_runtime
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON product_sales_rates TO app_runtime;

-- Escolha do proprietário: lote que deve ser vendido antes de vencer não gera alerta.
-- Desligada por padrão: nada muda nos avisos de quem não escolher.
ALTER TABLE store_settings ADD COLUMN sales_forecast_alerts boolean NOT NULL DEFAULT false;
