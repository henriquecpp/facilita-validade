plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ktlint)
    alias(libs.plugins.kotlin.serialization)
}
android {
    namespace = "br.com.estoque.core.data"
    compileSdk = 36
    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}
kotlin { jvmToolchain(21) }
dependencies {
    implementation(project(":core:domain"))
    implementation(project(":core:network"))
    implementation(libs.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    implementation(libs.serialization.json)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    testImplementation(libs.mockwebserver)
}
