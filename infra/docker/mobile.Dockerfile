# Compila e testa o aplicativo Android num container, com o mesmo JDK e os mesmos pacotes
# do SDK usados na máquina de desenvolvimento (docs/android-validacao.md). O emulador e a
# instalação no coletor ficam fora do Docker; veja docs/coletor-ct48.md.
FROM eclipse-temurin:21.0.12.1_1-jdk-noble

# Command-line tools 19.0 (pacote 13114758). O SHA-256 foi calculado sobre o arquivo depois
# de conferir tamanho e SHA-1 com o manifesto oficial do SDK
# (https://dl.google.com/android/repository/repository2-3.xml).
ARG CMDLINE_TOOLS=13114758
ARG CMDLINE_TOOLS_SHA256=7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee
ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:/opt/android-sdk/cmdline-tools/latest/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip rsync \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/cmdline-tools.zip \
      "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" \
    && echo "${CMDLINE_TOOLS_SHA256}  /tmp/cmdline-tools.zip" | sha256sum -c - \
    && mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp \
    && mv /tmp/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/cmdline-tools.zip

# O sdkmanager só instala pacotes com as licenças aceitas — o mesmo aceite feito ao
# preparar o SDK na máquina. Plataforma e build-tools são os de compileSdk e do AGP.
RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager 'platforms;android-36' 'build-tools;35.0.0'

COPY --chmod=755 mobile-build.sh /usr/local/bin/mobile-build
WORKDIR /work
ENTRYPOINT ["mobile-build"]
CMD [":app:assembleDebug"]
