/**
 * Introspecção do banco para o schema do Prisma, seguida de uma correção fixa.
 *
 * Uso (a partir de backend/): pnpm db:pull
 *
 * O introspector do Prisma 7 declara três relações como 1:1 e depois o próprio
 * validador as rejeita, porque exige `@@unique` exatamente nas colunas da FK:
 *
 *   inventory_epochs → count_sessions   a unicidade vem só do índice parcial
 *                                       one_current_epoch (epochs abertas), não
 *                                       de uma restrição sobre as colunas da FK;
 *   product_inventory → inventory_epochs a unicidade vem da PK (store_id,
 *                                       product_id), subconjunto da FK — o
 *                                       validador não raciocina sobre isso;
 *   inventory_checkpoints → inventory_epochs  o mesmo caso: PK (store_id,
 *                                       product_id) dentro da FK.
 *
 * Declará-las como 1:N é fiel ao banco e não relaxa nada: a integridade é imposta
 * pelo PostgreSQL. Criar índices redundantes só para satisfazer o ORM seria pior.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const backend = resolve(import.meta.dirname, '../backend');
const schema = join(backend, 'prisma/schema.prisma');
const prisma = join(
  backend,
  'node_modules/.bin',
  process.platform === 'win32' ? 'prisma.cmd' : 'prisma',
);

// O schema é inteiramente derivado do banco. Partir só do cabeçalho dá ao Prisma
// um schema válido para reintrospectar — o gerado sempre falha na validação, e a
// CLI se recusa a reintrospectar sobre um schema inválido.
const HEADER = `// Gerado por scripts/prisma-pull.mjs a partir do banco — não edite os modelos à mão.
// Para mudar o schema: nova migration em migrations/*.sql, \`pnpm db:migrate\`,
// \`pnpm db:pull\` e \`pnpm prisma:generate\`.
generator client {
  provider               = "prisma-client"
  output                 = "../src/generated/prisma"
  // Índices únicos parciais (one_active_count, one_current_epoch): sem esta flag o
  // introspector os emite e o validador os rejeita. É flag de recurso, não versão preview.
  previewFeatures        = ["partialIndexes"]
  runtime                = "nodejs"
  moduleFormat           = "esm"
  generatedFileExtension = "ts"
  importFileExtension    = "js"
}

datasource db {
  provider = "postgresql"
}
`;
writeFileSync(schema, HEADER);

const pull = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : prisma,
  process.platform === 'win32' ? ['/d', '/s', '/c', `"${prisma}" db pull`] : ['db', 'pull'],
  { cwd: backend, stdio: 'inherit', windowsVerbatimArguments: true },
);
if (pull.status !== 0) process.exit(pull.status ?? 1);

// Relações a transformar em lista: [modelo onde fica o campo reverso, campo].
const toMany = [
  ['count_sessions', 'inventory_epochs'],
  ['inventory_epochs', 'product_inventory'],
  ['inventory_epochs', 'inventory_checkpoints'],
];

let text = readFileSync(schema, 'utf8');
for (const [model, field] of toMany) {
  const block = new RegExp(`(model ${model} \\{[\\s\\S]*?\\n\\})`);
  const match = text.match(block);
  if (!match) throw new Error(`Modelo ${model} não encontrado no schema.`);
  const line = new RegExp(`(\\n\\s+${field}\\s+)${field}\\?`);
  if (!line.test(match[1])) {
    // Já corrigido, ou o introspector mudou: falhar alto é melhor que seguir errado.
    if (new RegExp(`\\n\\s+${field}\\s+${field}\\[\\]`).test(match[1])) continue;
    throw new Error(`Relação ${model}.${field} não está na forma esperada; revise o script.`);
  }
  text = text.replace(match[1], match[1].replace(line, `$1${field}[]`));
}
writeFileSync(schema, text);
console.log('Schema ajustado: relações compostas declaradas como 1:N.');
