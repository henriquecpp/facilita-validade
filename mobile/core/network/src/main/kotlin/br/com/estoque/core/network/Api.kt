package br.com.estoque.core.network

import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.Session
import br.com.estoque.core.domain.SessionPort
import br.com.estoque.core.domain.Store
import br.com.estoque.core.domain.User
import br.com.estoque.core.network.generated.ApiMobileSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Url
import java.io.IOException

internal val json = Json { ignoreUnknownKeys = true }

internal interface Api {
    @GET suspend fun get(
        @Url path: String,
        @Header("Authorization") authorization: String? = null,
    ): Response<JsonElement>

    @POST suspend fun post(
        @Url path: String,
        @Header("Authorization") authorization: String? = null,
        @Header("Idempotency-Key") key: String? = null,
        @Body body: JsonObject,
    ): Response<JsonElement>

    @PUT suspend fun put(
        @Url path: String,
        @Header("Authorization") authorization: String? = null,
        @Header("Idempotency-Key") key: String? = null,
        @Body body: JsonObject,
    ): Response<JsonElement>
}

internal fun JsonObject.string(
    name: String,
    default: String = "",
): String = this[name]?.jsonPrimitive?.contentOrNull ?: default

internal inline fun <reified T> JsonObject.decodeContract(): T =
    try {
        json.decodeFromJsonElement<T>(this)
    } catch (_: SerializationException) {
        throw AppFailure("Resposta incompatível com o contrato da API. Atualize o aplicativo ou contate o suporte.")
    }

internal fun Long.checkedInt(): Int {
    if (this !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) {
        throw AppFailure("A quantidade ou versão recebida ultrapassa o limite suportado pelo aplicativo.")
    }
    return toInt()
}

internal fun Response<JsonElement>.payload(): JsonObject {
    if (!isSuccessful) {
        val error = runCatching { json.parseToJsonElement(errorBody()?.string() ?: "{}").jsonObject }.getOrNull()
        val fallback =
            when (code()) {
                401 -> "Sessão expirada. Entre novamente."
                403 -> "Seu perfil não permite esta ação."
                404 -> "Registro não encontrado. Confirme o código ou consulte o gestor."
                409 -> "Os dados mudaram ou há uma contagem ativa. Atualize antes de continuar."
                429 -> "Muitas tentativas. Aguarde e tente novamente."
                else -> "Servidor indisponível (HTTP ${code()}). Tente novamente."
            }
        val message = (error?.get("message") as? JsonPrimitive)?.contentOrNull ?: fallback
        throw AppFailure(message, uncertain = code() >= 500, statusCode = code())
    }
    return body() as? JsonObject ?: buildJsonObject { }
}

internal class ApiSession(
    private val api: Api,
    private val vault: SecretVault,
) : SessionPort {
    private val mutable = MutableStateFlow<Session?>(null)
    override val session: StateFlow<Session?> = mutable
    private val refreshMutex = Mutex()

    @Volatile private var accessToken: String? = null

    @Volatile private var endReason: String? = null

    override val lastEndReason: String? get() = endReason

    @Volatile private var generation: Long = 0

    private data class Access(
        val token: String,
        val generation: Long,
    )

    private fun requireGeneration(expected: Long) {
        if (generation != expected) {
            throw AppFailure("A sessão mudou durante a operação. Entre na loja original para consultar o resultado.", uncertain = true)
        }
    }

    override suspend fun restore() {
        if (withContext(Dispatchers.IO) { vault.read("refresh") } != null) refresh(null)
    }

    override suspend fun hasStoredSession(): Boolean =
        withContext(Dispatchers.IO) { runCatching { vault.read("refresh") != null }.getOrDefault(false) }

    override suspend fun login(
        cnpj: String,
        username: String,
        password: String,
    ) {
        refreshMutex.withLock {
            val data =
                api
                    .post(
                        "auth/mobile/login",
                        body =
                            buildJsonObject {
                                put("cnpj", cnpj)
                                put("username", username)
                                put("password", password)
                            },
                    ).payload()
                    .decodeContract<ApiMobileSession>()
            accept(data, newLogin = true)
        }
    }

    override suspend fun pair(code: String) {
        // Mesmo tratamento do login: a resposta é a mesma sessão mobile, e o mutex
        // impede que um refresh em andamento sobrescreva a sessão recém-criada.
        refreshMutex.withLock {
            val data =
                api
                    .post("auth/mobile/pair", body = buildJsonObject { put("code", code) })
                    .payload()
                    .decodeContract<ApiMobileSession>()
            accept(data, newLogin = true)
        }
    }

    private suspend fun accept(
        data: ApiMobileSession,
        newLogin: Boolean = false,
    ) {
        val restricted = data.mustChangePassword ?: false
        if (data.accessToken.isBlank() ||
            data.user.storeId != data.store.id ||
            (!restricted && data.refreshToken.isNullOrBlank())
        ) {
            throw AppFailure("Resposta de autenticação inválida. Entre novamente ou contate o suporte.")
        }
        withContext(Dispatchers.IO) {
            if (restricted) vault.remove("refresh") else vault.write("refresh", checkNotNull(data.refreshToken))
        }
        if (newLogin) generation += 1
        endReason = null
        accessToken = data.accessToken
        mutable.value =
            Session(
                Store(data.store.id, data.store.name, data.store.cnpj),
                User(data.user.id, data.user.username, data.user.role.name),
                restricted,
            )
    }

    private suspend fun refresh(
        failedToken: String?,
        expectedGeneration: Long? = null,
    ) {
        refreshMutex.withLock {
            expectedGeneration?.let(::requireGeneration)
            if (failedToken == null && accessToken != null) return
            if (failedToken != null && accessToken != null && accessToken != failedToken) return
            val token = withContext(Dispatchers.IO) { vault.read("refresh") } ?: throw AppFailure("Entre para continuar.")
            val response = api.post("auth/mobile/refresh", body = buildJsonObject { put("refreshToken", token) })
            if (response.code() == 401) {
                // O servidor diz o motivo: sessão vencida ou aparelho desconectado pelo administrador.
                val reason = serverMessage(response) ?: "Sua sessão expirou. Entre novamente."
                clear(reason)
                throw AppFailure(reason)
            }
            accept(response.payload().decodeContract<ApiMobileSession>())
        }
    }

    suspend fun call(
        expectedOwner: String? = null,
        block: suspend (String) -> Response<JsonElement>,
    ): JsonObject {
        val current =
            refreshMutex.withLock {
                val identity = mutable.value
                val actualOwner = identity?.let { "pending:${it.store.id}:${it.user.id}" }
                if (expectedOwner != null && expectedOwner != actualOwner) {
                    throw AppFailure("Entre na loja e no usuário originais para recuperar este comando.", uncertain = true)
                }
                Access(accessToken ?: throw AppFailure("Entre para continuar."), generation)
            }
        val response = block("Bearer ${current.token}")
        requireGeneration(current.generation)
        if (response.code() != 401) return response.payload()
        response.errorBody()?.close()
        refresh(current.token, current.generation)
        val retryToken =
            refreshMutex.withLock {
                requireGeneration(current.generation)
                accessToken ?: throw AppFailure("Sessão encerrada.")
            }
        val retried = block("Bearer $retryToken")
        requireGeneration(current.generation)
        return retried.payload()
    }

    private suspend fun clear(reason: String? = null) {
        generation += 1
        accessToken = null
        endReason = reason
        mutable.value = null
        withContext(Dispatchers.IO) { vault.remove("refresh") }
    }

    override suspend fun changePassword(
        currentPassword: String,
        newPassword: String,
    ) {
        val currentGeneration = refreshMutex.withLock { generation }
        call {
            requireGeneration(currentGeneration)
            api.post(
                "auth/change-password",
                it,
                body =
                    buildJsonObject {
                        put("currentPassword", currentPassword)
                        put("newPassword", newPassword)
                    },
            )
        }
        refreshMutex.withLock {
            if (generation == currentGeneration) clear()
        }
    }

    override suspend fun logout() =
        refreshMutex.withLock {
            try {
                val token = withContext(Dispatchers.IO) { vault.read("refresh") }
                if (token != null ||
                    accessToken != null
                ) {
                    api
                        .post(
                            "auth/mobile/logout",
                            accessToken?.let {
                                "Bearer $it"
                            },
                            body = buildJsonObject { token?.let { put("refreshToken", it) } },
                        ).payload()
                }
            } finally {
                clear()
            }
        }
}

/** Mensagem do erro estruturado da API, quando há. */
private fun serverMessage(response: Response<JsonElement>): String? =
    runCatching {
        (json.parseToJsonElement(response.errorBody()?.string() ?: "{}").jsonObject["message"] as? JsonPrimitive)?.contentOrNull
    }.getOrNull()?.takeIf { it.isNotBlank() }

internal suspend fun <T> readableNetwork(block: suspend () -> T): T =
    try {
        block()
    } catch (cancel: CancellationException) {
        throw cancel
    } catch (_: IOException) {
        throw AppFailure("Sem conexão. Verifique a rede e tente novamente.")
    }
