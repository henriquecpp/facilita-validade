pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = "ControleEstoque"
include(":app", ":core:domain", ":core:data", ":core:scanner", ":feature:auth", ":feature:inventory", ":feature:counting")

include(":core:network")
include(":core:ui")
