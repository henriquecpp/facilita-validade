import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const entry = process.argv[2];
if (!['api', 'worker'].includes(entry)) throw new Error('Uso: dev-server.mjs api|worker');
// tsc resolvido do node_modules do pacote: não depende de pnpm no PATH nem dentro do container.
const tsc = createRequire(join(process.cwd(), 'package.json')).resolve('typescript/bin/tsc');
const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const compiler = spawn(
  process.execPath,
  [tsc, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'],
  { stdio: 'inherit' },
);
const runtime = spawn(
  process.execPath,
  ['--env-file-if-exists=../.env', '--watch', `dist/bootstrap/main-${entry}.js`],
  { stdio: 'inherit' },
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  compiler.kill('SIGTERM');
  runtime.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of [compiler, runtime]) {
  child.once('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once('exit', (code) => stop(code ?? 0));
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
