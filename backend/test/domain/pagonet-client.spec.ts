import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PagonetClient,
  PagonetError,
} from '../../src/modules/integration/adapters/out/pagonet-client.js';

/** Bridge falsa: cada teste escolhe a resposta da próxima chamada. */
let next: { status: number; body: unknown; headers?: Record<string, string>; drop?: boolean };
const received: { path: string; auth?: string; body: string }[] = [];
let server: Server;
let client: PagonetClient;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ path: request.url ?? '', auth: request.headers.authorization, body });
      response.writeHead(next.status, { 'content-type': 'application/json', ...next.headers });
      const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
      // Conexão que cai no meio do corpo, como num catálogo grande.
      if (next.drop) {
        response.flushHeaders();
        response.write(text.slice(0, Math.floor(text.length / 2)));
        setTimeout(() => response.socket?.destroy(), 20);
      } else response.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = new PagonetClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 5000);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const failure = async (call: Promise<unknown>) => {
  const error = await call.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PagonetError);
  return error as PagonetError;
};

describe('cliente da Bridge da Pagonet', () => {
  it('consulta as vendas do dia com o token e o CNPJ', async () => {
    next = {
      status: 201,
      body: [
        {
          id: '21905',
          data: '2026-10-12T00:00:00',
          hora: '10:32',
          codcaixa: '15',
          coo: '4023',
          codprod: '1005778',
          qtd: 1,
          descricao: 'DANONE',
        },
        {
          id: 21908,
          data: '2026-10-12T00:00:00',
          hora: '10:33',
          codcaixa: '15',
          coo: '4023',
          qtd: 1,
        },
      ],
    };
    const sales = await client.sales('token-de-teste', '37466214000168', '2026-10-12');
    expect(sales).toEqual([
      { id: '21905', data: '2026-10-12T00:00:00', hora: '10:32', codprod: '1005778', qtd: 1 },
      { id: '21908', data: '2026-10-12T00:00:00', hora: '10:33', codprod: undefined, qtd: 1 },
    ]);
    expect(received.at(-1)).toEqual({
      path: '/facilita-validade/vendas',
      auth: 'Bearer token-de-teste',
      body: JSON.stringify({ cnpj: '37466214000168', data: '2026-10-12' }),
    });
  });

  it('traduz recusa, limite e indisponibilidade em mensagens para o painel', async () => {
    next = { status: 401, body: { statusCode: 401, message: 'Invalid or expired token' } };
    expect((await failure(client.status('x'))).code).toBe('AUTH');

    next = { status: 429, body: { statusCode: 429 }, headers: { 'retry-after': '300' } };
    const limited = await failure(client.products('x', '37466214000168'));
    expect(limited.code).toBe('RATE_LIMITED');
    expect(limited.retryAfterSeconds).toBe(300);

    next = { status: 404, body: { statusCode: 404, message: 'CNPJ 123 not found' } };
    expect((await failure(client.barcodes('x', '123'))).message).toContain('CNPJ 123 not found');

    next = { status: 502, body: '<html>Bad gateway</html>' };
    expect((await failure(client.barcodes('x', '1'))).code).toBe('UNAVAILABLE');

    next = {
      status: 201,
      body: Array(500).fill({ codformavenda: '1', codigo_barras: '789' }),
      drop: true,
    };
    const dropped = await failure(client.barcodes('x', '1'));
    expect(dropped.code).toBe('UNAVAILABLE');
    expect(dropped.message).toContain('não respondeu');
  });

  it('não aceita resposta fora do formato combinado', async () => {
    next = { status: 201, body: { items: [] } };
    expect((await failure(client.products('x', '1'))).code).toBe('INVALID_RESPONSE');
    next = { status: 201, body: [{ codformavenda: '1', descricao: 'Sem codprod', ativo: '1' }] };
    expect((await failure(client.products('x', '1'))).message).toContain('codprod');
    next = {
      status: 201,
      body: [{ id: '1', data: '2026-10-12T00:00:00', hora: '10:00', qtd: '1' }],
    };
    expect((await failure(client.sales('x', '1', '2026-10-12'))).code).toBe('INVALID_RESPONSE');
  });
});
