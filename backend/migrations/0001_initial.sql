DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='auth_lookup') THEN CREATE ROLE auth_lookup NOLOGIN NOBYPASSRLS; END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_runtime, auth_lookup;
GRANT USAGE ON SCHEMA auth TO app_auth;
CREATE TABLE stores (
 id uuid PRIMARY KEY, cnpj_normalized text NOT NULL UNIQUE CHECK(cnpj_normalized ~ '^[A-Z0-9]{12}[0-9]{2}$'),
 name text NOT NULL, timezone text NOT NULL DEFAULT 'America/Sao_Paulo', active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE store_settings (
 store_id uuid PRIMARY KEY REFERENCES stores(id), medium_days int NOT NULL DEFAULT 15,
 high_days int NOT NULL DEFAULT 5, version int NOT NULL DEFAULT 1,
 CHECK(high_days>=0 AND high_days<medium_days AND medium_days<=365)
);
CREATE TABLE store_users (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), username text NOT NULL,
 username_normalized text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('OWNER','MANAGER','OPERATOR')), active boolean NOT NULL DEFAULT true,
 must_change_password boolean NOT NULL DEFAULT true, credential_version int NOT NULL DEFAULT 1,
 version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(store_id,id), UNIQUE(store_id,username_normalized)
);
CREATE TABLE auth_sessions (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), user_id uuid NOT NULL,
 client text NOT NULL CHECK(client IN ('web','mobile')), restricted boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(store_id,id), FOREIGN KEY(store_id,user_id) REFERENCES store_users(store_id,id)
);
CREATE TABLE refresh_tokens (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), session_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, consumed_at timestamptz, expires_at timestamptz NOT NULL,
 UNIQUE(store_id,id), FOREIGN KEY(store_id,session_id) REFERENCES auth_sessions(store_id,id)
);
CREATE TABLE password_reset_tokens (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), user_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 UNIQUE(store_id,id), FOREIGN KEY(store_id,user_id) REFERENCES store_users(store_id,id)
);
CREATE TABLE integration_connections (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), name text NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(store_id,id), UNIQUE(store_id,name)
);
CREATE TABLE integration_keys (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), connection_id uuid NOT NULL,
 selector text NOT NULL UNIQUE, secret_hash text NOT NULL, scopes text[] NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(store_id,id),
 FOREIGN KEY(store_id,connection_id) REFERENCES integration_connections(store_id,id)
);
CREATE TABLE products (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), integration_connection_id uuid NOT NULL,
 external_product_id text NOT NULL, description text NOT NULL, photo_url text,
 active boolean NOT NULL DEFAULT true, unit text NOT NULL DEFAULT 'UNIT' CHECK(unit='UNIT'),
 UNIQUE(store_id,id), UNIQUE(store_id,integration_connection_id,external_product_id),
 FOREIGN KEY(store_id,integration_connection_id) REFERENCES integration_connections(store_id,id)
);
CREATE TABLE product_barcodes (
 store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL, barcode text NOT NULL,
 PRIMARY KEY(store_id,barcode), FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id)
);
CREATE TABLE product_inventory (
 store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL, tracking_status text NOT NULL DEFAULT 'UNTRACKED' CHECK(tracking_status IN('UNTRACKED','TRACKED')),
 epoch_id uuid, input_revision bigint NOT NULL DEFAULT 0, applied_input_revision bigint NOT NULL DEFAULT 0,
 projection_revision bigint NOT NULL DEFAULT 0, needs_recount boolean NOT NULL DEFAULT false,
 projected_at timestamptz, PRIMARY KEY(store_id,product_id), FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id)
);
CREATE TABLE count_sessions (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL, actor_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN('DRAFT','COUNTING','CONFIRMED','CANCELLED')),
 version int NOT NULL DEFAULT 1, started_at timestamptz, cutoff_at timestamptz, cancel_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(store_id,id), UNIQUE(store_id,product_id,id),
 FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id), FOREIGN KEY(store_id,actor_id) REFERENCES store_users(store_id,id)
);
CREATE UNIQUE INDEX one_active_count ON count_sessions(store_id,product_id) WHERE status IN('DRAFT','COUNTING');
CREATE TABLE count_lines (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), session_id uuid NOT NULL,
 expires_on date NOT NULL, lot_code text, quantity int NOT NULL CHECK(quantity BETWEEN 0 AND 1000000000), note text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(store_id,id),
 FOREIGN KEY(store_id,session_id) REFERENCES count_sessions(store_id,id)
);
CREATE TABLE inventory_epochs (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL,
 session_id uuid NOT NULL, cutoff_at timestamptz NOT NULL, count_started_at timestamptz NOT NULL,
 closed_at timestamptz, UNIQUE(store_id,id), UNIQUE(store_id,product_id,id),
 FOREIGN KEY(store_id,product_id,session_id) REFERENCES count_sessions(store_id,product_id,id)
);
CREATE UNIQUE INDEX one_current_epoch ON inventory_epochs(store_id,product_id) WHERE closed_at IS NULL;
ALTER TABLE product_inventory ADD FOREIGN KEY(store_id,product_id,epoch_id) REFERENCES inventory_epochs(store_id,product_id,id);
CREATE TABLE stock_records (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL, epoch_id uuid NOT NULL,
 origin text NOT NULL CHECK(origin IN('COUNT','APP_RECEIPT','RETURN_RECEIPT')), expires_on date NOT NULL, lot_code text,
 initial_quantity int NOT NULL CHECK(initial_quantity BETWEEN 0 AND 1000000000), note text,
 available_at timestamptz NOT NULL, allocation_priority_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 version int NOT NULL DEFAULT 1, UNIQUE(store_id,id), UNIQUE(store_id,product_id,id),
 FOREIGN KEY(store_id,product_id,epoch_id) REFERENCES inventory_epochs(store_id,product_id,id)
);
CREATE TABLE import_batches (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), connection_id uuid NOT NULL,
 external_batch_id text NOT NULL, payload_hash text NOT NULL, kind text NOT NULL CHECK(kind IN('CATALOG','MOVEMENTS')),
 status text NOT NULL DEFAULT 'RECEIVED', payload jsonb NOT NULL, errors jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz, UNIQUE(store_id,id),
 UNIQUE(store_id,connection_id,external_batch_id), FOREIGN KEY(store_id,connection_id) REFERENCES integration_connections(store_id,id)
);
CREATE TABLE integration_events (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), connection_id uuid NOT NULL, batch_id uuid NOT NULL,
 external_event_id text NOT NULL, payload_hash text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'RECEIVED',
 error_code text, received_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(store_id,id),
 UNIQUE(store_id,connection_id,external_event_id), FOREIGN KEY(store_id,connection_id) REFERENCES integration_connections(store_id,id),
 FOREIGN KEY(store_id,batch_id) REFERENCES import_batches(store_id,id)
);
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL,
 event_id uuid, occurred_at timestamptz NOT NULL, payload jsonb NOT NULL,
 UNIQUE(store_id,id), UNIQUE(store_id,event_id), FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id),
 FOREIGN KEY(store_id,event_id) REFERENCES integration_events(store_id,id)
);
CREATE INDEX movements_by_product ON stock_movements(store_id,product_id,occurred_at);
CREATE TABLE movement_resolutions (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL,
 movement_id uuid NOT NULL, actor_id uuid NOT NULL, payload jsonb NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(store_id,id),
 FOREIGN KEY(store_id,movement_id) REFERENCES stock_movements(store_id,id), FOREIGN KEY(store_id,actor_id) REFERENCES store_users(store_id,id),
 FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id)
);
CREATE TABLE stock_projections (
 store_id uuid NOT NULL REFERENCES stores(id), record_id uuid NOT NULL, quantity int NOT NULL CHECK(quantity BETWEEN 0 AND 1000000000),
 revision bigint NOT NULL, PRIMARY KEY(store_id,record_id), FOREIGN KEY(store_id,record_id) REFERENCES stock_records(store_id,id)
);
CREATE TABLE movement_allocations (
 store_id uuid NOT NULL REFERENCES stores(id), epoch_id uuid NOT NULL, movement_id uuid NOT NULL,
 record_id uuid NOT NULL, quantity int NOT NULL CHECK(quantity>0), revision bigint NOT NULL,
 PRIMARY KEY(store_id,epoch_id,movement_id,record_id), FOREIGN KEY(store_id,epoch_id) REFERENCES inventory_epochs(store_id,id),
 FOREIGN KEY(store_id,movement_id) REFERENCES stock_movements(store_id,id), FOREIGN KEY(store_id,record_id) REFERENCES stock_records(store_id,id)
);
CREATE TABLE projection_runs (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL, epoch_id uuid NOT NULL,
 revision bigint NOT NULL, input_revision bigint NOT NULL, fingerprint text NOT NULL, summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(store_id,id),
 FOREIGN KEY(store_id,product_id,epoch_id) REFERENCES inventory_epochs(store_id,product_id,id)
);
CREATE TABLE reconciliation_issues (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL,
 identity text NOT NULL, code text NOT NULL, detail jsonb NOT NULL, status text NOT NULL DEFAULT 'OPEN',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(store_id,id), UNIQUE(store_id,product_id,identity),
 FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id)
);
CREATE TABLE notifications (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), product_id uuid NOT NULL, record_id uuid NOT NULL,
 type text NOT NULL, level text NOT NULL, message text NOT NULL, revision int NOT NULL DEFAULT 1,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(store_id,id), UNIQUE(store_id,record_id,type), FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id),
 FOREIGN KEY(store_id,record_id) REFERENCES stock_records(store_id,id)
);
CREATE TABLE notification_reads (
 store_id uuid NOT NULL REFERENCES stores(id), notification_id uuid NOT NULL, user_id uuid NOT NULL, revision int NOT NULL,
 PRIMARY KEY(store_id,notification_id,user_id), FOREIGN KEY(store_id,notification_id) REFERENCES notifications(store_id,id),
 FOREIGN KEY(store_id,user_id) REFERENCES store_users(store_id,id)
);
CREATE TABLE command_receipts (
 store_id uuid NOT NULL REFERENCES stores(id), operation text NOT NULL, idempotency_key uuid NOT NULL,
 principal_id uuid NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(store_id,operation,idempotency_key)
);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), actor_id uuid, action text NOT NULL,
 entity_id uuid, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(store_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations') LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I TO app_runtime USING (%I = nullif(current_setting(''app.store_id'',true),'''')::uuid) WITH CHECK (%I = nullif(current_setting(''app.store_id'',true),'''')::uuid)',t,CASE WHEN t='stores' THEN 'id' ELSE 'store_id' END,CASE WHEN t='stores' THEN 'id' ELSE 'store_id' END);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO app_runtime',t);
 END LOOP;
END $$;
REVOKE UPDATE,DELETE ON stock_movements, movement_resolutions, audit_events, projection_runs FROM app_runtime;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['stores','store_users','auth_sessions','refresh_tokens','password_reset_tokens','integration_keys','integration_connections'] LOOP
  EXECUTE format('GRANT SELECT ON %I TO auth_lookup',t);
  EXECUTE format('CREATE POLICY auth_lookup_read ON %I FOR SELECT TO auth_lookup USING(true)',t);
 END LOOP;
END $$;
CREATE FUNCTION auth.resolve_login(cnpj text, username text) RETURNS TABLE(store_id uuid,user_id uuid,password_hash text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.store_id,u.id,u.password_hash FROM public.store_users u JOIN public.stores s ON s.id=u.store_id WHERE s.cnpj_normalized=cnpj AND u.username_normalized=username AND u.active AND s.active LIMIT 1
$$;
CREATE FUNCTION auth.resolve_refresh(hash text) RETURNS TABLE(store_id uuid,session_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT t.store_id,t.session_id FROM public.refresh_tokens t WHERE token_hash=hash LIMIT 1
$$;
CREATE FUNCTION auth.resolve_password_reset(hash text) RETURNS TABLE(store_id uuid,user_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT t.store_id,t.user_id FROM public.password_reset_tokens t WHERE token_hash=hash LIMIT 1
$$;
CREATE FUNCTION auth.resolve_api_key(key_selector text) RETURNS TABLE(store_id uuid,connection_id uuid,secret_hash text,scopes text[]) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT k.store_id,k.connection_id,k.secret_hash,k.scopes FROM public.integration_keys k JOIN public.integration_connections c ON c.store_id=k.store_id AND c.id=k.connection_id JOIN public.stores s ON s.id=k.store_id WHERE k.selector=key_selector AND k.revoked_at IS NULL AND c.active AND s.active LIMIT 1
$$;
CREATE FUNCTION auth.active_store_ids() RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT s.id FROM public.stores s WHERE active $$;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='auth' LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO auth_lookup',f.name);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_auth',f.name);
 END LOOP;
END $$;
