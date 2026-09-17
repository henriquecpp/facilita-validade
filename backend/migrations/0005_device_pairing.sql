-- Pareamento de coletor por QR: o proprietário gera um código de uso único no painel e
-- o coletor o lê para entrar como um operador, sem digitar CNPJ, usuário e senha no
-- teclado numérico. O código em si nunca é gravado, só o hash.
CREATE TABLE device_pairings (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  issued_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store_id, id),
  FOREIGN KEY (store_id, user_id) REFERENCES store_users (store_id, id),
  FOREIGN KEY (store_id, issued_by) REFERENCES store_users (store_id, id),
  CHECK (expires_at > created_at)
);
CREATE INDEX device_pairings_recent ON device_pairings (store_id, created_at DESC);

ALTER TABLE device_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_pairings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON device_pairings TO app_runtime
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON device_pairings TO app_runtime;

-- Antes de conhecer a loja, o coletor só tem o código. Mesmo desenho do
-- auth.resolve_password_reset: função SECURITY DEFINER de leitura mínima, executável
-- apenas pelo papel de pré-autenticação.
GRANT SELECT ON device_pairings TO auth_lookup;
CREATE POLICY auth_lookup_read ON device_pairings FOR SELECT TO auth_lookup USING (true);

CREATE FUNCTION auth.resolve_device_pairing(hash text)
RETURNS TABLE(store_id uuid, pairing_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT p.store_id, p.id FROM public.device_pairings p WHERE p.token_hash = hash LIMIT 1
$$;
ALTER FUNCTION auth.resolve_device_pairing(text) OWNER TO auth_lookup;
REVOKE ALL ON FUNCTION auth.resolve_device_pairing(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_device_pairing(text) TO app_auth;
