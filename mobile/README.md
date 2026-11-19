# Coletor Android

Kotlin/Compose, JDK 21 e SDK Android 36. O guia completo de ambiente e homologação está em [android-validacao.md](../docs/android-validacao.md); a configuração do Firebase no servidor está em [operacao.md](../docs/operacao.md#coletor-firebase-cloud-messaging).

## Alterações da reunião de 17/10/2026

- Entrada e lançamento rápido exibem menos dicas permanentes. O campo de validade mantém máscara, calendário, erros e confirmação de datas vencidas ou distantes. Quantidade, lote opcional, observação opcional, navegação por Enter e recuperação idempotente de envios permanecem disponíveis.
- Na contagem, os campos vêm antes do histórico de linhas; a lista não empurra a próxima quantidade/validade para baixo. A confirmação ainda informa que a contagem substitui o saldo.
- Notificações por nível abrem a lista filtrada: `/expiries?nivel=<UUID>` e `/expiries?levelId=<UUID>`. `/alerts` e `/expiries` abrem todas as validades, e `/products/<UUID>` abre o produto. Um nível removido volta à lista geral. Endereços externos ou inválidos são ignorados.
- A inscrição, a navegação por notificação e a exibição de push recebido em primeiro plano exigem proprietário. As permissões e o isolamento das consultas continuam sendo verificados no servidor. A integração Firebase usa a configuração entregue pela API, sem `google-services.json` embarcado.

## Build local

Na raiz do monorepo, com `JAVA_HOME` e `ANDROID_HOME` configurados:

```powershell
.\mobile\gradlew.bat -p mobile ktlintCheck :core:domain:test :core:network:test :core:ui:testDebugUnitTest :feature:counting:testDebugUnitTest :feature:inventory:testDebugUnitTest :app:assembleDebug :app:lintDebug --no-daemon
.\mobile\gradlew.bat -p mobile :app:bundleRelease --no-daemon
```

`:app:assembleDemo` gera o APK de teste offline (`app/build/outputs/apk/demo/app-demo.apk`): as mesmas telas com uma loja na memória, sem servidor, para conferir teclado e leitor no coletor. Só o `PortsModule` muda entre os builds: `src/live` (debug e release, servidor) e `src/demo` (memória). Ver [teste de teclado sem servidor](../docs/coletor-ct48.md#teste-de-teclado-sem-servidor-apk-offline).

O segundo comando permite validar o empacotamento e a otimização release sem credenciais. Na ausência de configuração de entrega, gera um **bundle sem assinatura, com URL ilustrativa**, somente para inspeção técnica. Artefatos: `app/build/outputs/apk/debug/app-debug.apk` e `app/build/outputs/bundle/release/app-release.aab`.

## Preparação para a Play Console

A assinatura de upload é lida das seguintes variáveis de ambiente. Defina-as fora do repositório, no ambiente de build ou gerenciador de segredos:

| Variável | Conteúdo |
| --- | --- |
| `ESTOQUE_UPLOAD_KEYSTORE` | Caminho absoluto da chave de upload existente. |
| `ESTOQUE_UPLOAD_STORE_PASSWORD` | Senha do arquivo da chave. |
| `ESTOQUE_UPLOAD_KEY_ALIAS` | Alias da chave de upload. |
| `ESTOQUE_UPLOAD_KEY_PASSWORD` | Senha da chave. |

Com essas variáveis configuradas, use a URL HTTPS real e os números de versão da entrega:

```powershell
.\mobile\gradlew.bat -p mobile :app:preparePlayBundle -PapiBaseUrl=https://servidor-da-loja.example/api/v1/ -PappVersionCode=2 -PappVersionName=0.2.0 --no-daemon
```

Substitua o domínio ilustrativo: `preparePlayBundle` recusa `.example`, `.invalid`, HTTP e assinatura ausente. A tarefa gera o artefato para revisão; o envio à Play Console é manual. `bundleRelease` sozinho continua disponível para inspeção sem esses requisitos de entrega. A chave debug nunca é selecionada para o release.

Antes da entrega, ainda é necessário validar o Firebase do ambiente, com o pacote `br.com.estoque.coletor` (ou `.debug` no desenvolvimento), a conta de serviço no servidor, login de proprietário, permissão de notificações e recebimento com o app aberto e fechado. Também precisam ser conferidos no coletor real o teclado/leitor, o espaço útil dos formulários e o toque nos avisos. A compilação local não substitui essa homologação.

## Validação executada em 18/10/2026

O comando de build acima, incluindo `:app:bundleRelease`, terminou com `BUILD SUCCESSFUL`. Foram aprovados **89 testes**: domínio 27, rede 18, UI 5, inventário 25 e contagem 14, incluindo o fluxo por Enter/setas. `ktlintCheck` passou; o lint Android registrou zero erros e 28 avisos sobre versões mais recentes das dependências/ferramentas. Os lockfiles foram preservados.

- [APK debug](app/build/outputs/apk/debug/app-debug.apk): 38.391.164 bytes; assinatura e alinhamento verificados com `apksigner` e `zipalign`.
- [AAB release](app/build/outputs/bundle/release/app-release.aab): 16.589.311 bytes, otimizado com R8, **sem assinatura e com URL ilustrativa**. Não é o artefato de publicação.
- [Relatório de lint](app/build/reports/lint-results-debug.html), [inventário](feature/inventory/build/reports/tests/testDebugUnitTest/index.html) e [contagem](feature/counting/build/reports/tests/testDebugUnitTest/index.html).

O ADB não encontrou dispositivos conectados nesta validação. Não houve publicação, geração de chave de upload nem alteração da conta/configuração Firebase.
