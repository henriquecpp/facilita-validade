-- Escolhas do proprietário, independentes da classificação e da projeção de estoque.
CREATE TABLE push_preferences (
  store_id uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  version int NOT NULL DEFAULT 1,
  daily_digest_enabled boolean NOT NULL DEFAULT true,
  depleted_enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE level_push_preferences (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  level_id uuid NOT NULL,
  immediate boolean NOT NULL DEFAULT true,
  interval_hours int CHECK (interval_hours BETWEEN 1 AND 24),
  daily_time text CHECK (daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  PRIMARY KEY (store_id, level_id),
  FOREIGN KEY (store_id, level_id) REFERENCES expiry_levels(store_id, id) ON DELETE CASCADE
);
-- Reserva atômica dos horários: vários workers não repetem o mesmo aviso no mesmo período.
CREATE TABLE push_schedule_claims (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  level_id uuid NOT NULL,
  schedule_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (store_id, level_id, schedule_key),
  FOREIGN KEY (store_id, level_id) REFERENCES expiry_levels(store_id, id) ON DELETE CASCADE
);
CREATE INDEX push_schedule_claims_recent ON push_schedule_claims(store_id, created_at);
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['push_preferences', 'level_push_preferences', 'push_schedule_claims'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO app_runtime USING (store_id = nullif(current_setting(''app.store_id'', true), '''')::uuid) WITH CHECK (store_id = nullif(current_setting(''app.store_id'', true), '''')::uuid)', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_runtime', table_name);
  END LOOP;
END $$;
-- A última parcela alocada ao lote é persistida com o alerta, sob a trava da projeção.
ALTER TABLE notifications ADD COLUMN depleted_quantity int,
  ADD COLUMN depleted_movement_id uuid;
