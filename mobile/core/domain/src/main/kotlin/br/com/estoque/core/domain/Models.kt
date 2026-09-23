package br.com.estoque.core.domain

import kotlinx.coroutines.flow.StateFlow

data class Store(
    val id: String,
    val name: String,
    val cnpj: String,
)

data class User(
    val id: String,
    val username: String,
    val role: String,
) {
    /** Só o proprietário recebe as notificações push da loja. */
    val owner: Boolean get() = role == "OWNER"
}

data class Session(
    val store: Store,
    val user: User,
    val mustChangePassword: Boolean = false,
)

data class Product(
    val id: String,
    val description: String,
    val active: Boolean,
    val photoUrl: String? = null,
)

/**
 * Um lote com saldo: o lançado, o que as vendas e as baixas manuais tiraram dele e o saldo.
 * Data, hora e usuário do lançamento vêm do servidor (AV01, AV22).
 */
data class StockRecord(
    val id: String,
    val expiresOn: String,
    val lotCode: String?,
    val quantity: Int,
    val launchedQuantity: Int = quantity,
    val soldQuantity: Int = 0,
    val writtenOffQuantity: Int = 0,
    val version: Int = 1,
    /** Instante UTC do lançamento; as vendas só saem do lote depois dele. */
    val launchedAt: String? = null,
    val launchedBy: String? = null,
    /** COUNT (contagem), APP_RECEIPT (entrada) ou RETURN_RECEIPT (devolução). */
    val origin: String? = null,
    val note: String? = null,
    val level: UrgencyLevel? = null,
)

data class Inventory(
    val product: Product,
    val trackingStatus: String,
    val records: List<StockRecord>,
    val totalQuantity: Long,
    val stale: Boolean,
    val lastCountAt: String? = null,
    val projectedAt: String? = null,
    /** Unidades movimentadas enquanto a última contagem estava aberta: maior diferença possível. */
    val countWindowQuantity: Long = 0,
) {
    val tracked: Boolean get() = trackingStatus == "TRACKED"
}

/**
 * Nível de urgência definido pela loja no painel (AV32): nome, cor `#rrggbb` e faixa de dias até
 * vencer. Sem [id], é a faixa dos lotes fora de todos os níveis.
 */
data class UrgencyLevel(
    val id: String?,
    val name: String,
    val color: String,
    val minDays: Int? = null,
    val maxDays: Int? = null,
    val notify: Boolean = false,
) {
    /** A faixa é de lotes já vencidos. */
    val expired: Boolean get() = maxDays != null && maxDays < 0
}

/** Um nível com a quantidade de lotes e unidades nele, para as abas da tela inicial. */
data class LevelSummary(
    val level: UrgencyLevel,
    val lots: Int,
    val units: Long,
)

/** Uma validade com saldo estimado positivo, como aparece na lista inicial do app. */
data class ExpiryItem(
    val recordId: String,
    val productId: String,
    val productName: String,
    val barcode: String?,
    val expiresOn: String,
    val lotCode: String?,
    val quantity: Long,
    val daysToExpiry: Int,
    val level: UrgencyLevel? = null,
    /** Sobra prevista na validade pela média de vendas: 0 vende a tempo; nula sem previsão. */
    val forecastLeftover: Long? = null,
)

/** Texto da previsão de venda do lote; nulo sem previsão. `ok` quando deve vender a tempo. */
fun ExpiryItem.forecast(): Pair<String, Boolean>? {
    val leftover = forecastLeftover ?: return null
    return when {
        leftover == 0L -> "Deve vender antes de vencer" to true
        leftover >= quantity -> "Não deve vender até a validade" to false
        else -> "Deve sobrar $leftover ${if (leftover == 1L) "unidade" else "unidades"}" to false
    }
}

/** Produto achado pela pesquisa por descrição (AV24). */
data class ProductHit(
    val productId: String,
    val name: String,
    val barcode: String?,
    val tracked: Boolean,
    val quantity: Long,
    val nearestExpiry: String?,
)

data class Entry(
    val productId: String,
    val quantity: Int,
    val expiresOn: String,
    val lotCode: String?,
    val note: String?,
)

data class CountLine(
    val id: String,
    val expiresOn: String,
    val lotCode: String?,
    val quantity: Int,
    /** Observação escrita no painel; o coletor não edita, mas devolve ao salvar as linhas. */
    val note: String? = null,
)

data class CountSession(
    val id: String,
    val productId: String,
    val status: String,
    val version: Int,
    val lines: List<CountLine>,
)

data class Page<T>(
    val items: List<T>,
    val nextCursor: String?,
)

data class PendingCommand(
    val key: String,
    val operation: String,
    val description: String,
)

interface SessionPort {
    val session: StateFlow<Session?>

    /**
     * Por que a última sessão terminou sem o operador sair (ex.: o administrador desconectou o
     * aparelho pelo painel). Nulo quando foi o próprio operador que saiu.
     */
    val lastEndReason: String?

    suspend fun restore()

    /** Há sessão guardada neste aparelho para retomar (mesmo que a rede esteja fora agora). */
    suspend fun hasStoredSession(): Boolean

    suspend fun login(
        cnpj: String,
        username: String,
        password: String,
    )

    /** Troca o código lido do QR do painel por uma sessão. */
    suspend fun pair(code: String)

    suspend fun logout()

    suspend fun changePassword(
        currentPassword: String,
        newPassword: String,
    )
}

interface InventoryPort {
    suspend fun lookup(barcode: String): Product

    /** Pesquisa pela descrição ou pelo código, para código manchado ou sem código (AV24). */
    suspend fun search(
        text: String,
        cursor: String? = null,
    ): Page<ProductHit>

    /** Os níveis de urgência da loja, do mais urgente, com lotes e unidades em cada um. */
    suspend fun levels(): List<LevelSummary>

    /**
     * Validades com saldo, da mais próxima de vencer para a mais distante. Com [levelId], só as de
     * um nível; `NONE` são as fora de todos.
     */
    suspend fun expiries(
        cursor: String? = null,
        levelId: String? = null,
    ): Page<ExpiryItem>

    suspend fun inventory(productId: String): Inventory

    suspend fun receive(entry: Entry)

    /** Baixa manual de parte ou de todo o saldo de um lote, com motivo opcional (AV05). */
    suspend fun writeOff(
        record: StockRecord,
        quantity: Int,
        reason: String?,
    )

    /** Exclui o lote: as vendas dele vão para os outros lotes (AV07). */
    suspend fun deleteRecord(record: StockRecord)

    suspend fun counts(productId: String): List<CountSession>

    /** Abre e já inicia a contagem do produto. */
    suspend fun createCount(productId: String): CountSession

    suspend fun replaceLines(
        count: CountSession,
        lines: List<CountLine>,
    ): CountSession

    suspend fun confirmCount(
        count: CountSession,
        emptyConfirmed: Boolean,
    ): CountSession

    suspend fun cancelCount(
        count: CountSession,
        reason: String,
    ): CountSession

    suspend fun pendingCommand(): PendingCommand?

    suspend fun recoverCommand(): Boolean

    suspend fun retryPendingCommand()
}

data class LastLogin(
    val cnpj: String,
    val username: String,
)

/** Preferências deste aparelho, sem segredos: último acesso e configuração do leitor. */
interface DevicePreferences {
    fun lastLogin(): LastLogin?

    fun rememberLogin(login: LastLogin)

    fun scannerSettings(): ScannerSettings

    fun saveScannerSettings(settings: ScannerSettings)
}

class AppFailure(
    message: String,
    val uncertain: Boolean = false,
    val statusCode: Int? = null,
) : Exception(message)

class Login(
    private val session: SessionPort,
    private val preferences: DevicePreferences? = null,
) {
    suspend operator fun invoke(
        cnpj: String,
        username: String,
        password: String,
    ) {
        val normalized = Cnpj.normalize(cnpj)
        require(Cnpj.isValid(normalized)) { "Informe um CNPJ válido, numérico ou alfanumérico." }
        require(username.isNotBlank() && password.isNotBlank()) { "Informe usuário e senha." }
        session.login(normalized, username.trim(), password)
        // Só depois do login aceito: evita redigitar CNPJ e usuário no teclado do coletor.
        preferences?.rememberLogin(LastLogin(normalized, username.trim()))
    }
}

/**
 * Entrada no coletor pelo QR gerado no painel, sem digitar CNPJ, usuário e senha no
 * teclado numérico.
 *
 * O aplicativo só reconhece o prefixo para distinguir o código de acesso de um código
 * de produto; quem valida formato, validade e uso único é o servidor. Assim uma versão
 * futura do código não fica presa à regra de um aplicativo antigo.
 */
object PairingCode {
    const val PREFIX = "estoque-pair:"

    fun recognizes(value: String): Boolean = value.trim().startsWith(PREFIX)
}

class PairDevice(
    private val session: SessionPort,
    private val preferences: DevicePreferences? = null,
) {
    suspend operator fun invoke(code: String) {
        require(PairingCode.recognizes(code)) {
            "Este não é um código de acesso. Gere o QR no painel, em Equipe da loja."
        }
        session.pair(code.trim())
        // Se um dia for preciso entrar com senha, CNPJ e usuário já estarão preenchidos.
        session.session.value?.let {
            preferences?.rememberLogin(LastLogin(Cnpj.normalize(it.store.cnpj), it.user.username))
        }
    }
}

class ReceiveEntry(
    private val inventory: InventoryPort,
) {
    suspend operator fun invoke(entry: Entry) {
        require(entry.quantity in 1..1000000000) { "A entrada deve ter quantidade inteira positiva." }
        require(ExpiryDate.isValidIso(entry.expiresOn)) { "Informe uma validade válida." }
        require((entry.note?.length ?: 0) <= 1000) { "A observação pode ter até 1.000 caracteres." }
        inventory.receive(entry)
    }
}

/** Configuração do push do servidor; os dados do Firebase vêm vazios quando ele não usa. */
data class PushSettings(
    val allowed: Boolean,
    val fcmProjectId: String?,
    val fcmAppId: String?,
    val fcmApiKey: String?,
    val fcmSenderId: String?,
) {
    val fcmAvailable: Boolean
        get() =
            allowed &&
                !fcmProjectId.isNullOrBlank() &&
                !fcmAppId.isNullOrBlank() &&
                !fcmApiKey.isNullOrBlank() &&
                !fcmSenderId.isNullOrBlank()
}

/** Inscrição do aparelho no push do proprietário (AV25). */
interface PushPort {
    suspend fun settings(): PushSettings

    suspend fun register(token: String)

    suspend fun unregister(token: String)
}
