-- Alertas por e-mail (ADR 0005): resumo diário por loja enviado aos destinatários
-- configurados pelo proprietário. Cada envio fica registrado para não repetir no mesmo dia.
ALTER TABLE store_settings
  ADD COLUMN alert_emails text[] NOT NULL DEFAULT '{}' CHECK (cardinality(alert_emails) <= 10),
  ADD COLUMN digest_hour int NOT NULL DEFAULT 7 CHECK (digest_hour BETWEEN 0 AND 23);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  channel text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DAILY_DIGEST')),
  digest_date date NOT NULL,
  recipients text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('SENDING', 'SENT', 'SKIPPED', 'FAILED')),
  attempts int NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  alert_count int NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error text,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store_id, id),
  UNIQUE (store_id, channel, kind, digest_date)
);
CREATE INDEX notification_deliveries_recent ON notification_deliveries (store_id, created_at DESC);

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_deliveries TO app_runtime
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO app_runtime;
