import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { argon2id, hash } from 'argon2';
import { normalizeCnpj, validatePassword } from '../modules/identity/domain/identity.js';

if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
  throw new Error('Seed permitido somente em desenvolvimento/teste.');
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error('MIGRATION_DATABASE_URL é obrigatória para provisionamento.');
const password = process.env.SEED_TEMPORARY_PASSWORD ?? 'TroqueEstaSenha!2026';
validatePassword(password);
const passwordHash = await hash(password, {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const fixture of [
    {
      id: '00000000-0000-4000-8000-000000000001',
      cnpj: '11222333000181',
      name: 'Loja Demonstração Centro',
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      cnpj: '11444777000161',
      name: 'Loja Demonstração Bairro',
    },
  ]) {
    normalizeCnpj(fixture.cnpj);
    await client.query(
      'INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,$3) ON CONFLICT(cnpj_normalized) DO NOTHING',
      [fixture.id, fixture.cnpj, fixture.name],
    );
    const store = (
      await client.query<{ id: string }>('SELECT id FROM stores WHERE cnpj_normalized=$1', [
        fixture.cnpj,
      ])
    ).rows[0]!;
    await client.query('INSERT INTO store_settings(store_id) VALUES($1) ON CONFLICT DO NOTHING', [
      store.id,
    ]);
    for (const [username, role] of [
      ['admin', 'OWNER'],
      ['operador', 'OPERATOR'],
    ]) {
      const id = randomUUID();
      const inserted = await client.query(
        'INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,$3,$3,$4,$5,true) ON CONFLICT(store_id,username_normalized) DO NOTHING RETURNING id',
        [id, store.id, username, passwordHash, role],
      );
      if (inserted.rowCount)
        await client.query(
          'INSERT INTO audit_events(id,store_id,action,entity_id,detail) VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), store.id, 'DEV_USER_PROVISIONED', id, { username, role }],
        );
    }
  }
  // Administrador do painel da plataforma (/plataforma), com a mesma senha inicial.
  const platformAdmin = await client.query(
    "INSERT INTO platform.admins(id, username, username_normalized, password_hash) VALUES ($1, 'superadmin', 'superadmin', $2) ON CONFLICT (username_normalized) DO NOTHING RETURNING id",
    [randomUUID(), passwordHash],
  );
  if (platformAdmin.rowCount)
    await client.query('INSERT INTO platform.events(id, action, detail) VALUES ($1, $2, $3)', [
      randomUUID(),
      'PLATFORM_ADMIN_CREATED',
      { operator: 'seed', username: 'superadmin' },
    ]);
  await client.query('COMMIT');
  console.log(
    'Duas lojas locais provisionadas. Usuários: admin e operador; na plataforma, superadmin. A senha inicial exige troca no primeiro acesso. Consulte docs/identity-validacao.md e docs/plataforma.md.',
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
