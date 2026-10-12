/**
 * Tradução dos relatórios da origem para o contrato canônico de importação.
 *
 * A origem modela produto em dois níveis: `produtos` tem `codformavenda` único e
 * `produtos_ean` guarda vários EAN para a mesma forma de venda — é assim que uma
 * troca de embalagem preserva os códigos antigos. O produto desta aplicação é o
 * `codformavenda`, porque a origem não fornece fator de conversão entre formas de
 * venda e só nesse nível a quantidade é inequívoca. O `codprod` é aceito e
 * ignorado para efeito de saldo. Ver `docs/especificacao-estoque.md`, seção 5.
 *
 * Estas funções são puras: não acessam banco, relógio nem rede. Problemas de uma
 * linha viram `ReportIssue` e a linha é descartada; problemas que invalidam o lote
 * inteiro viram `ErpReportError`.
 */

/** Limites do contrato canônico de importação, repetidos aqui para falhar cedo. */
export const MAX_BARCODES_PER_PRODUCT = 50;
export const MAX_ROWS_PER_BATCH = 1000;

export class ErpReportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ErpReportError';
  }
}

export interface ReportIssue {
  readonly code: string;
  /** Linha ou chave da origem a que o problema se refere. */
  readonly reference: string;
  readonly message: string;
}

/** Dados do cadastro além da descrição, quando a origem os manda. */
export interface ProductDetails {
  /** Grupo do ERP (`codgrupo`). */
  readonly group: string | null;
  /** Categoria dentro do grupo (`codcategoria`). */
  readonly category: string | null;
  readonly salePrice: number | null;
  /** A linha da origem, como veio. */
  readonly attributes: Readonly<Record<string, unknown>> | null;
}

export interface ProdutoRow {
  readonly codprod?: string;
  readonly codformavenda: string;
  readonly descricao: string;
  /** Ausente quando a origem não informa: o produto entra como ativo. */
  readonly ativo?: boolean;
  readonly details?: ProductDetails;
}

export interface ProdutoEanRow {
  readonly codformavenda: string;
  readonly ean: string;
}

export interface CatalogReport {
  readonly externalBatchId: string;
  readonly produtos: readonly ProdutoRow[];
  readonly produtosEan?: readonly ProdutoEanRow[];
}

export interface VendaRow {
  readonly dataHora: string;
  readonly codprod?: string;
  readonly codformavenda: string;
  readonly quantidade: number;
}

export interface SalesReport {
  readonly externalBatchId: string;
  readonly vendas: readonly VendaRow[];
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly completeThrough?: string;
}

export interface CatalogProduct {
  externalProductId: string;
  description: string;
  barcodes: string[];
  active?: boolean;
  details?: ProductDetails;
}

interface MovementEvent {
  externalEventId: string;
  externalProductId: string;
  type: 'SALE';
  quantity: number;
  occurredAt: string;
}

export interface MappedCatalog {
  readonly batch: { externalBatchId: string; products: CatalogProduct[] };
  readonly issues: ReportIssue[];
}

export interface MappedSales {
  readonly batch: {
    externalBatchId: string;
    events: MovementEvent[];
    periodStart?: string;
    periodEnd?: string;
    completeThrough?: string;
  };
  readonly issues: ReportIssue[];
  /** Linhas absorvidas por outra com mesmo instante e forma de venda. */
  readonly mergedRows: number;
}

const text = (value: string): string => value.trim();

/**
 * Instante canônico em UTC, usado como parte da identidade do evento. Normalizar
 * aqui faz o mesmo instante escrito com outro deslocamento produzir a mesma chave,
 * então reexportar o período gera exatamente os mesmos identificadores.
 */
function instantKey(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * `produtos` + `produtos_ean` viram produtos do catálogo canônico, em ordem fixa e sem
 * limite de tamanho: quem chama divide em lotes.
 *
 * A origem garante `unique(codformavenda, ean)`, o que não impede o mesmo EAN de
 * aparecer em duas formas de venda. O destino não admite isso — um código de barras
 * identifica um produto só —, então esse caso vira problema relatado e o EAN é
 * descartado, em vez de escolher um vencedor arbitrário.
 */
export function buildCatalog(
  produtos: readonly ProdutoRow[],
  produtosEan: readonly ProdutoEanRow[] = [],
  /** Códigos por produto: o do contrato de importação, salvo quando o lote não passa por ele. */
  maxBarcodes = MAX_BARCODES_PER_PRODUCT,
): { products: CatalogProduct[]; issues: ReportIssue[] } {
  const issues: ReportIssue[] = [];
  const products = new Map<string, CatalogProduct>();

  for (const row of produtos) {
    const key = text(row.codformavenda);
    if (products.has(key)) {
      issues.push({
        code: 'DUPLICATE_CODFORMAVENDA',
        reference: key,
        message: 'codformavenda repetido no relatório; a primeira linha foi mantida',
      });
      continue;
    }
    products.set(key, {
      externalProductId: key,
      description: text(row.descricao),
      barcodes: [],
      ...(row.ativo === undefined ? {} : { active: row.ativo }),
      ...(row.details ? { details: row.details } : {}),
    });
  }

  // Um EAN em duas formas de venda é ambíguo: nenhuma das duas o recebe.
  const owners = new Map<string, Set<string>>();
  for (const row of produtosEan) {
    const ean = text(row.ean);
    const owner = text(row.codformavenda);
    if (!ean) {
      issues.push({ code: 'EMPTY_BARCODE', reference: owner, message: 'EAN vazio; descartado' });
      continue;
    }
    owners.set(ean, (owners.get(ean) ?? new Set()).add(owner));
  }

  for (const [ean, holders] of owners) {
    if (holders.size > 1) {
      issues.push({
        code: 'BARCODE_SHARED_BY_PRODUCTS',
        reference: ean,
        message: `EAN associado a mais de uma forma de venda (${[...holders].sort().join(', ')}); descartado`,
      });
      continue;
    }
    const owner = [...holders][0]!;
    const product = products.get(owner);
    if (!product) {
      issues.push({
        code: 'BARCODE_WITHOUT_PRODUCT',
        reference: ean,
        message: `EAN referencia codformavenda ${owner}, ausente do relatório de produtos`,
      });
      continue;
    }
    product.barcodes.push(ean);
  }

  for (const product of products.values()) {
    product.barcodes.sort();
    if (product.barcodes.length > maxBarcodes) {
      issues.push({
        code: 'TOO_MANY_BARCODES',
        reference: product.externalProductId,
        message: `mais de ${maxBarcodes} EAN; os excedentes foram descartados`,
      });
      product.barcodes.length = maxBarcodes;
    }
  }

  // Ordem fixa: o mesmo relatório reexportado com as linhas em outra ordem precisa gerar o
  // mesmo lote, ou o reenvio com o mesmo identificador seria recusado como conflito.
  const sorted = [...products.values()].sort((a, b) =>
    a.externalProductId < b.externalProductId
      ? -1
      : a.externalProductId > b.externalProductId
        ? 1
        : 0,
  );
  return { products: sorted, issues };
}

/** Relatório de catálogo enviado à API: vira um lote só, de até `MAX_ROWS_PER_BATCH`. */
export function mapCatalogReport(report: CatalogReport): MappedCatalog {
  const { products: mapped, issues } = buildCatalog(report.produtos, report.produtosEan);
  if (!mapped.length)
    throw new ErpReportError('EMPTY_CATALOG', 'Nenhum produto utilizável no relatório');
  if (mapped.length > MAX_ROWS_PER_BATCH)
    throw new ErpReportError(
      'CATALOG_TOO_LARGE',
      `Relatório com ${mapped.length} produtos; divida em lotes de até ${MAX_ROWS_PER_BATCH}`,
    );

  return { batch: { externalBatchId: text(report.externalBatchId), products: mapped }, issues };
}

/**
 * Linhas de venda viram eventos `SALE` canônicos.
 *
 * O relatório não traz identificador de linha, então a identidade sai dos próprios
 * dados: instante em UTC mais forma de venda. Linhas que coincidem nessas duas
 * chaves são somadas — para o saldo, duas vendas do mesmo produto no mesmo instante
 * são indistinguíveis, e somá-las mantém o identificador estável independentemente
 * da ordem das linhas em uma reexportação.
 */
export function mapSalesReport(report: SalesReport): MappedSales {
  const issues: ReportIssue[] = [];
  const events = new Map<string, MovementEvent>();
  let mergedRows = 0;

  report.vendas.forEach((row, index) => {
    const instant = instantKey(row.dataHora);
    if (!instant) {
      issues.push({
        code: 'INVALID_DATE',
        reference: `linha ${index + 1}`,
        message: `Data Hora inválida: ${row.dataHora}`,
      });
      return;
    }
    const product = text(row.codformavenda);
    if (!product) {
      issues.push({
        code: 'MISSING_CODFORMAVENDA',
        reference: `linha ${index + 1}`,
        message: 'linha sem codformavenda',
      });
      return;
    }
    const id = `venda:${instant}:${product}`;
    const existing = events.get(id);
    if (existing) {
      existing.quantity += row.quantidade;
      mergedRows += 1;
      return;
    }
    events.set(id, {
      externalEventId: id,
      externalProductId: product,
      type: 'SALE',
      // O instante canônico, não o texto da linha: linhas somadas podem trazer o
      // mesmo instante escrito com outro fuso ou outra precisão, e guardar o texto da
      // primeira faria o lote depender da ordem — e o reenvio idêntico cair em 409.
      // Frações abaixo do milissegundo se perdem; um relatório de vendas não as tem.
      occurredAt: instant,
      quantity: row.quantidade,
    });
  });

  const mapped = [...events.values()].sort((a, b) =>
    a.externalEventId < b.externalEventId ? -1 : a.externalEventId > b.externalEventId ? 1 : 0,
  );
  if (!mapped.length)
    throw new ErpReportError('EMPTY_SALES', 'Nenhuma linha de venda utilizável no relatório');
  if (mapped.length > MAX_ROWS_PER_BATCH)
    throw new ErpReportError(
      'SALES_TOO_LARGE',
      `Relatório com ${mapped.length} eventos; divida em lotes de até ${MAX_ROWS_PER_BATCH}`,
    );

  return {
    batch: {
      externalBatchId: text(report.externalBatchId),
      events: mapped,
      ...(report.periodStart ? { periodStart: report.periodStart } : {}),
      ...(report.periodEnd ? { periodEnd: report.periodEnd } : {}),
      ...(report.completeThrough ? { completeThrough: report.completeThrough } : {}),
    },
    issues,
    mergedRows,
  };
}
