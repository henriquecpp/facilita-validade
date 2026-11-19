# Facilita Validade

Controle de estoque e validade por loja: painel web, aplicativo do coletor e integração com o sistema da loja. Monorepo com **NestJS + Fastify**, **React**, **Kotlin Android** e **PostgreSQL**. Login por CNPJ, usuário e senha; dados isolados por loja. O backend e o worker compartilham o motor de estoque e usam filas persistidas no PostgreSQL. Várias lojas no mesmo serviço: o [painel da plataforma](docs/plataforma.md) (super admin) cadastra, suspende e reativa lojas e devolve o acesso de um proprietário.

O sistema registra uma contagem completa por produto, acrescenta entradas, aceita baixa manual, exclusão e correção de lotes e recebe vendas/descarte/devoluções por API. A baixa é estimada: menor validade primeiro, depois ordem de lançamento e ID estável. Uma recontagem substitui a referência do produto; ela não acrescenta as unidades contadas ao saldo anterior.

## Executar localmente

Um comando sobe **tudo** — PostgreSQL, migrations, seed, API, worker, painel, SMTP local e o aplicativo no emulador:

```sh
pnpm dev
```

É idempotente: o que já está no ar é reaproveitado. Sem JDK 21 ou SDK Android na máquina, o APK é compilado no Docker; sem SDK também não há emulador, e o APK fica em `mobile/dist/` para instalar no coletor. Variações:

| Comando                  | O que faz                                     |
| ------------------------ | --------------------------------------------- |
| `pnpm dev --no-mobile`   | só a stack web                                |
| `pnpm dev --only-mobile` | só o aplicativo, com a stack já no ar         |
| `pnpm dev --build`       | reconstrói as imagens Docker antes de subir   |
| `pnpm dev --headless`    | emulador sem janela                           |
| `pnpm dev --docker-apk`  | compila o APK no container, como sem JDK/SDK  |
| `pnpm dev:down`          | derruba emulador e stack, preservando o banco |

Sem passar pelo script, pelo [`compose.yaml`](compose.yaml) da raiz:

| Comando                                   | O que faz                                           |
| ----------------------------------------- | --------------------------------------------------- |
| `docker compose up --build -d`            | banco, migrations, API, worker, painel e SMTP local |
| `docker compose up -d postgres mailpit`   | só banco e SMTP, para os comandos `pnpm dev:*`      |
| `docker compose run --rm mobile`          | compila o APK de debug em `mobile/dist/`            |
| `docker compose run --rm mobile <tarefa>` | outra tarefa do Gradle, como `testDebugUnitTest`    |
| `docker compose down`                     | derruba a stack; com `-v`, apaga também os volumes  |

- Painel: **http://localhost:5174**.
- Painel da plataforma (super admin): **http://localhost:5174/platform**, usuário `superadmin` com a senha inicial do seed, trocada no primeiro acesso.
- API: **http://localhost:3001/api/v1**.
- Saúde: **http://localhost:3001/api/v1/health/ready**.
- E-mails de alerta: **http://localhost:8025** (Mailpit; nada sai da máquina).
- PostgreSQL local: `127.0.0.1:54329`.

O serviço `migrate` roda antes de tudo: aplica as migrations, cria os papéis restritos e executa o seed. API e worker só sobem depois que ele termina com sucesso. As imagens de desenvolvimento montam `src/`, então editar o código recompila e reinicia sem novo `build`.

A leitura da Pagonet usa um token só, da aplicação: `PAGONET_TOKEN` no `.env` da raiz. Cada loja lê sempre os dados do próprio CNPJ. Sem o token, nenhuma loja lê a Pagonet. Depois de preencher, `docker compose up -d` recria a API e o worker.

As notificações push do proprietário, no painel instalado como aplicativo e no coletor, são opcionais. Para o painel, `node scripts/web-push-keys.mjs` gera as chaves VAPID, que vão no `.env` da raiz; o navegador só oferece push em `localhost` ou com HTTPS. Para o coletor, o projeto do Firebase vai nas variáveis `FCM_*`. Detalhes em [operação](docs/operacao.md#notificações-push-do-proprietário).

Para um coletor na rede local, `API_BIND=0.0.0.0` publica a API fora do loopback e `MOBILE_API_BASE_URL=http://IP-DESTA-MAQUINA:3001/api/v1/` aponta o APK compilado no Docker para ela; os dois podem ficar no `.env` da raiz.

Para abrir o painel num celular na mesma rede, `WEB_BIND=0.0.0.0` publica a porta 5174 fora do loopback e `WEB_LAN_ORIGIN=http://IP-DESTA-MAQUINA:5174` faz o login aceitar esse endereço; no celular, abra `http://IP-DESTA-MAQUINA:5174`. Depois de mudar o `.env`, `docker compose up -d` recria o que mudou. A API continua só no loopback: o painel a alcança pelo proxy do Vite, dentro do Docker.

O aplicativo roda no emulador ou no coletor, não no Docker: o container só compila e testa. Um emulador em container precisaria de KVM, que o Docker Desktop no Windows não entrega aos containers, e não alcançaria a webcam nem o USB do coletor.

### Sem Docker, ou para rodar lint e testes

Requisitos: Node **24.18.0** e pnpm **12.6.0**. O `.nvmrc` fixa a versão do Node; com nvm-for-windows, uma versão diferente da instalada faz qualquer comando `pnpm` falhar dentro do repositório — instale a versão do `.nvmrc`. Sem pnpm no PATH, use `corepack pnpm` ou `npx --yes pnpm@12.6.0`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres mailpit
pnpm db:migrate
pnpm db:seed
```

`cp` é necessário somente na primeira instalação: preserve seu `.env` existente. Os dados e senhas do Compose são exclusivamente locais. A migration usa `MIGRATION_DATABASE_URL`; API e worker usam os papéis restritos `DATABASE_URL`/`AUTH_DATABASE_URL`.

Depois, três terminais na raiz: `pnpm dev:backend`, `pnpm dev:worker` e `pnpm dev:frontend`.

`WEB_ORIGIN` lista, separados por vírgula, os endereços exatos pelos quais o painel é aberto: o login web recusa qualquer outra origem (proteção CSRF). Em desenvolvimento são `http://localhost:5174` e `http://127.0.0.1:5174`, que para o navegador são origens diferentes. O proxy de desenvolvimento usa `VITE_DEV_API_TARGET` quando definido; padrão `http://127.0.0.1:3001`. As portas 3000 e 5173 foram preservadas porque outros projetos já as utilizavam nesta máquina.

## Acesso de desenvolvimento

O seed cria duas lojas fictícias, com CNPJs `11222333000181` e `11444777000161`, e usuários `admin` (OWNER) e `operador` (OPERATOR). A senha inicial padrão é `TroqueEstaSenha!2026`; `SEED_TEMPORARY_PASSWORD` permite substituí-la antes de criar os usuários. A troca é obrigatória no primeiro acesso. Reexecutar o seed preserva credenciais e dados existentes.

O catálogo começa vazio. No painel, o proprietário cria uma conexão de integração e emite uma chave; o integrador envia produtos e movimentos usando essa chave. Exemplos estão em [`contracts/fixtures`](contracts/fixtures). Adapte os instantes ao cenário de teste: vendas anteriores à contagem não diminuem novamente o saldo. A chave da integração não é um login humano.

## Android

O aplicativo está em `mobile/`. O [guia Android](docs/android-validacao.md) contém as versões, comandos completos, relatórios e homologação pendente.

```sh
export JAVA_HOME="$PWD/.tools/jdk-21"
export ANDROID_HOME="$PWD/.tools/android-sdk"
export PATH="$JAVA_HOME/bin:$PATH"
./mobile/gradlew -p mobile ktlintCheck :app:assembleDebug :app:lintDebug :core:domain:test :core:network:test --no-daemon
```

Os caminhos `.tools` existem nesta máquina e são ignorados pelo Git; em outra máquina, aponte para seu JDK 21 completo e SDK Android 36. APK local: [`mobile/app/build/outputs/apk/debug/app-debug.apk`](mobile/app/build/outputs/apk/debug/app-debug.apk).

Sem JDK nem SDK, o mesmo conjunto roda num container com as mesmas versões (a primeira execução baixa o SDK):

```sh
docker compose run --rm mobile ktlintCheck :core:domain:test :core:network:test testDebugUnitTest :app:assembleDebug :app:lintDebug
```

O debug usa `http://10.0.2.2:3001/api/v1/` no emulador. No coletor físico, compile com `-PapiBaseUrl=http://IP-DO-SERVIDOR:3001/api/v1/`. Release exige URL HTTPS e assinatura própria (`:app:prepareReleaseApk`, ver [deploy](docs/deploy.md#passo-12--gerar-o-apk-do-coletor)). `:app:assembleDemo` gera um APK de teste offline, sem servidor, para conferir teclado e leitor ([coletor](docs/coletor-ct48.md#teste-de-teclado-sem-servidor-apk-offline)). A compilação não comprova funcionamento do leitor/câmera no coletor real.

## Verificações

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm contracts:check
pnpm build
```

Os testes de integração exigem o PostgreSQL local migrado e `.env` em desenvolvimento/teste; usam dados identificados por UUIDs próprios e os papéis restritos reais. Não aponte esses testes para produção. A suíte padrão mantém os testes de banco separados.

Para o teste de navegador, mantenha os três processos ativos e informe uma conta local:

```sh
E2E_API_URL=http://127.0.0.1:3001 \
E2E_WEB_URL=http://localhost:5174 \
E2E_CNPJ=11222333000181 \
E2E_USERNAME=admin \
E2E_PASSWORD='senha-local-atual' \
E2E_CHROME_PATH=/usr/bin/google-chrome \
pnpm test:e2e
```

No primeiro acesso, forneça também `E2E_NEW_PASSWORD`. Use o Chromium do Playwright quando Chrome não estiver instalado; veja [validação web](docs/frontend-validacao.md). O teste cria produtos e movimentos E2E e preserva seu histórico.

## Contrato e administração

`pnpm contracts:generate` atualiza [`contracts/openapi.json`](contracts/openapi.json) e os [tipos TypeScript](contracts/generated/api.d.ts). `pnpm contracts:check` detecta diferença não registrada. Não edite artefatos gerados manualmente. Os adapters HTTP mantêm a sessão, a idempotência e os mapeamentos para os modelos de tela/domínio.

Os comandos `pnpm store:provision` e `pnpm store:recover-owner` usam uma credencial administrativa separada e variáveis obrigatórias; consulte [identidade](docs/identity-validacao.md). Nunca disponibilize essa credencial aos processos normais.

## Organização e decisões

- `backend/src/modules`: domínio e aplicação, portas e adapters de identidade, estoque, catálogo, integração, alertas e lojas.
- `backend/migrations`: SQL versionado, RLS, FKs compostas e funções restritas de pré-autenticação.
- `frontend/src/features`: painel por funcionalidade; consultas sempre associadas à loja.
- `mobile`: domínio Kotlin, rede, armazenamento cifrado, scanner, telas e composição Android.
- `infra`: execução local e arquivos de entrega; [`docs/deploy.md`](docs/deploy.md) é o passo a passo para colocar no ar (com `infra/servidor.sh`), e [`docs/operacao.md`](docs/operacao.md) descreve operação e recuperação.

Consulte o [progresso verificado](docs/progresso-implementacao.md), o [plano](docs/plano-implementacao.md) e as [regras de estoque](docs/especificacao-estoque.md). A implantação pública, assinatura release, integração com o ERP real e homologação no coletor dependem dos recursos do ambiente de destino.
