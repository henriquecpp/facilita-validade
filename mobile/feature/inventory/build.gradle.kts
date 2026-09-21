plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ktlint)
    alias(libs.plugins.kotlin.compose)
}
android {
    namespace = "br.com.estoque.feature.inventory"
    compileSdk = 36
    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures { compose = true }
    testOptions { unitTests { isIncludeAndroidResources = true } }
}
kotlin { jvmToolchain(21) }
dependencies {
    implementation(project(":core:domain"))
    implementation(project(":core:ui"))
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    implementation(libs.coroutines.android)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    testImplementation(testFixtures(project(":core:domain")))
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test)
    debugImplementation(libs.compose.test.manifest)
}
