import { describe, expect, it } from 'vitest';
import {
  ErpReportError,
  MAX_BARCODES_PER_PRODUCT,
  MAX_ROWS_PER_BATCH,
  mapCatalogReport,
  mapSalesReport,
} from '../../src/modules/integration/domain/erp-report.js';

const produto = (codformavenda: string, descricao = `Produto ${codformavenda}`) => ({
  codprod: '100',
  codformavenda,
  descricao,
});

describe('catálogo vindo de produtos + produtos_ean', () => {
  it('usa codformavenda como produto e reúne todos os EAN dele', () => {
    const { batch, issues } = mapCatalogReport({
      externalBatchId: 'catalogo-1',
      produtos: [produto('4471', 'Iogurte natural 170g')],
      // Embalagem trocada: o EAN antigo continua cadastrado.
      produtosEan: [
        { codformavenda: '4471', ean: '7891000100103' },
        { codformavenda: '4471', ean: '0007891000001' },
      ],
    });

    expect(issues).toEqual([]);
    expect(batch.products).toEqual([
      {
        externalProductId: '4471',
        description: 'Iogurte natural 170g',
        barcodes: ['0007891000001', '7891000100103'],
      },
    ]);
  });

  // O mesmo codprod aparece em várias linhas: uma por forma de venda. É o
  // codformavenda que define o que se vende separado, então é ele o produto aqui.
  it('mantém as formas de venda do mesmo codprod como produtos distintos', () => {
    const { batch, issues } = mapCatalogReport({
      externalBatchId: 'catalogo-1',
      produtos: [
        { codprod: '100', codformavenda: '4471', descricao: 'Iogurte unidade' },
        { codprod: '100', codformavenda: '4472', descricao: 'Iogurte embalagem' },
        { codprod: '100', codformavenda: '4473', descricao: 'Iogurte com 6' },
        { codprod: '100', codformavenda: '4474', descricao: 'Iogurte com 12' },
        { codprod: '100', codformavenda: '4475', descricao: 'Iogurte fardo' },
      ],
      produtosEan: [
        { codformavenda: '4471', ean: '111' },
        { codformavenda: '4472', ean: '222' },
        { codformavenda: '4473', ean: '333' },
        { codformavenda: '4474', ean: '444' },
        { codformavenda: '4475', ean: '555' },
      ],
    });

    // codprod repetido não é conflito: cinco linhas, cinco produtos.
    expect(issues).toEqual([]);
    expect(batch.products.map((p) => p.externalProductId)).toEqual([
      '4471',
      '4472',
      '4473',
      '4474',
      '4475',
    ]);
    expect(batch.products.map((p) => p.barcodes)).toEqual([
      ['111'],
      ['222'],
      ['333'],
      ['444'],
      ['555'],
    ]);
  });

  it('não confunde formas de venda quando a venda informa o mesmo codprod', () => {
    const { batch } = mapSalesReport({
      externalBatchId: 'vendas-1',
      vendas: [
        {
          dataHora: '2026-09-25T16:00:00-03:00',
          codprod: '100',
          codformavenda: '4471',
          quantidade: 3,
        },
        {
          dataHora: '2026-09-25T16:00:00-03:00',
          codprod: '100',
          codformavenda: '4474',
          quantidade: 1,
        },
      ],
    });

    // Mesmo instante e mesmo codprod, formas diferentes: dois eventos, sem soma.
    expect(batch.events).toHaveLength(2);
    expect(batch.events.map((e) => [e.externalProductId, e.quantity])).toEqual([
      ['4471', 3],
      ['4474', 1],
    ]);
  });

  it('preserva zeros à esquerda do EAN', () => {
    const { batch } = mapCatalogReport({
      externalBatchId: 'catalogo-1',
      produtos: [produto('4471')],
      produtosEan: [{ codformavenda: '4471', ean: '0007891000001' }],
    });

    expect(batch.products[0]!.barcodes).toEqual(['0007891000001']);
  });

  it('descarta EAN compartilhado por duas formas de venda, sem escolher vencedor', () => {
    const { batch, issues } = mapCatalogReport({
      externalBatchId: 'catalogo-1',
      produtos: [produto('4471'), produto('4472')],
      produtosEan: [
        { codformavenda: '4471', ean: '999' },
        { codformavenda: '4472', ean: '999' },
      ],
    });

    expect(issues).toEqual([
      {
        code: 'BARCODE_SHARED_BY_PRODUCTS',
        reference: '999',
        message: 'EAN associado a mais de uma forma de venda (4471, 4472); descartado',
      },
    ]);
    expect(batch.products.every((p) => p.barcodes.length === 0)).toBe(true);
  });

  it('relata EAN que aponta para forma de venda ausente', () => {
    const { issues } = mapCatalogReport({
      externalBatchId: 'catalogo-1',
      produtos: [produto('4471')],
      produtosEan: [{ codformavenda: '9999', ean: '123' }],
    });

    expect(issues).toMatchObject([{ code: 'BARCODE_WITHOUT_PRODUCT', reference: '123' }]);
  });

  it('relata codformavenda repetido e mantém a primeira linha', () => {
    const { batch, issues } = mapCatalogReport({
      externalBatchId: 'catalogo-1',
      produtos: [produto('4471', 'Primeira'), produto('4471', 'Segunda')],
    });

    expect(issues).toMatchObject([{ code: 'DUPLICATE_CODFORMAVENDA', reference: '4471' }]);
    expect(batch.products[0]!.description).toBe('Primeira');
  });

  it('aceita produto sem nenhum EAN cadastrado', () => {
    const { batch, issues } = mapCatalogReport({
      externalBatchId: 'catalogo-1',
      produtos: [produto('4471')],
    });

    expect(issues).toEqual([]);
    expect(batch.products[0]!.barcodes).toEqual([]);
  });

  it('corta EAN acima do limite do contrato e avisa', () => {
    const produtosEan = Array.from({ length: MAX_BARCODES_PER_PRODUCT + 3 }, (_, i) => ({
      codformavenda: '4471',
      ean: String(100000 + i),
    }));
    const { batch, issues } = mapCatalogReport({
      externalBatchId: 'catalogo-1',
      produtos: [produto('4471')],
      produtosEan,
    });

    expect(issues).toMatchObject([{ code: 'TOO_MANY_BARCODES', reference: '4471' }]);
    expect(batch.products[0]!.barcodes).toHaveLength(MAX_BARCODES_PER_PRODUCT);
  });

  it('produz o mesmo lote quando as linhas chegam em outra ordem', () => {
    // O hash do lote identifica a reexportação: com a ordem das linhas mudando o hash,
    // reenviar o mesmo relatório com o mesmo identificador daria BATCH_CONFLICT.
    const produtos = [produto('30'), produto('10'), produto('20')];
    const produtosEan = [
      { codformavenda: '20', ean: '7890000000020' },
      { codformavenda: '10', ean: '7890000000010' },
      { codformavenda: '30', ean: '7890000000030' },
    ];
    const first = mapCatalogReport({ externalBatchId: 'catalogo-3', produtos, produtosEan });
    const reversed = mapCatalogReport({
      externalBatchId: 'catalogo-3',
      produtos: [...produtos].reverse(),
      produtosEan: [...produtosEan].reverse(),
    });
    expect(reversed.batch).toEqual(first.batch);
    expect(first.batch.products.map((p) => p.externalProductId)).toEqual(['10', '20', '30']);
  });
  it('recusa catálogo acima do limite de lote', () => {
    const produtos = Array.from({ length: MAX_ROWS_PER_BATCH + 1 }, (_, i) => produto(String(i)));
    expect(() => mapCatalogReport({ externalBatchId: 'catalogo-1', produtos })).toThrow(
      ErpReportError,
    );
  });
});

describe('vendas vindas de Data Hora / Codprod / Codformavenda / Quantidade', () => {
  it('converte cada linha em um SALE identificado pelos próprios dados', () => {
    const { batch, issues, mergedRows } = mapSalesReport({
      externalBatchId: 'vendas-2026-09-25',
      vendas: [
        {
          dataHora: '2026-09-25T16:00:00-03:00',
          codprod: '100',
          codformavenda: '4471',
          quantidade: 8,
        },
      ],
    });

    expect(issues).toEqual([]);
    expect(mergedRows).toBe(0);
    expect(batch.events).toEqual([
      {
        externalEventId: 'venda:2026-09-25T19:00:00.000Z:4471',
        externalProductId: '4471',
        type: 'SALE',
        // Normalizado para UTC: é o que mantém o lote independente da ordem das linhas.
        occurredAt: '2026-09-25T19:00:00.000Z',
        quantity: 8,
      },
    ]);
  });

  it('dá baixa pela forma de venda, não pelo codprod', () => {
    const { batch } = mapSalesReport({
      externalBatchId: 'vendas-1',
      vendas: [
        {
          dataHora: '2026-09-25T16:00:00-03:00',
          codprod: '100',
          codformavenda: '4471',
          quantidade: 1,
        },
        {
          dataHora: '2026-09-25T16:00:00-03:00',
          codprod: '100',
          codformavenda: '4472',
          quantidade: 1,
        },
      ],
    });

    expect(batch.events.map((e) => e.externalProductId)).toEqual(['4471', '4472']);
  });

  it('soma linhas com mesmo instante e mesma forma de venda', () => {
    const { batch, mergedRows } = mapSalesReport({
      externalBatchId: 'vendas-1',
      vendas: [
        { dataHora: '2026-09-25T16:00:00-03:00', codformavenda: '4471', quantidade: 6 },
        { dataHora: '2026-09-25T16:00:00-03:00', codformavenda: '4471', quantidade: 2 },
      ],
    });

    expect(mergedRows).toBe(1);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]!.quantity).toBe(8);
  });

  it('gera o mesmo identificador para o mesmo instante escrito com outro fuso', () => {
    const local = mapSalesReport({
      externalBatchId: 'vendas-1',
      vendas: [{ dataHora: '2026-09-25T16:00:00-03:00', codformavenda: '4471', quantidade: 8 }],
    });
    const utc = mapSalesReport({
      externalBatchId: 'vendas-1',
      vendas: [{ dataHora: '2026-09-25T19:00:00Z', codformavenda: '4471', quantidade: 8 }],
    });

    expect(utc.batch.events[0]!.externalEventId).toBe(local.batch.events[0]!.externalEventId);
  });

  it('produz o mesmo resultado quando as linhas chegam em outra ordem', () => {
    const vendas = [
      { dataHora: '2026-09-25T16:00:00-03:00', codformavenda: '4471', quantidade: 8 },
      { dataHora: '2026-09-25T17:00:00-03:00', codformavenda: '4472', quantidade: 3 },
      { dataHora: '2026-09-25T15:00:00-03:00', codformavenda: '4471', quantidade: 1 },
    ];
    const direta = mapSalesReport({ externalBatchId: 'vendas-1', vendas });
    const invertida = mapSalesReport({
      externalBatchId: 'vendas-1',
      vendas: [...vendas].reverse(),
    });

    expect(invertida.batch.events).toEqual(direta.batch.events);
  });

  it('linhas somadas geram o mesmo lote em qualquer ordem, mesmo com fusos diferentes', () => {
    // Mesmo instante escrito de duas formas: vão para o mesmo evento. O lote inteiro,
    // não só o identificador, precisa independer da ordem — é o hash dele que torna
    // o reenvio idempotente.
    const vendas = [
      { dataHora: '2026-09-25T16:00:00-03:00', codformavenda: '4471', quantidade: 6 },
      { dataHora: '2026-09-25T19:00:00Z', codformavenda: '4471', quantidade: 2 },
    ];
    const direta = mapSalesReport({ externalBatchId: 'vendas-1', vendas });
    const invertida = mapSalesReport({
      externalBatchId: 'vendas-1',
      vendas: [...vendas].reverse(),
    });

    expect(invertida.batch).toEqual(direta.batch);
    expect(direta.batch.events).toHaveLength(1);
    expect(direta.batch.events[0]!.quantity).toBe(8);
  });

  it('relata Data Hora inválida sem descartar o restante do lote', () => {
    const { batch, issues } = mapSalesReport({
      externalBatchId: 'vendas-1',
      vendas: [
        { dataHora: 'ontem', codformavenda: '4471', quantidade: 1 },
        { dataHora: '2026-09-25T16:00:00-03:00', codformavenda: '4472', quantidade: 2 },
      ],
    });

    expect(issues).toMatchObject([{ code: 'INVALID_DATE', reference: 'linha 1' }]);
    expect(batch.events).toHaveLength(1);
  });

  it('repassa o período declarado quando informado', () => {
    const { batch } = mapSalesReport({
      externalBatchId: 'vendas-1',
      periodStart: '2026-09-25T00:00:00-03:00',
      periodEnd: '2026-09-26T00:00:00-03:00',
      completeThrough: '2026-09-26T00:00:00-03:00',
      vendas: [{ dataHora: '2026-09-25T16:00:00-03:00', codformavenda: '4471', quantidade: 1 }],
    });

    expect(batch.periodStart).toBe('2026-09-25T00:00:00-03:00');
    expect(batch.completeThrough).toBe('2026-09-26T00:00:00-03:00');
  });

  it('recusa relatório sem nenhuma linha utilizável', () => {
    expect(() =>
      mapSalesReport({
        externalBatchId: 'vendas-1',
        vendas: [{ dataHora: 'ontem', codformavenda: '4471', quantidade: 1 }],
      }),
    ).toThrow(ErpReportError);
  });
});
