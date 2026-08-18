-- Function argument "username" previously collided with store_users.username.
-- Positional arguments make the lookup independent of column-name resolution.
CREATE OR REPLACE FUNCTION auth.resolve_login(cnpj text, username text)
RETURNS TABLE(store_id uuid,user_id uuid,password_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.store_id,u.id,u.password_hash
 FROM public.store_users AS u
 JOIN public.stores AS s ON s.id=u.store_id
 WHERE s.cnpj_normalized=$1 AND u.username_normalized=$2 AND u.active AND s.active
 LIMIT 1
$$;
ALTER FUNCTION auth.resolve_login(text,text) OWNER TO auth_lookup;
REVOKE ALL ON FUNCTION auth.resolve_login(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_login(text,text) TO app_auth;
