plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ktlint)
}
kotlin { jvmToolchain(21) }
dependencies {
    implementation(project(":core:domain"))
    implementation(libs.coroutines.core)
    implementation(libs.serialization.json)
    implementation(libs.retrofit)
    implementation(libs.retrofit.serialization)
    implementation(libs.okhttp)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.mockwebserver)
}
