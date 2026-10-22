-- Códigos de barras que faltaram no catálogo da Pagonet (17/10/2026).
--
-- A leitura gravava o resumo de cada produto (erp_hash) antes dos códigos de barras dele.
-- Interrompida entre os dois passos, deixava produtos sem código, e nenhuma leitura seguinte
-- corrigia, porque o resumo já batia: na loja-piloto, 21 mil dos 24,7 mil produtos ficaram sem
-- código, e o coletor não os achava pela leitura. A leitura agora grava o resumo só depois dos
-- códigos. Sem os resumos de antes, a próxima leitura regrava o catálogo inteiro, com os
-- códigos, e ela é pedida já.
UPDATE products SET erp_hash = NULL WHERE erp_hash IS NOT NULL;
UPDATE pagonet_sources SET catalog_hash = NULL, catalog_requested_at = clock_timestamp();
