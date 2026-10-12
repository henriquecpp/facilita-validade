import type { PagonetBarcode, PagonetProduct, PagonetSale } from '../../domain/pagonet.js';

export const PAGONET_URL = 'https://bridge.pagonet.com.br';

export type PagonetFailure =
  'AUTH' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'REJECTED';

/** Falha esperada da Pagonet, com mensagem pronta para o painel. Nunca carrega o token. */
export class PagonetError extends Error {
  constructor(
    readonly code: PagonetFailure,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'PagonetError';
  }
}

type Row = Record<string, unknown>;

/** Campo de texto; números são aceitos e convertidos, para uma mudança de tipo não parar tudo. */
function text(row: Row, field: string, required: boolean, line: number): string | undefined {
  const value = row[field];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw new PagonetError(
      'INVALID_RESPONSE',
      `Resposta da Pagonet sem "${field}" na linha ${line}.`,
    );
  }
  throw new PagonetError('INVALID_RESPONSE', `Campo "${field}" inesperado na linha ${line}.`);
}

/**
 * Número da origem, que pode vir como número ou como texto ("12.90"). Formato inesperado
 * fica sem valor, em vez de virar um preço inventado ou parar o catálogo inteiro.
 */
function decimal(row: Row, field: string): number | undefined {
  const value = row[field];
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function rows(payload: unknown, route: string): Row[] {
  if (!Array.isArray(payload))
    throw new PagonetError(
      'INVALID_RESPONSE',
      `A rota ${route} da Pagonet não devolveu uma lista.`,
    );
  return payload.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new PagonetError('INVALID_RESPONSE', `Linha ${index + 1} de ${route} não é um objeto.`);
    return row as Row;
  });
}

/**
 * Cliente das rotas do Facilita Validade na Bridge da Pagonet. Cada rota de dados aceita
 * uma chamada a cada 5 minutos; quem chama controla o ritmo. As respostas são conferidas
 * campo a campo: formato diferente do esperado vira erro, nunca dado inventado.
 */
export class PagonetClient {
  constructor(
    readonly baseUrl = process.env.PAGONET_BASE_URL || PAGONET_URL,
    readonly timeoutMs = 120_000,
    readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  /**
   * Confere o token. Não tem limite de chamadas. Roda dentro de uma requisição do painel,
   * então espera pouco: a API corta a requisição em 20 segundos.
   */
  async status(token: string): Promise<{ userName: string | null }> {
    const payload = await this.call('/facilita-validade/status', token, undefined, 10_000);
    const user =
      payload && typeof payload === 'object' && 'user' in payload
        ? (payload as { user?: { name?: unknown } }).user
        : undefined;
    return { userName: typeof user?.name === 'string' ? user.name : null };
  }

  async products(token: string, cnpj: string): Promise<PagonetProduct[]> {
    const payload = await this.call('/facilita-validade/produtos', token, { cnpj });
    return rows(payload, 'produtos').map((row, index) => ({
      codprod: text(row, 'codprod', true, index + 1)!,
      codformavenda: text(row, 'codformavenda', true, index + 1)!,
      descricao: text(row, 'descricao', true, index + 1)!,
      descricao_venda: text(row, 'descricao_venda', false, index + 1),
      ativo: text(row, 'ativo', true, index + 1)!,
      codgrupo: text(row, 'codgrupo', false, index + 1),
      codcategoria: text(row, 'codcategoria', false, index + 1),
      preco_venda: decimal(row, 'preco_venda'),
      raw: row,
    }));
  }

  async barcodes(token: string, cnpj: string): Promise<PagonetBarcode[]> {
    const payload = await this.call('/facilita-validade/codigos-barras', token, { cnpj });
    return rows(payload, 'codigos-barras').map((row, index) => ({
      codformavenda: text(row, 'codformavenda', true, index + 1)!,
      codigo_barras: text(row, 'codigo_barras', true, index + 1)!,
    }));
  }

  async sales(token: string, cnpj: string, date: string): Promise<PagonetSale[]> {
    const payload = await this.call('/facilita-validade/vendas', token, { cnpj, data: date });
    return rows(payload, 'vendas').map((row, index) => {
      const qtd = row.qtd;
      if (typeof qtd !== 'number')
        throw new PagonetError(
          'INVALID_RESPONSE',
          `Quantidade inesperada na linha ${index + 1} de vendas.`,
        );
      return {
        id: text(row, 'id', true, index + 1)!,
        data: text(row, 'data', true, index + 1)!,
        hora: text(row, 'hora', true, index + 1)!,
        codprod: text(row, 'codprod', false, index + 1),
        qtd,
      };
    });
  }

  private async call(
    path: string,
    token: string,
    body?: Record<string, string>,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    let response: Response;
    let raw: string;
    // A leitura do corpo fica no mesmo try: o catálogo tem 8 MB, e a conexão pode cair ou o
    // tempo esgotar no meio dele, não só antes da resposta começar.
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(Math.min(timeoutMs, this.timeoutMs)),
      });
      raw = await response.text();
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError' ? 'tempo esgotado' : 'sem conexão';
      throw new PagonetError('UNAVAILABLE', `A Pagonet não respondeu (${reason}).`);
    }
    let payload: unknown;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = undefined;
    }
    if (response.ok) {
      if (payload === undefined)
        throw new PagonetError('INVALID_RESPONSE', 'A Pagonet respondeu algo que não é JSON.');
      return payload;
    }
    const remote =
      payload && typeof payload === 'object' && 'message' in payload
        ? [(payload as { message: unknown }).message]
            .flat()
            .filter((m) => typeof m === 'string')
            .join('; ')
        : '';
    switch (response.status) {
      case 401:
        throw new PagonetError('AUTH', 'A Pagonet recusou o token: inválido ou expirado.');
      case 403:
        throw new PagonetError('AUTH', 'O token não tem acesso a este CNPJ na Pagonet.');
      case 404:
        throw new PagonetError(
          'NOT_FOUND',
          `A Pagonet não encontrou o pedido${remote ? `: ${remote}` : '.'}`,
        );
      case 429: {
        const retry = Number(response.headers.get('retry-after'));
        throw new PagonetError(
          'RATE_LIMITED',
          'Limite de chamadas da Pagonet atingido; a próxima tentativa espera a janela.',
          Number.isFinite(retry) && retry > 0 ? retry : undefined,
        );
      }
      default:
        if (response.status >= 500)
          throw new PagonetError(
            'UNAVAILABLE',
            `A Pagonet está com falha (HTTP ${response.status}).`,
          );
        throw new PagonetError(
          'REJECTED',
          `A Pagonet recusou a consulta (HTTP ${response.status})${remote ? `: ${remote}` : '.'}`,
        );
    }
  }
}
