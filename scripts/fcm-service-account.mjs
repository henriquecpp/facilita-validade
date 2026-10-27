/**
 * Põe a chave da conta de serviço do Firebase (push do coletor) no .env, como
 * FCM_SERVICE_ACCOUNT_JSON numa linha só e entre aspas simples, do jeito que o Compose e o
 * `node --env-file` leem. Não imprime a chave.
 *
 * Uso: node scripts/fcm-service-account.mjs <chave.json> [arquivo .env] [--google-services <arquivo>]
 *
 * A chave sai do console do Firebase: Configurações do projeto → Contas de serviço → Gerar nova
 * chave privada. Com --google-services, o google-services.json do app também preenche
 * FCM_APP_ID, FCM_API_KEY e FCM_SENDER_ID do pacote br.com.estoque.coletor (--pacote troca o
 * pacote, por exemplo br.com.estoque.coletor.debug). Depois de rodar, apague os arquivos
 * baixados e recrie a API e o worker.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const googleServices = option('--google-services');
const pack = option('--pacote') ?? 'br.com.estoque.coletor';
const [source, target = resolve(import.meta.dirname, '../.env')] = args;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!source)
  fail(
    'Uso: node scripts/fcm-service-account.mjs <chave.json> [arquivo .env] [--google-services <arquivo>]',
  );

const account = JSON.parse(readFileSync(source, 'utf8'));
for (const field of ['project_id', 'client_email', 'private_key']) {
  if (typeof account[field] !== 'string' || !account[field])
    fail(`O arquivo não é uma chave de conta de serviço: falta ${field}.`);
}
// JSON.stringify mantém as quebras da chave privada escapadas (\n), e a chave não tem aspas
// simples, então o valor vai literal entre aspas simples.
const values = { FCM_SERVICE_ACCOUNT_JSON: `'${JSON.stringify(account)}'` };

if (googleServices) {
  const config = JSON.parse(readFileSync(googleServices, 'utf8'));
  const client = config.client?.find(
    (c) => c.client_info?.android_client_info?.package_name === pack,
  );
  if (!client) fail(`O google-services.json não tem o app ${pack}.`);
  if (config.project_info?.project_id !== account.project_id)
    fail('O google-services.json e a chave são de projetos diferentes do Firebase.');
  values.FCM_APP_ID = client.client_info.mobilesdk_app_id;
  values.FCM_API_KEY = client.api_key?.[0]?.current_key;
  values.FCM_SENDER_ID = config.project_info.project_number;
  if (!values.FCM_API_KEY) fail(`O google-services.json não tem a chave de API do app ${pack}.`);
}

const lines = readFileSync(target, 'utf8').split(/\r?\n/);
if (lines.at(-1) === '') lines.pop();
for (const [name, value] of Object.entries(values)) {
  const line = `${name}=${value}`;
  const at = lines.findIndex((text) => text.startsWith(`${name}=`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
}
writeFileSync(target, `${lines.join('\n')}\n`);
console.log(`Firebase gravado em ${target}`);
console.log(`  projeto ${account.project_id}, conta ${account.client_email}`);
if (googleServices) console.log(`  app ${pack}: ${values.FCM_APP_ID}`);
