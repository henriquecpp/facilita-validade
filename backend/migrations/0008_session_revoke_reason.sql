-- Por que a sessão terminou, quando não foi o próprio usuário que saiu. 'ADMIN': o
-- proprietário desconectou o aparelho pelo painel, alterou o usuário ou redefiniu a senha
-- dele. O coletor mostra isso no login, em vez de "sessão expirada".
ALTER TABLE auth_sessions
  ADD COLUMN revoked_reason text CHECK (revoked_reason IN ('ADMIN'));
