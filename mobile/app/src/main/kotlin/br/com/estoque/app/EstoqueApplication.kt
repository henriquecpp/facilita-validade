package br.com.estoque.app

import android.app.Application
import android.content.Context
import br.com.estoque.core.domain.DevicePreferences
import br.com.estoque.core.domain.DeviceScanner
import br.com.estoque.core.domain.PushPort
import br.com.estoque.core.scanner.BroadcastDeviceScanner
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.HiltAndroidApp
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@HiltAndroidApp
class EstoqueApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        createAlertsChannel(this)
    }
}

/**
 * Sessão, estoque, preferências e push vêm de `PortsModule`, que muda por build: debug e release
 * falam com o servidor (`src/live`); o build `demo` guarda tudo na memória (`src/demo`).
 */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides
    @Singleton
    fun pushRegistrar(
        @ApplicationContext context: Context,
        push: PushPort,
    ): PushRegistrar = PushRegistrar(context, push)

    /**
     * Adapter do leitor do aparelho. Para um coletor com SDK próprio, implemente [DeviceScanner]
     * em `core:scanner` e escolha-o aqui; as telas não mudam.
     */
    @Provides
    @Singleton
    fun scanner(
        @ApplicationContext context: Context,
        preferences: DevicePreferences,
    ): DeviceScanner = BroadcastDeviceScanner(context) { preferences.scannerSettings() }
}
