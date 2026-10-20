-- NV01 (17/10/2026): limite único por nível. Preserva os registros existentes,
-- incluindo ids referenciados por alertas, nomes, cores e opção de aviso.
-- Os consumidores antigos continuam lendo min_days, agora derivado dos limites.
-- Nenhum nível é criado para cobrir o que está acima do maior limite finito.

-- O limite superior pode chegar a 36500; o início derivado do último nível aberto
-- precisa, nesse caso, permitir 36501. Não amplia o limite configurável pelo usuário.
ALTER TABLE expiry_levels DROP CONSTRAINT expiry_levels_min_days_check;
ALTER TABLE expiry_levels ADD CONSTRAINT expiry_levels_min_days_check
  CHECK (min_days BETWEEN -36500 AND 36501);

WITH hierarchy AS (
  SELECT id, store_id,
         CASE WHEN row_number() OVER ordered = 1 THEN NULL
              ELSE lag(max_days) OVER ordered + 1 END AS derived_min_days
    FROM expiry_levels
  WINDOW ordered AS (PARTITION BY store_id ORDER BY max_days NULLS LAST, id)
), changed AS (
  UPDATE expiry_levels l SET min_days = h.derived_min_days
    FROM hierarchy h
   WHERE l.id = h.id AND l.store_id = h.store_id
     AND l.min_days IS DISTINCT FROM h.derived_min_days
  RETURNING l.store_id
)
-- Invalida editores abertos antes da migração, sem alterar versões das outras
-- configurações nem renomear/recriar os níveis.
UPDATE store_settings SET levels_version = levels_version + 1
 WHERE store_id IN (SELECT store_id FROM changed);

-- NULL é o único nível aberto final. Adiada até o commit para permitir que a
-- edição troque os limites de dois níveis na mesma transação sem conflito transitório.
ALTER TABLE expiry_levels ADD CONSTRAINT expiry_levels_store_limit_key
  UNIQUE NULLS NOT DISTINCT (store_id, max_days) DEFERRABLE INITIALLY DEFERRED;
