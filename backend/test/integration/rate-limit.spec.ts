import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Database } from '../../src/shared/infrastructure/database.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';

describe('Limite de requisições com a loja inteira atrás de um IP', () => {
  let database: Database, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    database = new Database();
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({
      database,
      jobs,
      jwtSecret: 'rate-limit-test-secret-with-at-least-32-bytes',
      notificationChannels: [],
    });
  });

  afterAll(async () => {
    await ctx?.app.close();
    await jobs?.stop();
    await ctx?.prisma.close();
    await database?.close();
  });

  const hit = (authorization?: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: authorization ? { authorization } : {},
    });

  it('movimento com token não esgota o limite do login, e cada conta tem o seu', async () => {
    // Coletores e painel do mesmo IP: passam de 300 por minuto sem chegar a 429.
    for (let i = 0; i < 320; i++) expect((await hit('Bearer token-qualquer')).statusCode).toBe(401);
    // A conta sem token (login, renovação) continua livre.
    expect((await hit()).statusCode).toBe(401);
    for (let i = 0; i < 299; i++) await hit();
    // Recusa clara, e não 500: o coletor não confunde com envio sem confirmação.
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await hit('Bearer token-qualquer')).statusCode).toBe(401);
  });

  it('corpo grande demais é recusado como 413, não como falha do servidor', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/refresh',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-qualquer' },
      payload: JSON.stringify({ refreshToken: 'x'.repeat(3 * 1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'HTTP_413' });
  });
});
