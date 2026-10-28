package br.com.estoque.core.network

import br.com.estoque.core.domain.PushPort
import br.com.estoque.core.domain.PushSettings
import br.com.estoque.core.network.generated.ApiPushConfig
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Inscrição do coletor no push do proprietário (Firebase Cloud Messaging). O servidor guarda o
 * token do aparelho junto da sessão: sair encerra o envio.
 */
internal class ApiPush(
    private val api: Api,
    private val session: ApiSession,
) : PushPort {
    override suspend fun settings(): PushSettings {
        val data = readableNetwork { session.call { api.get("push/config", it) } }.decodeContract<ApiPushConfig>()
        return PushSettings(data.allowed, data.fcmProjectId, data.fcmAppId, data.fcmApiKey, data.fcmSenderId)
    }

    override suspend fun register(token: String) {
        readableNetwork {
            session.call {
                api.post(
                    "push/subscriptions",
                    it,
                    body =
                        buildJsonObject {
                            put("kind", "FCM")
                            put("endpoint", token)
                        },
                )
            }
        }
    }

    override suspend fun unregister(token: String) {
        readableNetwork {
            session.call { api.post("push/subscriptions/remove", it, body = buildJsonObject { put("endpoint", token) }) }
        }
    }
}
