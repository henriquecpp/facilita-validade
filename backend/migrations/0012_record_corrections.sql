-- Correções de registro (reunião de 16/10/2026; docs/requisitos-reuniao-2026-10-16.md,
-- AV01–AV08): baixa manual, edição pelo painel e exclusão de lote, quem lançou cada lote
-- e o status de cada um.
--
-- As correções entram como fatos em stock_movements (MANUAL_WRITE_OFF, RECORD_EDIT,
-- RECORD_DELETE), como as entradas do aplicativo. stock_records guarda o lançamento
-- original; a validade e a quantidade lançada atuais, o vendido, as baixas manuais e o
-- status saem da reconstrução e ficam na projeção de cada registro.
ALTER TABLE stock_records
  ADD COLUMN created_by uuid,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid,
  ADD FOREIGN KEY (store_id, created_by) REFERENCES store_users (store_id, id),
  ADD FOREIGN KEY (store_id, deleted_by) REFERENCES store_users (store_id, id),
  ADD CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

ALTER TABLE stock_projections
  ADD COLUMN expires_on date,
  ADD COLUMN launched int CHECK (launched BETWEEN 0 AND 1000000000),
  ADD COLUMN sold int NOT NULL DEFAULT 0 CHECK (sold BETWEEN 0 AND 1000000000),
  ADD COLUMN written_off int NOT NULL DEFAULT 0 CHECK (written_off BETWEEN 0 AND 1000000000),
  -- PENDING: tem saldo. AUTOMATIC: as vendas zeraram. MANUAL: uma baixa manual zerou.
  -- BOTH: zerou com os dois tipos de baixa. EMPTY: sem saldo e sem baixa (contagem zerada).
  -- DELETED: excluído.
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'AUTOMATIC', 'MANUAL', 'BOTH', 'EMPTY', 'DELETED'));

-- Quem lançou: nas entradas, o autor do comando; nas contagens, quem confirmou (ou, sem o
-- registro da confirmação, quem abriu a contagem).
UPDATE stock_records r SET created_by = a.actor_id
  FROM audit_events a
 WHERE r.origin = 'APP_RECEIPT' AND a.store_id = r.store_id
   AND a.action = 'inventory.receipt' AND a.entity_id = r.id AND a.actor_id IS NOT NULL;
UPDATE stock_records r SET created_by = c.actor_id
  FROM inventory_epochs e
  JOIN count_sessions c ON c.store_id = e.store_id AND c.id = e.session_id
 WHERE r.origin = 'COUNT' AND e.store_id = r.store_id AND e.id = r.epoch_id;
UPDATE stock_records r SET created_by = a.actor_id
  FROM inventory_epochs e
  JOIN audit_events a
    ON a.store_id = e.store_id AND a.entity_id = e.session_id AND a.action = 'count.confirm'
 WHERE r.origin = 'COUNT' AND e.store_id = r.store_id AND e.id = r.epoch_id
   AND a.actor_id IS NOT NULL;

-- Projeções existentes: validade e quantidade do lançamento (ainda não havia edição), o que já
-- saiu de cada registro e o status. Antes desta migration só havia vendas e descartes do ERP.
UPDATE stock_projections p
   SET expires_on = r.expires_on, launched = r.initial_quantity, sold = COALESCE(a.quantity, 0),
       status = CASE WHEN p.quantity > 0 THEN 'PENDING'
                     WHEN a.quantity > 0 THEN 'AUTOMATIC'
                     ELSE 'EMPTY' END
  FROM stock_records r
  LEFT JOIN (SELECT store_id, record_id, sum(quantity)::int AS quantity
               FROM movement_allocations GROUP BY store_id, record_id) a
    ON a.store_id = r.store_id AND a.record_id = r.id
 WHERE r.store_id = p.store_id AND r.id = p.record_id;
ALTER TABLE stock_projections
  ALTER COLUMN expires_on SET NOT NULL,
  ALTER COLUMN launched SET NOT NULL;

-- A próxima reconstrução regrava as projeções da época atual com a regra nova; o worker refaz
-- os produtos controlados em poucos minutos.
UPDATE product_inventory SET input_revision = input_revision + 1
 WHERE tracking_status = 'TRACKED';
