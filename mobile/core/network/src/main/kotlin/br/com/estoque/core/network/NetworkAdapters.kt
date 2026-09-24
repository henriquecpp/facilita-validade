package br.com.estoque.core.network

import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.PushPort
import br.com.estoque.core.domain.SessionPort
import okhttp3.ConnectionPool
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

interface SecretVault {
    fun read(name: String): String?

    fun write(
        name: String,
        value: String,
    )

    fun remove(name: String)
}

/**
 * O OkHttp tenta de novo, sozinho, quando a conexão cai: troca a conexão parada que o servidor ou
 * a rede da loja já fecharam (era a "falha de conexão" ao trocar de tela e ler de novo, B01) e
 * tenta o outro endereço do servidor quando um não responde. Repetir uma requisição já enviada só
 * é seguro na leitura e no comando com chave idempotente, que o servidor não aplica duas vezes.
 * Login, renovação e troca de senha vão marcados como envio único: se caírem depois de enviados,
 * não repetem — repetir a renovação gastaria o token duas vezes.
 */
internal class OneShotUnlessIdempotent : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val body = request.body
        if (body == null || request.header("Idempotency-Key") != null) return chain.proceed(request)
        val once =
            object : RequestBody() {
                override fun contentType(): MediaType? = body.contentType()

                override fun contentLength(): Long = body.contentLength()

                override fun isOneShot(): Boolean = true

                override fun writeTo(sink: BufferedSink) = body.writeTo(sink)
            }
        return chain.proceed(request.newBuilder().method(request.method, once).build())
    }
}

class NetworkAdapters private constructor(
    val session: SessionPort,
    val inventory: InventoryPort,
    val push: PushPort,
) {
    companion object {
        /**
         * Conexão parada há mais que isso não é reaproveitada: o proxy e o servidor fecham a deles
         * em pouco mais de um minuto, e redes de loja derrubam antes, às vezes sem avisar.
         */
        private const val IDLE_SECONDS = 20L

        fun create(
            baseUrl: String,
            vault: SecretVault,
        ): NetworkAdapters {
            require(baseUrl.endsWith("/")) { "API_BASE_URL deve terminar com /." }
            val client =
                OkHttpClient
                    .Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(30, TimeUnit.SECONDS)
                    .callTimeout(45, TimeUnit.SECONDS)
                    .connectionPool(ConnectionPool(5, IDLE_SECONDS, TimeUnit.SECONDS))
                    .retryOnConnectionFailure(true)
                    .addInterceptor(OneShotUnlessIdempotent())
                    .build()
            val api =
                Retrofit
                    .Builder()
                    .baseUrl(baseUrl)
                    .client(client)
                    .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                    .build()
                    .create(Api::class.java)
            val session = ApiSession(api, vault)
            return NetworkAdapters(session, ApiInventory(api, session, vault), ApiPush(api, session))
        }
    }
}
