/**
 * Sobe o ambiente inteiro com um comando: backend, worker, painel, banco, SMTP local
 * e o aplicativo no emulador.
 *
 *   pnpm dev                 tudo
 *   pnpm dev --no-mobile     só a stack web
 *   pnpm dev --only-mobile   só o aplicativo, assumindo a stack já no ar
 *   pnpm dev --build         reconstrói as imagens Docker antes de subir
 *   pnpm dev --headless      emulador sem janela
 *   pnpm dev --docker-apk    compila o APK no container mesmo com JDK e SDK na máquina
 *   pnpm dev:down            derruba a stack e o emulador
 *
 * É idempotente: o que já está rodando é reaproveitado. Sem JDK 21 ou SDK Android na
 * máquina, o APK é compilado no Docker (serviço `mobile` do compose.yaml); sem SDK também
 * não há emulador, e o APK fica em mobile/dist para instalar no coletor.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const compose = ['compose', '-f', join(root, 'compose.yaml')];
const windows = process.platform === 'win32';
const exe = (name) => (windows ? `${name}.exe` : name);
const API = 'http://127.0.0.1:3001/api/v1';
const WEB = 'http://localhost:5174';
const AVD = process.env.AVD_NAME ?? 'coletor';
const PACKAGE = 'br.com.estoque.coletor.debug';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

const step = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
const ok = (text) => console.log(`  \x1b[32m✓\x1b[0m ${text}`);
const skip = (text) => console.log(`  \x1b[33m—\x1b[0m ${text}`);

const quote = (value) => (/[\s&|<>^()]/.test(value) ? `"${value}"` : value);

function run(command, commandArgs, options = {}) {
  // Desde o Node 20.12, spawnSync recusa .bat/.cmd diretamente. Em vez de `shell:
  // true` — que concatena os argumentos sem escapar e emite DEP0190 — chamamos o
  // cmd.exe explicitamente. Com `/s /c` ele remove só as aspas externas, e
  // windowsVerbatimArguments entrega a linha intacta, então caminhos com espaço
  // continuam funcionando.
  const batch = windows && /\.(bat|cmd)$/i.test(command);
  const result = batch
    ? spawnSync(
        'cmd.exe',
        ['/d', '/s', '/c', `"${quote(command)} ${commandArgs.map(quote).join(' ')}"`],
        { cwd: root, encoding: 'utf8', windowsVerbatimArguments: true, ...options },
      )
    : spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function mustRun(command, commandArgs, message, options = {}) {
  const result = run(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    // Com a saída capturada, mostra o que deu errado em vez de só a mensagem.
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(`\n${message}`);
    process.exit(result.status ?? 1);
  }
}

async function waitFor(label, check, { attempts = 90, delay = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, delay));
  }
  console.error(`\nTempo esgotado esperando: ${label}`);
  process.exit(1);
}

const reachable = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    return false;
  }
};

// --- derrubar ----------------------------------------------------------------

if (has('--down')) {
  step('Derrubando');
  const sdk = findSdk();
  if (sdk)
    run(join(sdk, 'platform-tools', exe('adb')), ['-s', 'emulator-5554', 'emu', 'kill'], {
      stdio: 'ignore',
    });
  ok('emulador encerrado (se estava no ar)');
  mustRun('docker', [...compose, 'down'], 'Falha ao derrubar a stack.');
  ok('stack encerrada — o volume do banco foi preservado');
  console.log('\nPara apagar os dados também: docker compose down -v\n');
  process.exit(0);
}

// --- descoberta do ambiente Android ------------------------------------------

function findSdk() {
  for (const candidate of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const local = join(root, '.tools/android-sdk');
  if (existsSync(local)) return local;
  const home = process.env.LOCALAPPDATA ?? process.env.HOME;
  const conventional = home && join(home, 'Android/Sdk');
  return conventional && existsSync(conventional) ? conventional : null;
}

function findJdk() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const base = windows
    ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Eclipse Adoptium')
    : null;
  if (base && existsSync(base)) {
    const found = readdirSync(base).find((name) => name.startsWith('jdk-21'));
    if (found) return join(base, found);
  }
  return null;
}

// --- stack web ---------------------------------------------------------------

if (!has('--only-mobile')) {
  step('Stack Docker');
  if (run('docker', ['info', '--format', '{{.ServerVersion}}']).status !== 0) {
    console.error('\nDocker não está respondendo. Abra o Docker Desktop e tente de novo.');
    process.exit(1);
  }
  mustRun(
    'docker',
    [...compose, 'up', '-d', ...(has('--build') ? ['--build'] : [])],
    'Falha ao subir a stack.',
  );
  await waitFor('a API responder', () => reachable(`${API}/health/ready`));
  ok(`API pronta em ${API}`);
  await waitFor('o painel responder', () => reachable(WEB), { attempts: 45 });
  ok(`painel em ${WEB}`);
  ok('e-mails de alerta em http://localhost:8025');
}

// --- aplicativo --------------------------------------------------------------

if (!has('--no-mobile')) {
  step('Aplicativo Android');
  const sdk = findSdk();
  const jdk = findJdk();
  // Um SDK sem os pacotes do emulador ou do adb é tratado como ausente para o emulador.
  const tool = (...path) => (sdk && existsSync(join(sdk, ...path)) ? join(sdk, ...path) : null);
  const adb = tool('platform-tools', exe('adb'));
  const emulator = tool('emulator', exe('emulator'));

  // Sem SDK não há emulador; o APK é compilado mesmo assim, para instalar no coletor.
  let emulatorReady = false;
  if (adb && emulator) {
    const devices = run(adb, ['devices']).stdout ?? '';
    const avds = run(emulator, ['-list-avds']).stdout ?? '';
    // Um celular ligado por depuração sem fio também aparece no adb, e aí todo comando sem
    // destino falha ("more than one device"). ANDROID_SERIAL manda tudo para o emulador.
    const running = /^(emulator-\d+)\tdevice/m.exec(devices)?.[1];
    process.env.ANDROID_SERIAL = running ?? 'emulator-5554';
    if (running) {
      ok('emulador já estava no ar');
      emulatorReady = true;
    } else if (!avds.split('\n').some((name) => name.trim() === AVD)) {
      skip(`AVD "${AVD}" não existe; crie conforme docs/coletor-ct48.md`);
    } else {
      // Desanexado: o emulador precisa sobreviver ao fim deste processo.
      spawn(
        emulator,
        [
          '-avd',
          AVD,
          '-camera-back',
          process.env.EMULATOR_CAMERA ?? 'webcam0',
          '-camera-front',
          'none',
          '-no-boot-anim',
          ...(has('--headless') ? ['-no-window'] : []),
        ],
        { detached: true, stdio: 'ignore', env: { ...process.env, ANDROID_HOME: sdk } },
      ).unref();
      ok(`emulador "${AVD}" iniciando`);
      run(adb, ['wait-for-device'], { stdio: 'ignore' });
      await waitFor(
        'o Android terminar de iniciar',
        async () =>
          (run(adb, ['shell', 'getprop', 'sys.boot_completed']).stdout ?? '').trim() === '1',
        { delay: 3000, attempts: 60 },
      );
      ok('Android pronto');
      emulatorReady = true;
    }
  }

  let apk;
  if (jdk && sdk && !has('--docker-apk')) {
    console.log('  compilando o APK...');
    mustRun(
      join(root, windows ? 'mobile/gradlew.bat' : 'mobile/gradlew'),
      ['-p', join(root, 'mobile'), ':app:assembleDebug', '--console=plain', '-q'],
      'Falha ao compilar o aplicativo.',
      { env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk } },
    );
    apk = join(root, 'mobile/app/build/outputs/apk/debug/app-debug.apk');
  } else {
    console.log(
      `  ${jdk && sdk ? 'por --docker-apk' : `sem ${!jdk ? 'JDK 21' : 'SDK Android'} na máquina`}:` +
        ' compilando no Docker (a primeira vez baixa o SDK e leva alguns minutos)...',
    );
    mustRun('docker', [...compose, 'run', '--rm', 'mobile'], 'Falha ao compilar no Docker.');
    apk = join(root, 'mobile/dist/app-debug.apk');
  }
  ok(`APK compilado: ${relative(root, apk).replaceAll('\\', '/')}`);

  if (emulatorReady) {
    // Teclado virtual desligado: no coletor ele cobriria metade da tela.
    run(adb, ['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '0'], {
      stdio: 'ignore',
    });
    mustRun(adb, ['install', '-r', apk], 'Falha ao instalar o APK.', { stdio: 'ignore' });
    run(adb, ['shell', 'pm', 'grant', PACKAGE, 'android.permission.CAMERA'], { stdio: 'ignore' });
    run(adb, ['shell', 'am', 'start', '-n', `${PACKAGE}/br.com.estoque.app.MainActivity`], {
      stdio: 'ignore',
    });
    ok('aplicativo instalado e aberto no emulador');
  } else {
    skip('sem emulador: instale o APK no coletor conforme docs/coletor-ct48.md');
  }
}

console.log(`
\x1b[1mTudo no ar.\x1b[0m

  Painel      ${WEB}
  API         ${API}
  E-mails     http://localhost:8025
  Banco       127.0.0.1:54329

  Loja de demonstração: CNPJ 11222333000181, usuário admin.
  A senha inicial é definida pelo seed e exige troca no primeiro acesso.

  Códigos de barras para teste:  node scripts/barcodes.mjs --png
  Derrubar tudo:                 pnpm dev:down
`);
