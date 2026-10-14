-- Painel da plataforma (super admin): quem opera o serviço e atende todas as lojas.
--
-- Fica fora das lojas e do RLS delas: schema próprio, tabelas sem store_id e sem nenhum
-- acesso do papel app_runtime. A API chega aqui só pelas funções SECURITY DEFINER deste
-- schema, executadas pelo papel de pré-autenticação (app_auth), o mesmo desenho de auth.*.
--
-- O que a plataforma muda numa loja (cadastro, suspensão, acesso do proprietário) não
-- passa por aqui: roda no contexto da própria loja, sob o RLS de sempre, e fica no
-- histórico da loja (audit_events, ações PLATFORM_*) na mesma transação da mudança.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_owner') THEN
    CREATE ROLE platform_owner NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
CREATE SCHEMA platform;
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
GRANT USAGE ON SCHEMA platform TO app_auth, platform_owner;
GRANT USAGE ON SCHEMA public TO platform_owner;

CREATE TABLE platform.admins (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  username_normalized text NOT NULL UNIQUE CHECK (username_normalized ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Sessão do painel: cookie HttpOnly com um segredo aleatório; aqui fica só o hash.
CREATE TABLE platform.sessions (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES platform.admins (id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_open ON platform.sessions (admin_id) WHERE revoked_at IS NULL;
-- Ações da própria plataforma: entrar, trocar senha, criar administrador.
CREATE TABLE platform.events (
  id uuid PRIMARY KEY,
  admin_id uuid REFERENCES platform.admins (id),
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX events_recent ON platform.events (created_at DESC, id DESC);
ALTER TABLE platform.admins OWNER TO platform_owner;
ALTER TABLE platform.sessions OWNER TO platform_owner;
ALTER TABLE platform.events OWNER TO platform_owner;

-- Leitura entre lojas, só das colunas que o painel mostra: nada de senha, estoque,
-- vendas ou credenciais.
GRANT SELECT (id, cnpj_normalized, name, timezone, active, created_at) ON stores TO platform_owner;
GRANT SELECT (store_id, username, role, active) ON store_users TO platform_owner;
GRANT SELECT (store_id, active, sales_through, last_error) ON pagonet_sources TO platform_owner;
GRANT SELECT (store_id, created_at) ON import_batches TO platform_owner;
GRANT SELECT (id, store_id, action, detail, created_at) ON audit_events TO platform_owner;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['stores', 'store_users', 'pagonet_sources', 'import_batches', 'audit_events'] LOOP
    EXECUTE format('CREATE POLICY platform_read ON %I FOR SELECT TO platform_owner USING (true)', t);
  END LOOP;
END $$;
-- O histórico da plataforma lê as ações PLATFORM_* de todas as lojas.
CREATE INDEX audit_events_platform ON audit_events (created_at DESC, id DESC)
  WHERE action LIKE 'PLATFORM\_%';

-- Entrar: o hash sai só para o servidor conferir a senha. Inativo não existe.
CREATE FUNCTION platform.resolve_admin(login text)
RETURNS TABLE(id uuid, username text, password_hash text, must_change_password boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT a.id, a.username, a.password_hash, a.must_change_password
    FROM platform.admins a
   WHERE a.username_normalized = $1 AND a.active
$$;

-- Abre a sessão depois da senha conferida e registra a entrada.
CREATE FUNCTION platform.open_session(admin uuid, hash text, ttl_seconds integer)
RETURNS TABLE(session_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  created uuid := gen_random_uuid();
  expiry timestamptz := clock_timestamp() + make_interval(secs => ttl_seconds);
BEGIN
  IF ttl_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'ttl_seconds fora do intervalo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.admins a WHERE a.id = admin AND a.active) THEN
    RAISE EXCEPTION 'administrador inativo';
  END IF;
  INSERT INTO platform.sessions (id, admin_id, token_hash, expires_at)
  VALUES (created, admin, hash, expiry);
  INSERT INTO platform.events (id, admin_id, action)
  VALUES (gen_random_uuid(), admin, 'PLATFORM_LOGIN');
  RETURN QUERY SELECT created, expiry;
END $$;

-- Cada requisição do painel: sessão aberta, dentro do prazo, de administrador ativo.
CREATE FUNCTION platform.resolve_session(hash text)
RETURNS TABLE(session_id uuid, admin_id uuid, username text, must_change_password boolean,
              expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.id, a.id, a.username, a.must_change_password, s.expires_at
    FROM platform.sessions s
    JOIN platform.admins a ON a.id = s.admin_id
   WHERE s.token_hash = $1 AND s.revoked_at IS NULL
     AND s.expires_at > clock_timestamp() AND a.active
$$;

CREATE FUNCTION platform.close_session(hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE platform.sessions SET revoked_at = clock_timestamp()
   WHERE token_hash = $1 AND revoked_at IS NULL
$$;

-- Troca de senha: a sessão atual continua; as outras do administrador acabam.
-- Falso quando a sessão já não vale.
CREATE FUNCTION platform.change_password(active_session uuid, new_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  target uuid;
BEGIN
  SELECT s.admin_id INTO target
    FROM platform.sessions s
   WHERE s.id = active_session AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
     FOR UPDATE;
  IF target IS NULL THEN
    RETURN false;
  END IF;
  UPDATE platform.admins SET password_hash = new_hash, must_change_password = false
   WHERE id = target;
  UPDATE platform.sessions SET revoked_at = clock_timestamp()
   WHERE admin_id = target AND id <> active_session AND revoked_at IS NULL;
  INSERT INTO platform.events (id, admin_id, action)
  VALUES (gen_random_uuid(), target, 'PLATFORM_PASSWORD_CHANGED');
  RETURN true;
END $$;

-- Lojas para o painel: cadastro, quem administra e se os dados estão chegando.
CREATE FUNCTION platform.stores()
RETURNS TABLE(id uuid, cnpj text, name text, timezone text, active boolean,
              created_at timestamptz, active_users integer, owners text[],
              pagonet_active boolean, sales_through text, pagonet_error text,
              last_import_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.id, s.cnpj_normalized, s.name, s.timezone, s.active, s.created_at,
         (SELECT count(*)::integer FROM public.store_users u
           WHERE u.store_id = s.id AND u.active),
         ARRAY(SELECT u.username FROM public.store_users u
                WHERE u.store_id = s.id AND u.active AND u.role = 'OWNER'
                ORDER BY u.username),
         p.active, p.sales_through, p.last_error,
         (SELECT max(b.created_at) FROM public.import_batches b WHERE b.store_id = s.id)
    FROM public.stores s
    LEFT JOIN public.pagonet_sources p ON p.store_id = s.id
   ORDER BY s.name, s.id
$$;

-- Histórico: as ações da plataforma e as que ela fez nas lojas (no histórico de cada loja,
-- com o operador no detalhe). Mais recentes primeiro; o cursor é o id do último item.
CREATE FUNCTION platform.history(after_id uuid, max_rows integer)
RETURNS TABLE(id uuid, created_at timestamptz, action text, operator text, store_id uuid,
              store_name text, detail jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH merged AS (
    SELECT e.id, e.created_at, e.action, coalesce(a.username, e.detail ->> 'operator') AS operator,
           NULL::uuid AS store_id, NULL::text AS store_name, e.detail
      FROM platform.events e
      LEFT JOIN platform.admins a ON a.id = e.admin_id
    UNION ALL
    SELECT v.id, v.created_at, v.action, v.detail ->> 'operator', v.store_id, s.name, v.detail
      FROM public.audit_events v
      JOIN public.stores s ON s.id = v.store_id
     WHERE v.action LIKE 'PLATFORM\_%'
  )
  SELECT m.id, m.created_at, m.action, m.operator, m.store_id, m.store_name, m.detail
    FROM merged m
   WHERE $1 IS NULL
      OR (m.created_at, m.id) < (SELECT c.created_at, c.id FROM merged c WHERE c.id = $1)
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT least(greatest($2, 1), 101)
$$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS name FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'platform' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO platform_owner', f.name);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_auth', f.name);
  END LOOP;
END $$;
