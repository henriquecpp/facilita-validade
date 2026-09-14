-- Contagem simplificada (ADR 0004): a sessão nasce em andamento, qualquer papel confirma,
-- o corte é o instante da última linha salva e movimento durante a contagem vira aviso
-- quantificado, sem bloquear nem exigir recontagem.
ALTER TABLE count_sessions ADD COLUMN lines_saved_at timestamptz;
ALTER TABLE count_sessions ALTER COLUMN status SET DEFAULT 'COUNTING';
UPDATE count_sessions
   SET status = 'CANCELLED', cancel_reason = 'Sessão preparada no fluxo anterior de contagem.',
       version = version + 1
 WHERE status = 'DRAFT';

ALTER TABLE product_inventory
  ADD COLUMN count_window_quantity bigint NOT NULL DEFAULT 0 CHECK (count_window_quantity >= 0);
-- Produtos marcados pela regra anterior são reprocessados pelo worker para calcular o aviso.
UPDATE product_inventory SET input_revision = input_revision + 1 WHERE needs_recount;
ALTER TABLE product_inventory DROP COLUMN needs_recount;

UPDATE reconciliation_issues SET status = 'RESOLVED'
 WHERE code = 'COUNT_WINDOW_VIOLATION' AND status = 'OPEN';
