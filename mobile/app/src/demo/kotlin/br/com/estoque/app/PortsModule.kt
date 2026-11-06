package br.com.estoque.app

import android.content.Context
import br.com.estoque.core.data.ApiGraph
import br.com.estoque.core.domain.DevicePreferences
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.PushPort
import br.com.estoque.core.domain.SessionPort
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * APK de teste offline: as telas de verdade com uma loja de mentira na memória, sem servidor.
 * Serve para conferir teclado, leitor e foco no coletor; nada sai do aparelho.
 */
@Module
@InstallIn(SingletonComponent::class)
object PortsModule {
    @Provides
    @Singleton
    fun store(): DemoStore = DemoStore()

    @Provides
    fun session(store: DemoStore): SessionPort = store.session

    @Provides
    fun inventory(store: DemoStore): InventoryPort = store.inventory

    @Provides
    @Singleton
    fun preferences(
        @ApplicationContext context: Context,
    ): DevicePreferences = ApiGraph.devicePreferences(context)

    @Provides
    fun push(store: DemoStore): PushPort = store.push
}
