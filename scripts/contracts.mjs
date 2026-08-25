import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';
import { generateKotlinDtos } from './contracts-kotlin.mjs';
const check = process.argv.includes('--check');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ['--test', 'scripts/contracts-kotlin.test.mjs']);
run('pnpm', ['--filter', '@controle-estoque/backend', 'build']);
run(process.execPath, ['dist/bootstrap/openapi.js', ...(check ? ['--check'] : [])], {
  cwd: 'backend',
});
const ast = await openapiTS(new URL('../contracts/openapi.json', import.meta.url));
const output =
  '/** Generated from contracts/openapi.json. Run pnpm contracts:generate. */\n' + astToString(ast);
const target = new URL('../contracts/generated/api.d.ts', import.meta.url);
if (check) {
  if ((await readFile(target, 'utf8')) !== output)
    throw new Error('Tipos da API desatualizados. Execute pnpm contracts:generate.');
} else {
  await mkdir(new URL('../contracts/generated/', import.meta.url), { recursive: true });
  await writeFile(target, output);
}
const kotlinOutput = generateKotlinDtos(
  JSON.parse(await readFile(new URL('../contracts/openapi.json', import.meta.url), 'utf8')),
);
const kotlinTarget = new URL(
  '../mobile/core/network/src/main/kotlin/br/com/estoque/core/network/generated/OpenApiDtos.kt',
  import.meta.url,
);
if (check) {
  if ((await readFile(kotlinTarget, 'utf8')) !== kotlinOutput)
    throw new Error('DTOs Kotlin desatualizados. Execute pnpm contracts:generate.');
} else {
  await mkdir(new URL('.', kotlinTarget), { recursive: true });
  await writeFile(kotlinTarget, kotlinOutput);
}
console.log('Contrato, tipos TypeScript e DTOs Kotlin conferidos.');
