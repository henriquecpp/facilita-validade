#!/usr/bin/env bash
# Administração do Facilita Validade no servidor (Ubuntu com Docker). Guia: docs/deploy.md.
#
#   sudo ./infra/servidor.sh configurar            1ª vez: domínio, e-mail, Pagonet e segredos
#   sudo ./infra/servidor.sh firebase CONTA.json GOOGLE-SERVICES.json   push do coletor
#   sudo ./infra/servidor.sh instalar              1ª vez: constrói, cria o banco e sobe tudo
#   sudo ./infra/servidor.sh admin USUARIO         administrador do painel da plataforma
#   sudo ./infra/servidor.sh admin-senha USUARIO   senha provisória nova para um administrador
#   sudo ./infra/servidor.sh apk ARQUIVO.apk       publica o APK em /downloads/facilita-validade.apk
#   sudo ./infra/servidor.sh atualizar             versão nova do código, com backup antes
#   sudo ./infra/servidor.sh voltar VERSAO         volta para uma versão anterior
#   sudo ./infra/servidor.sh backup                cópia do banco em /srv/estoque/backups
#   sudo ./infra/servidor.sh segredo pagonet|smtp  troca o token da Pagonet ou a senha do e-mail
#   sudo ./infra/servidor.sh status | verificar | logs [serviço] | parar | iniciar
#   sudo ./infra/servidor.sh compose ...           qualquer comando do docker compose
#
# A configuração fica fora do repositório, em /srv/estoque (ESTOQUE_DIR troca o lugar):
# config/compose.env, secrets/ (só root entra), backups/ e downloads/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${ESTOQUE_DIR:-/srv/estoque}"
CONFIG="$BASE/config/compose.env"
SECRETS="$BASE/secrets"
BACKUPS="$BASE/backups"
DOWNLOADS="$BASE/downloads"
NODE_IMAGE=node:24.18.0-bookworm-slim
# UIDs dos containers: 1000 é a API/worker, 70 é o PostgreSQL.
APP_UID=1000
POSTGRES_UID=70
SERVICES=(api worker frontend caddy)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() {
  printf '\n\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}

compose() { docker compose --env-file "$CONFIG" -f "$ROOT/infra/compose.production.yaml" "$@"; }

need_root() { [ "$(id -u)" -eq 0 ] || die "Rode com sudo: sudo $0 $*"; }
need_docker() {
  command -v docker >/dev/null || die 'Docker não instalado. Veja docs/deploy.md, passo 4.'
  docker compose version >/dev/null 2>&1 || die 'Falta o plugin docker compose. Veja docs/deploy.md, passo 4.'
}
need_config() { [ -f "$CONFIG" ] || die "Falta $CONFIG. Rode antes: sudo $0 configurar"; }
setting() { sed -n "s/^$1=//p" "$CONFIG" | tail -n 1; }
set_setting() {
  if grep -q "^$1=" "$CONFIG"; then
    sed -i "s|^$1=.*|$1=$2|" "$CONFIG"
  else
    printf '%s=%s\n' "$1" "$2" >>"$CONFIG"
  fi
}
random_hex() { openssl rand -hex "$1"; }
new_tag() { date +v%Y%m%d-%H%M; }

# Grava um segredo só legível pelo usuário do container que o usa.
write_secret() {
  local name=$1 owner=$2 value=$3
  printf '%s' "$value" >"$SECRETS/$name"
  chown "$owner:$owner" "$SECRETS/$name"
  chmod 400 "$SECRETS/$name"
}

ask() {
  local prompt=$1 default=${2:-} answer
  if [ -n "$default" ]; then prompt="$prompt [$default]"; fi
  read -r -p "  $prompt: " answer
  printf '%s' "${answer:-$default}"
}
ask_secret() {
  local answer
  read -r -s -p "  $1: " answer
  echo >&2
  printf '%s' "$answer"
}

node_script() {
  # Roda um script de scripts/ num container Node, sem instalar Node no servidor.
  docker run --rm --network none -v "$ROOT/scripts:/scripts:ro" "$@"
}

cmd_configurar() {
  need_root configurar
  need_docker
  [ -f "$CONFIG" ] && die "$CONFIG já existe. Gerar de novo trocaria as senhas do banco já criado.
Para trocar o token da Pagonet ou a senha do e-mail: sudo $0 segredo pagonet|smtp"
  command -v openssl >/dev/null || die 'Falta o openssl: sudo apt install openssl'

  say 'Dados da instalação'
  local domain email smtp_password pagonet contact
  domain=$(ask 'Domínio do sistema (ex.: validade.suaempresa.com.br)')
  domain=${domain#https://}
  domain=${domain#http://}
  domain=${domain%%/*}
  [[ $domain =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "Domínio inválido: $domain"
  email=$(ask 'E-mail (Gmail) que envia os alertas')
  [[ $email == *@*.* ]] || die "E-mail inválido: $email"
  smtp_password=$(ask_secret 'Senha de app do Gmail (16 letras; não aparece ao digitar)')
  smtp_password=${smtp_password// /}
  [ -n "$smtp_password" ] || die 'A senha de app do Gmail é obrigatória.'
  pagonet=$(ask_secret 'Token da Bridge da Pagonet (não aparece ao digitar)')
  [ -n "$pagonet" ] || die 'O token da Pagonet é obrigatório.'
  contact=$(ask 'E-mail de contato para os serviços de push' "$email")

  say 'Gerando senhas e chaves'
  umask 077
  mkdir -p "$BASE/config" "$SECRETS" "$BACKUPS" "$DOWNLOADS"
  chmod 700 "$BASE/config" "$SECRETS" "$BACKUPS"
  chmod 755 "$BASE" "$DOWNLOADS"
  local postgres runtime auth
  postgres=$(random_hex 24)
  runtime=$(random_hex 24)
  auth=$(random_hex 24)
  write_secret postgres-password "$POSTGRES_UID" "$postgres"
  write_secret database-url "$APP_UID" "postgresql://app_runtime:$runtime@postgres:5432/estoque"
  write_secret auth-database-url "$APP_UID" "postgresql://app_auth:$auth@postgres:5432/estoque"
  write_secret migration-database-url "$APP_UID" "postgresql://postgres:$postgres@postgres:5432/estoque"
  write_secret jwt-secret "$APP_UID" "$(random_hex 32)"
  write_secret smtp-password "$APP_UID" "$smtp_password"
  write_secret pagonet-token "$APP_UID" "$pagonet"
  ok "segredos em $SECRETS"

  local vapid
  vapid=$(node_script "$NODE_IMAGE" node /scripts/web-push-keys.mjs) || die 'Não foi possível gerar as chaves do push.'
  cat >"$CONFIG" <<EOF
# Facilita Validade em produção. Gerado por infra/servidor.sh em $(date '+%d/%m/%Y %H:%M').
# Não versione nem compartilhe este arquivo. Guia: docs/deploy.md.
RELEASE_TAG=$(new_tag)
WEB_ORIGIN=https://$domain
DOWNLOADS_DIR=$DOWNLOADS
POSTGRES_PASSWORD_FILE=$SECRETS/postgres-password
DATABASE_URL_FILE=$SECRETS/database-url
AUTH_DATABASE_URL_FILE=$SECRETS/auth-database-url
MIGRATION_DATABASE_URL_FILE=$SECRETS/migration-database-url
JWT_SECRET_FILE=$SECRETS/jwt-secret
PAGONET_TOKEN_FILE=$SECRETS/pagonet-token
SMTP_USER=$email
SMTP_FROM=Facilita Validade <$email>
SMTP_PASSWORD_FILE=$SECRETS/smtp-password
# Push do painel (PWA). Trocar as chaves obriga cada navegador a ativar de novo.
$(printf '%s\n' "$vapid" | grep -E '^WEB_PUSH_(PUBLIC|PRIVATE)_KEY=')
WEB_PUSH_SUBJECT=mailto:$contact
# Push do coletor (Firebase): sudo infra/servidor.sh firebase CONTA.json GOOGLE-SERVICES.json
EOF
  chmod 600 "$CONFIG"
  compose config --quiet || die 'A configuração gerada não passou na conferência do Compose.'
  ok "configuração em $CONFIG"

  say 'Pronto. Próximos passos'
  echo "  1. (opcional) push do coletor: sudo $0 firebase CONTA.json GOOGLE-SERVICES.json"
  echo "  2. sudo $0 instalar"
}

cmd_firebase() {
  need_root firebase
  need_docker
  need_config
  local account=${1:-} services=${2:-}
  if [ ! -f "$account" ] || [ ! -f "$services" ]; then
    die "Uso: sudo $0 firebase CONTA-DE-SERVICO.json google-services.json"
  fi
  local dir
  dir=$(mktemp -d)
  cp "$account" "$dir/account.json"
  cp "$services" "$dir/google-services.json"
  cp "$CONFIG" "$dir/compose.env"
  node_script -v "$dir:/work" "$NODE_IMAGE" node /scripts/fcm-service-account.mjs \
    /work/account.json /work/compose.env --google-services /work/google-services.json ||
    {
      rm -rf "$dir"
      die 'Não foi possível ler os arquivos do Firebase.'
    }
  cat "$dir/compose.env" >"$CONFIG"
  rm -rf "$dir"
  ok 'push do coletor configurado'
  if compose ps --services --status running 2>/dev/null | grep -qx api; then
    compose up -d --no-build --force-recreate --no-deps api worker
    ok 'API e worker reiniciados'
  fi
  echo "  Apague do servidor os dois arquivos baixados: rm $account $services"
}

cmd_instalar() {
  need_root instalar
  need_docker
  need_config
  local domain
  domain=$(setting WEB_ORIGIN)
  domain=${domain#https://}
  say "Conferindo o domínio $domain"
  if getent ahostsv4 "$domain" >/dev/null; then
    ok "$domain aponta para $(getent ahostsv4 "$domain" | awk 'NR==1{print $1}'): confira se é o IP deste servidor"
  else
    echo "  Aviso: $domain ainda não resolve. O HTTPS só sai depois que o DNS apontar para cá."
  fi

  say 'Construindo as imagens (alguns minutos na primeira vez)'
  compose build api frontend
  say 'Banco de dados'
  compose up -d --wait postgres
  compose run --rm migrate
  compose run --rm bootstrap-roles
  say 'Subindo API, worker, painel e HTTPS'
  compose up -d --no-build --wait "${SERVICES[@]}"
  cmd_verificar
  say 'Instalação concluída'
  echo "  Crie o administrador da plataforma: sudo $0 admin SEU-USUARIO"
}

# create: administrador novo; reset: senha provisória nova (e reativa quem estava desativado).
cmd_admin() {
  local action=$1 username=${2:-}
  need_root admin
  need_config
  [ -n "$username" ] || die "Uso: sudo $0 admin|admin-senha USUARIO"
  local password file
  password=$(random_hex 10)
  file=$(mktemp "$SECRETS/initial-password.XXXXXX")
  # shellcheck disable=SC2064 # o caminho é expandido agora, enquanto a variável existe
  trap "rm -f '$file'" EXIT
  printf '%s' "$password" >"$file"
  chown "$APP_UID:$APP_UID" "$file"
  chmod 400 "$file"
  compose run --rm \
    -e PLATFORM_ADMIN_USERNAME="$username" \
    -e PLATFORM_OPERATOR="${SUDO_USER:-root} pelo servidor.sh" \
    -e PLATFORM_ADMIN_TEMPORARY_PASSWORD_FILE=/run/secrets/initial_password \
    -v "$file:/run/secrets/initial_password:ro" \
    migrate dist/bootstrap/platform-admin.js "$action"
  if [ "$action" = create ]; then say 'Administrador criado'; else say 'Senha provisória nova'; fi
  echo "  Endereço:          $(setting WEB_ORIGIN)/platform"
  echo "  Usuário:           $username"
  echo "  Senha provisória:  $password"
  echo '  Anote agora: ela não aparece de novo e é trocada no primeiro acesso.'
}

cmd_apk() {
  need_root apk
  need_config
  local apk=${1:-}
  [ -f "$apk" ] || die "Uso: sudo $0 apk ARQUIVO.apk"
  install -m 644 "$apk" "$(setting DOWNLOADS_DIR)/facilita-validade.apk"
  ok "no coletor, abra $(setting WEB_ORIGIN)/downloads/facilita-validade.apk"
}

cmd_backup() {
  need_root backup
  need_config
  mkdir -p "$BACKUPS"
  chmod 700 "$BACKUPS"
  local file partial
  file="$BACKUPS/estoque-$(date +%Y%m%d-%H%M%S).dump"
  partial="$file.parcial"
  umask 077
  compose exec -T postgres pg_dump -U postgres -d estoque --format=custom >"$partial" ||
    {
      rm -f "$partial"
      die 'O backup falhou. Nada foi apagado.'
    }
  mv "$partial" "$file"
  (cd "$BACKUPS" && sha256sum "$(basename "$file")" >"$(basename "$file").sha256")
  local days
  days=$(setting BACKUP_RETENTION_DAYS)
  find "$BACKUPS" -name 'estoque-*.dump*' -mtime +"${days:-14}" -delete
  ok "backup: $file ($(du -h "$file" | cut -f1)); mantidos os últimos ${days:-14} dias"
}

cmd_atualizar() {
  need_root atualizar
  need_docker
  need_config
  if [ -d "$ROOT/.git" ]; then
    say 'Baixando a versão nova do código'
    git -C "$ROOT" pull --ff-only
  fi
  local previous tag
  previous=$(setting RELEASE_TAG)
  tag=$(new_tag)
  say "Construindo a versão $tag"
  set_setting RELEASE_TAG "$tag"
  if ! compose build api frontend; then
    set_setting RELEASE_TAG "$previous"
    die "A construção falhou; continua no ar a versão $previous."
  fi
  say 'Backup antes de mexer no banco'
  cmd_backup
  say 'Atualizando o banco e subindo a versão nova'
  compose run --rm migrate
  compose up -d --no-build --wait "${SERVICES[@]}"
  cmd_verificar
  say "Versão $tag no ar"
  echo "  Se algo der errado: sudo $0 voltar $previous"
}

cmd_voltar() {
  need_root voltar
  need_config
  local tag=${1:-}
  [ -n "$tag" ] || die "Uso: sudo $0 voltar VERSAO (as versões aparecem em: docker images controle-estoque-backend)"
  docker image inspect "controle-estoque-backend:$tag" >/dev/null 2>&1 || die "Não há a versão $tag neste servidor."
  set_setting RELEASE_TAG "$tag"
  compose up -d --no-build --wait "${SERVICES[@]}"
  ok "versão $tag no ar. Atenção: o banco não volta; só o código."
}

cmd_segredo() {
  need_root segredo
  need_config
  local value file label
  case ${1:-} in
    pagonet) file=pagonet-token label='Token novo da Bridge da Pagonet' ;;
    smtp) file=smtp-password label='Senha de app nova do Gmail' ;;
    *) die "Uso: sudo $0 segredo pagonet|smtp" ;;
  esac
  value=$(ask_secret "$label (não aparece ao digitar)")
  [ -n "$value" ] || die 'Nada foi alterado.'
  if [ "$file" = smtp-password ]; then value=${value// /}; fi
  umask 077
  write_secret "$file" "$APP_UID" "$value"
  compose up -d --no-build --force-recreate --no-deps api worker
  ok 'trocado; API e worker reiniciados'
}

cmd_verificar() {
  need_config
  local origin
  origin=$(setting WEB_ORIGIN)
  say "Conferindo $origin"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "$origin/api/v1/health/ready" >/dev/null 2>&1; then
      ok 'HTTPS, painel, API e banco respondendo'
      return 0
    fi
    sleep 5
  done
  echo '  Ainda sem resposta pelo domínio. Causas comuns: DNS ainda não aponta para este servidor,'
  echo '  portas 80/443 fechadas no provedor, ou certificado em emissão. Veja:'
  echo "  sudo $0 logs caddy"
  return 1
}

main() {
  local command=${1:-}
  shift || true
  case $command in
    configurar) cmd_configurar "$@" ;;
    firebase) cmd_firebase "$@" ;;
    instalar) cmd_instalar "$@" ;;
    admin) cmd_admin create "$@" ;;
    admin-senha) cmd_admin reset "$@" ;;
    apk) cmd_apk "$@" ;;
    atualizar) cmd_atualizar "$@" ;;
    voltar) cmd_voltar "$@" ;;
    backup) cmd_backup "$@" ;;
    segredo) cmd_segredo "$@" ;;
    verificar) cmd_verificar "$@" ;;
    status)
      need_config
      compose ps
      ;;
    logs)
      need_config
      compose logs --tail=200 -f "$@"
      ;;
    parar)
      need_root parar
      need_config
      compose stop
      ;;
    iniciar)
      need_root iniciar
      need_config
      compose up -d --no-build --wait "${SERVICES[@]}"
      ;;
    compose)
      need_config
      compose "$@"
      ;;
    # Sem comando: mostra o cabeçalho deste arquivo.
    *) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0" ;;
  esac
}

main "$@"
