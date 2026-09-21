import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
    alias(libs.plugins.ktlint)
}
val apiUrl = providers.gradleProperty("apiBaseUrl").orElse("https://configure-seu-servidor.invalid/api/v1/")
val releaseSigningVariables =
    listOf("ESTOQUE_UPLOAD_KEYSTORE", "ESTOQUE_UPLOAD_STORE_PASSWORD", "ESTOQUE_UPLOAD_KEY_ALIAS", "ESTOQUE_UPLOAD_KEY_PASSWORD")
val releaseSigning = releaseSigningVariables.associateWith { providers.environmentVariable(it).orNull }
val hasReleaseSigning = releaseSigning.values.all { !it.isNullOrBlank() }
android {
    namespace = "br.com.estoque.app"
    compileSdk = 36
    defaultConfig {
        applicationId = "br.com.estoque.coletor"
        minSdk = 23
        targetSdk = 36
        versionCode =
            providers
                .gradleProperty("appVersionCode")
                .orElse("1")
                .get()
                .toInt()
        versionName = providers.gradleProperty("appVersionName").orElse("0.1.0").get()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "API_BASE_URL", "\"${apiUrl.get()}\"")
    }
    signingConfigs {
        // Chave de debug do projeto, versionada: o APK de debug sai com a mesma assinatura
        // no host, no container (serviço mobile do compose.yaml) e na CI, e um atualiza o
        // outro sem desinstalar. Assina só debug, com a senha pública do Android; o release
        // tem assinatura própria, fora do repositório.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (hasReleaseSigning) {
            create("upload") {
                storeFile = file(releaseSigning.getValue("ESTOQUE_UPLOAD_KEYSTORE")!!)
                storePassword = releaseSigning.getValue("ESTOQUE_UPLOAD_STORE_PASSWORD")
                keyAlias = releaseSigning.getValue("ESTOQUE_UPLOAD_KEY_ALIAS")
                keyPassword = releaseSigning.getValue("ESTOQUE_UPLOAD_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            buildConfigField(
                "String",
                "API_BASE_URL",
                "\"${providers.gradleProperty("apiBaseUrl").orElse("http://10.0.2.2:3001/api/v1/").get()}\"",
            )
        }
        release {
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("upload")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        // APK de teste offline (`:app:assembleDemo`): as telas de verdade com uma loja na memória,
        // para conferir teclado e leitor no coletor sem servidor. Instala ao lado dos outros.
        create("demo") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".demo"
            versionNameSuffix = "-teste"
            matchingFallbacks += listOf("debug")
            resValue("string", "app_name", "Validade (teste)")
        }
    }
    // Só o PortsModule muda por build: servidor em debug e release (src/live), memória no demo.
    sourceSets {
        getByName("debug").kotlin.srcDir("src/live/kotlin")
        getByName("release").kotlin.srcDir("src/live/kotlin")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}
// O bundle comum também permite inspeção local sem assinatura. A tarefa de entrega exige a
// configuração real e usa exclusivamente a chave de upload externa, nunca a chave de debug.
val verifyPlayRelease =
    tasks.register("verifyPlayRelease") {
        group = "verification"
        description = "Confere URL HTTPS e assinatura externa antes de preparar um bundle para entrega."
        doLast {
            val uri = runCatching { URI(apiUrl.get()) }.getOrNull()
            check(
                uri?.scheme == "https" &&
                    !uri.host.isNullOrBlank() &&
                    !uri.host.endsWith(".invalid") &&
                    !uri.host.endsWith(".example") &&
                    uri.userInfo == null &&
                    uri.query == null &&
                    uri.fragment == null &&
                    uri.path.endsWith("/api/v1/"),
            ) { "Informe -PapiBaseUrl=https://seu-servidor/api/v1/ com a URL real do ambiente." }
            check(hasReleaseSigning) {
                "Configure a assinatura de upload fora do repositório: ${releaseSigningVariables.joinToString(", ")}."
            }
            check(file(releaseSigning.getValue("ESTOQUE_UPLOAD_KEYSTORE")!!).isFile) { "Arquivo da chave de upload não encontrado." }
        }
    }
tasks.matching { it.name == "bundleRelease" || it.name == "assembleRelease" }.configureEach { mustRunAfter(verifyPlayRelease) }
// APK assinado para instalar direto nos coletores, sem a Play Store (docs/deploy.md).
tasks.register("prepareReleaseApk") {
    group = "build"
    description = "Gera o APK de release assinado, com a URL real do servidor, para instalar nos coletores."
    dependsOn(verifyPlayRelease, "assembleRelease")
}
tasks.register("preparePlayBundle") {
    group = "build"
    description = "Gera o bundle de release assinado para revisão e envio manual à Play Console."
    dependsOn(verifyPlayRelease, "bundleRelease")
}
kotlin { jvmToolchain(21) }
dependencies {
    implementation(project(":core:domain"))
    implementation(project(":core:data"))
    implementation(project(":core:scanner"))
    implementation(project(":core:ui"))
    implementation(project(":feature:auth"))
    implementation(project(":feature:inventory"))
    implementation(project(":feature:counting"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.coroutines.android)
    // Push do proprietário (AV25). Sem google-services: o app inicia o Firebase com a
    // configuração que o servidor entrega, e um servidor sem Firebase deixa o push desligado.
    implementation(libs.firebase.messaging)
    debugImplementation(libs.compose.tooling)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test)
    debugImplementation(libs.compose.test.manifest)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
}
