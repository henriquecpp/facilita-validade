-- A lista de importações conta os eventos de cada lote. Com a leitura automática de vendas
-- os lotes se multiplicam ao longo do dia, e a contagem precisa achar os eventos do lote
-- sem varrer a tabela.
CREATE INDEX integration_events_by_batch ON integration_events (store_id, batch_id);
