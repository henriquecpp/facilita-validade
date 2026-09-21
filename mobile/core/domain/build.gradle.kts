plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktlint)
    `java-test-fixtures`
}
kotlin { jvmToolchain(21) }
dependencies {
    implementation(libs.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.serialization.json)
    testFixturesImplementation(libs.coroutines.core)
}
tasks.test {
    // Casos compartilhados com o painel web: as duas implementações precisam concordar.
    val fixtures = rootProject.file("../contracts/fixtures")
    inputs.dir(fixtures).withPropertyName("sharedFixtures").withPathSensitivity(PathSensitivity.RELATIVE)
    systemProperty("fixtures.dir", fixtures.absolutePath)
}
