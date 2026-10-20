-- Níveis de urgência definidos pela loja (reunião de 16/10/2026; docs/requisitos-reuniao-
-- 2026-10-16.md, AV32). Antes eram dois níveis fixos, Urgente e Atenção, com os dias em
-- store_settings, mais o Vencido implícito.
--
-- Cada nível cobre uma faixa de dias até o vencimento, contada na data de hoje da loja: dias
-- negativos são lotes já vencidos, e um limite nulo é a faixa aberta daquele lado. As faixas
-- de uma loja não se sobrepõem; o servidor recusa a gravação que as sobreponha. Um lote fora
-- de todas as faixas fica sem nível.
CREATE TABLE expiry_levels (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 40),
  min_days int CHECK (min_days BETWEEN -36500 AND 36500),
  max_days int CHECK (max_days BETWEEN -36500 AND 36500),
  color text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  -- Entra no resumo diário e nas notificações.
  notify boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store_id, id),
  CHECK (min_days IS NULL OR max_days IS NULL OR min_days <= max_days)
);
CREATE INDEX expiry_levels_by_store ON expiry_levels (store_id, min_days);

ALTER TABLE expiry_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_levels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expiry_levels TO app_runtime
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON expiry_levels TO app_runtime;

-- Toda loja nova começa com os níveis de antes: Vencido, Urgente até 5 dias, Atenção de 6 a
-- 15 e Em dia a partir de 16, este sem aviso. Pelo gatilho, vale para qualquer caminho que
-- crie a loja (provisionamento, seed, testes).
CREATE FUNCTION default_expiry_levels(store uuid, high int, medium int) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  INSERT INTO public.expiry_levels(id, store_id, name, min_days, max_days, color, notify) VALUES
    (gen_random_uuid(), store, 'Vencido', NULL, -1, '#c62828', true),
    (gen_random_uuid(), store, 'Urgente', 0, high, '#ef6c00', true),
    (gen_random_uuid(), store, 'Atenção', high + 1, medium, '#f9a825', true),
    (gen_random_uuid(), store, 'Em dia', medium + 1, NULL, '#2e7d32', false)
$$;
REVOKE ALL ON FUNCTION default_expiry_levels(uuid, int, int) FROM PUBLIC;

CREATE FUNCTION store_settings_default_levels() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM public.default_expiry_levels(NEW.store_id, 5, 15);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION store_settings_default_levels() FROM PUBLIC;
CREATE TRIGGER store_settings_default_levels AFTER INSERT ON store_settings
  FOR EACH ROW EXECUTE FUNCTION store_settings_default_levels();

-- Lojas existentes: os mesmos quatro níveis, com os dias que cada uma tinha configurado.
SELECT default_expiry_levels(store_id, high_days, medium_days) FROM store_settings;

-- Alertas de validade passam a guardar o nível da loja (o id, em texto) no lugar do código
-- fixo. Os ativos de hoje vão para o nível equivalente sem mudar de revisão: quem já leu
-- continua com o alerta lido, e a troca não conta como mudança de nível.
UPDATE notifications n SET level = l.id::text
  FROM expiry_levels l
 WHERE n.type = 'EXPIRY' AND l.store_id = n.store_id
   AND l.name = CASE n.level WHEN 'EXPIRED' THEN 'Vencido'
                             WHEN 'HIGH' THEN 'Urgente'
                             WHEN 'MEDIUM' THEN 'Atenção' END;

ALTER TABLE store_settings
  DROP COLUMN high_days,
  DROP COLUMN medium_days,
  -- Trava otimista da lista de níveis, separada da versão das configurações.
  ADD COLUMN levels_version int NOT NULL DEFAULT 1;
