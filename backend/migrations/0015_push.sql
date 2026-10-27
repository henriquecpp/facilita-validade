-- Notificações push para o proprietário, no painel instalado como aplicativo (Web Push) e no
-- coletor (Firebase Cloud Messaging); reunião de 16/10/2026, AV18 e AV25.
--
-- Cada inscrição pertence à sessão em que foi feita: só recebe enquanto a sessão vale e o
-- usuário é proprietário ativo. Sair, ser desconectado pelo painel ou ter o papel trocado
-- encerra o envio, mesmo que o aparelho não avise.
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('WEB', 'FCM')),
  -- Web Push: a URL do serviço de push do navegador. FCM: o token de registro do aparelho.
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2000),
  -- Chaves da inscrição Web Push (RFC 8291), em base64url.
  p256dh text,
  auth text,
  failures int NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (store_id, id),
  UNIQUE (store_id, endpoint),
  FOREIGN KEY (store_id, user_id) REFERENCES store_users (store_id, id),
  FOREIGN KEY (store_id, session_id) REFERENCES auth_sessions (store_id, id),
  CHECK ((kind = 'WEB') = (p256dh IS NOT NULL AND auth IS NOT NULL))
);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON push_subscriptions TO app_runtime
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO app_runtime;

-- Alerta que ainda não foi avisado por push: um lote que entrou num nível que avisa (ou
-- venceu) e um lote que as vendas zeraram. A varredura do worker junta os pendentes da loja
-- num push só por minuto.
ALTER TABLE notifications ADD COLUMN push_pending boolean NOT NULL DEFAULT false;
CREATE INDEX notifications_push_pending ON notifications (store_id) WHERE push_pending;
