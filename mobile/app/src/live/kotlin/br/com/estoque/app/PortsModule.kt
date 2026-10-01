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

/** Debug e release: tudo pelo servidor em [BuildConfig.API_BASE_URL]. */
@Module
@InstallIn(SingletonComponent::class)
object PortsModule {
    @Provides
    @Singleton
    fun graph(
        @ApplicationContext context: Context,
    ): ApiGraph = ApiGraph.create(context, BuildConfig.API_BASE_URL)

    @Provides
    fun session(graph: ApiGraph): SessionPort = graph.session

    @Provides
    fun inventory(graph: ApiGraph): InventoryPort = graph.inventory

    @Provides
    fun preferences(graph: ApiGraph): DevicePreferences = graph.preferences

    @Provides
    fun push(graph: ApiGraph): PushPort = graph.push
}
