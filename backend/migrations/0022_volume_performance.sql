-- Desempenho com o movimento do piloto (10 mil itens vendidos por dia, 300 mil por mês; pedido de
-- 20/11/2026). Medido com `pnpm test:volume`: loja de 2.500 produtos controlados e 6 meses de
-- vendas (docs/evidencias/volume-antes.json e volume-depois.json).

-- 1. Reconstrução a partir de um retrato. Cada venda nova refazia o produto desde a contagem:
-- com meses de vendas, segundos por produto, de hora em hora, segurando a trava dele. O retrato
-- guarda o estado da reconstrução de uns dias atrás; a próxima só refaz os fatos depois dele.
-- `seq` é a ordem de gravação dos fatos de um produto (gravados sob a trava dele): fato gravado
-- depois do retrato com instante anterior a ele chegou atrasado, e a reconstrução é completa.
ALTER TABLE stock_movements ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX stock_movements_by_seq ON stock_movements (store_id, product_id, seq);

CREATE TABLE inventory_checkpoints (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  epoch_id uuid NOT NULL,
  -- Maior `seq` dos fatos do produto quando o retrato foi tirado.
  max_seq bigint NOT NULL,
  -- `ReplayCheckpoint` do motor (domain/types.ts).
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (store_id, product_id),
  FOREIGN KEY (store_id, product_id, epoch_id)
    REFERENCES inventory_epochs (store_id, product_id, id) ON DELETE CASCADE
);
ALTER TABLE inventory_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_checkpoints TO app_runtime
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_checkpoints TO app_runtime;

-- 2. Alocações por movimento e por lote. A chave começa pela época, e as consultas chegam pelo
-- movimento (alertas de saldo esgotado, histórico) ou pelo lote (histórico de um lote): sem
-- estes índices, cada uma lia todas as alocações da loja.
CREATE INDEX movement_allocations_by_movement ON movement_allocations (store_id, movement_id);
CREATE INDEX movement_allocations_by_record ON movement_allocations (store_id, record_id);

-- O lote a que um fato do aplicativo se refere (entrada, baixa manual, edição, exclusão), em
-- coluna: o histórico de um lote acha esses fatos pelo índice. Sob a segurança por loja, um
-- índice sobre o JSON não é usado (o operador do JSON não é "leakproof").
ALTER TABLE stock_movements
  ADD COLUMN record_ref uuid GENERATED ALWAYS AS ((payload->>'stockRecordId')::uuid) STORED;
CREATE INDEX stock_movements_by_record ON stock_movements (store_id, record_ref)
  WHERE record_ref IS NOT NULL;

-- 3. Vendas já importadas de um dia ('venda:AAAA-MM-DD:%'): com o banco em en_US, o LIKE não usa
-- o índice único, e cada leitura de hora em hora varria todos os eventos da loja.
CREATE INDEX integration_events_by_prefix
  ON integration_events (store_id, connection_id, external_event_id text_pattern_ops);

-- 4. O que a varredura de cada minuto procura: só as poucas linhas pendentes, nunca a tabela.
CREATE INDEX integration_events_pending ON integration_events (store_id, batch_id)
  WHERE status IN ('PENDING_PRODUCT', 'PENDING_REFERENCE', 'PENDING_FUTURE');
CREATE INDEX import_batches_open ON import_batches (store_id, created_at)
  WHERE status IN ('RECEIVED', 'PROCESSING');
CREATE INDEX product_inventory_stale ON product_inventory (store_id)
  WHERE input_revision > applied_input_revision;

-- 5. Lotes com saldo: os números da loja (Início, Validades, alertas) partem só deles, e os
-- zerados se acumulam com os meses.
CREATE INDEX stock_projections_with_balance ON stock_projections (store_id, record_id)
  WHERE quantity > 0;

-- 6. Alertas ativos, por produto (avaliação) e por data (sino); e pendências abertas (lista).
-- Os alertas de todos os lotes que já existiram ficam na tabela, inativos.
CREATE INDEX notifications_active_by_product ON notifications (store_id, product_id) WHERE active;
CREATE INDEX notifications_active_recent ON notifications (store_id, created_at DESC, id DESC)
  WHERE active;
CREATE INDEX reconciliation_issues_by_status
  ON reconciliation_issues (store_id, status, created_at DESC, id DESC);

-- O `revision` de cada projeção e alocação passa a ser o da última reconstrução que mudou a
-- linha: só o que muda é regravado.
