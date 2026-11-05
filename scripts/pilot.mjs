/**
 * Sobe a homologação HTTPS pelo ngrok: painel compilado, API e worker do
 * infra/compose.pilot.yaml, mais o túnel numa janela própria, para acompanhar as requisições.
 *
 *   pnpm pilot          sobe o que faltar (recompila o painel se o código mudou)
 *   pnpm pilot --down   para os serviços da homologação; o túnel fecha com a janela dele
 *
 * Lê PILOT_WEB_ORIGIN e PILOT_JWT_SECRET do .env. Não roda migrations nem seed: o banco é o
 * do ambiente local, já migrado por `pnpm dev`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const compose = [
  'compose',
  '-f',
  join(root, 'compose.yaml'),
  '-f',
  join(root, 'infra/compose.pilot.yaml'),
];
const LOCAL = 'http://127.0.0.1:5188';
const origin = process.env.PILOT_WEB_ORIGIN?.replace(/\/+$/, '');

const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
const ok = (text) => console.log(`  \x1b[32m✓\x1b[0m ${text}`);
const fail = (text) => {
  console.error(`\n${text}`);
  process.exit(1);
};

function mustRun(command, args, message) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.status !== 0) fail(message);
}

async function waitFor(label, check, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`Tempo esgotado esperando: ${label}`);
}

// Sem user-agent de navegador, o ngrok gratuito não mostra a página de aviso dele.
const reachable = async (url) => {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'pilot-check' },
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const tunnelUp = async () => {
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(2000),
    });
    const { tunnels } = await response.json();
    return tunnels.some((t) => t.public_url === origin && t.config?.addr === LOCAL);
  } catch {
    return false;
  }
};

if (process.argv.includes('--down')) {
  step('Parando a homologação');
  mustRun(
    'docker',
    [...compose, 'stop', 'pilot-web', 'pilot-worker', 'pilot-api'],
    'Falha ao parar.',
  );
  ok('pilot-web, pilot-worker e pilot-api parados; feche a janela do ngrok para encerrar o túnel');
  process.exit(0);
}

if (!origin)
  fail('Informe PILOT_WEB_ORIGIN no .env: o domínio HTTPS fixo do ngrok, sem barra final.');

step('Painel compilado');
const newest = (path) => {
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
};
const dist = join(root, 'frontend/dist/index.html');
const sources = ['frontend/src', 'frontend/public', 'frontend/index.html', 'contracts/generated'];
if (
  !existsSync(dist) ||
  Math.max(...sources.map((p) => newest(join(root, p)))) > statSync(dist).mtimeMs
) {
  console.log('  o código mudou desde a última compilação: compilando...');
  mustRun(
    process.platform === 'win32' ? 'cmd.exe' : 'pnpm',
    [
      ...(process.platform === 'win32' ? ['/d', '/c', 'pnpm'] : []),
      '--filter',
      '@controle-estoque/frontend',
      'build',
    ],
    'Falha ao compilar o painel.',
  );
}
ok('frontend/dist em dia');

step('Serviços Docker');
if (spawnSync('docker', ['info', '--format', '{{.ServerVersion}}']).status !== 0)
  fail('Docker não está respondendo. Abra o Docker Desktop e tente de novo.');
mustRun(
  'docker',
  [...compose, 'up', '-d', 'postgres', 'mailpit', 'pilot-api', 'pilot-worker', 'pilot-web'],
  'Falha ao subir a homologação.',
);
await waitFor('o painel responder em 5188', () => reachable(`${LOCAL}/api/v1/health/ready`), 90);
ok(`painel e API em ${LOCAL}`);

step('Túnel ngrok');
if (await tunnelUp()) ok('o túnel já estava aberto');
else {
  const args = ['http', LOCAL, '--url', origin];
  if (process.platform === 'win32') {
    // Janela própria, que sobrevive a este processo e mostra as requisições. O Start-Process já
    // solta o ngrok; com o PowerShell desanexado (detached), o ngrok não chegava a abrir.
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Start-Process ngrok -ArgumentList ${args.map((a) => `'${a}'`).join(',')}`,
      ],
      { stdio: 'ignore' },
    );
  } else {
    console.log(`  abra outro terminal e rode: ngrok ${args.join(' ')}`);
  }
  await waitFor('o túnel do ngrok abrir', tunnelUp, 45);
  ok('túnel aberto numa janela própria');
}
await waitFor('a API responder pelo túnel', () => reachable(`${origin}/api/v1/health/ready`), 30);

console.log(`
\x1b[1mHomologação no ar.\x1b[0m

  Painel (PWA)  ${origin}
  Coletor       mobile/dist/coletor-debug-ngrok.apk (aponta para ${origin}/api/v1/)

  No navegador, a primeira visita mostra o aviso do ngrok: toque em "Visit Site".
  Parar:        pnpm pilot --down
`);
