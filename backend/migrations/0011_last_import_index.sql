-- "Última importação" é o fim do processamento do lote mais recente (completed_at), como já
-- era no painel da loja; o painel da plataforma usava a chegada (created_at). Com um lote a
-- cada leitura de vendas, a conta varria todos os lotes da loja, e a lista da plataforma a
-- repete para cada loja: o índice responde direto.
CREATE INDEX import_batches_last_completed ON import_batches (store_id, completed_at DESC);

REVOKE SELECT (created_at) ON import_batches FROM platform_owner;
GRANT SELECT (completed_at) ON import_batches TO platform_owner;

-- Mesma assinatura: dono, SECURITY DEFINER e permissões continuam os de antes.
CREATE OR REPLACE FUNCTION platform.stores()
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
         (SELECT max(b.completed_at) FROM public.import_batches b WHERE b.store_id = s.id)
    FROM public.stores s
    LEFT JOIN public.pagonet_sources p ON p.store_id = s.id
   ORDER BY s.name, s.id
$$;
