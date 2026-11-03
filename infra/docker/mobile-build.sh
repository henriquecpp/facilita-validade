#!/bin/sh
# Entrada do container de build Android (serviço `mobile` do compose.yaml).
#
# O código do host chega somente leitura em /src e é sincronizado para /work/mobile, num
# volume do Docker. Compilar direto na pasta montada do Windows é lento, e o Gradle do host
# e o do container disputariam as mesmas pastas build/ e .gradle/. Como o volume persiste
# entre execuções, a compilação seguinte é incremental. /work/contracts/fixtures vem do
# Compose: o projeto lê ../contracts/fixtures, como no repositório.
set -eu

rsync -a --delete \
  --exclude /dist/ \
  --exclude build/ \
  --exclude /.gradle/ \
  --exclude /.kotlin/ \
  --exclude /local.properties \
  /src/ /work/mobile/

cd /work/mobile
touch /tmp/started
# shellcheck disable=SC2086 # a URL não tem espaços; vazia, o argumento some.
sh ./gradlew --no-daemon --console=plain ${API_BASE_URL:+-PapiBaseUrl=$API_BASE_URL} "$@"

# Publica em /out (mobile/dist no host) só os APKs gerados nesta execução.
mkdir -p /out
apks=$(find . -path '*/build/outputs/apk/*' -name '*.apk' -newer /tmp/started)
if [ -n "$apks" ]; then
  for apk in $apks; do
    cp "$apk" /out/
    echo "APK: mobile/dist/$(basename "$apk")"
  done
fi
