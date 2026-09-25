package br.com.estoque.core.data

import android.content.Context
import br.com.estoque.core.domain.DevicePreferences
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.PushPort
import br.com.estoque.core.domain.SessionPort
import br.com.estoque.core.network.NetworkAdapters

class ApiGraph private constructor(
    val session: SessionPort,
    val inventory: InventoryPort,
    val preferences: DevicePreferences,
    val push: PushPort,
) {
    companion object {
        fun create(
            context: Context,
            baseUrl: String,
        ): ApiGraph {
            val network = NetworkAdapters.create(baseUrl, EncryptedVault(context.applicationContext))
            return ApiGraph(network.session, network.inventory, devicePreferences(context), network.push)
        }

        /** Preferências do aparelho sem servidor, para o APK de teste offline (build `demo`). */
        fun devicePreferences(context: Context): DevicePreferences = SharedDevicePreferences(context.applicationContext)
    }
}
