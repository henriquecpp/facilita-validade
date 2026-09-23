package br.com.estoque.core.domain

import kotlinx.coroutines.flow.MutableStateFlow

/** Estoque em memória para testes de telas e casos de uso; registra os comandos recebidos. */
open class FakeInventory : InventoryPort {
    val products = mutableMapOf<String, Product>()
    val inventories = mutableMapOf<String, Inventory>()
    var expiryPages = mutableListOf<Page<ExpiryItem>>()

    /** Páginas por nível (id ou NONE); sem a chave, o nível usa [expiryPages]. */
    val levelPages = mutableMapOf<String, MutableList<Page<ExpiryItem>>>()
    var levelSummaries = mutableListOf<LevelSummary>()
    val expiryRequests = mutableListOf<Pair<String?, String?>>()
    var searchResults = mutableListOf<ProductHit>()
    val searches = mutableListOf<String>()

    /** Códigos consultados no servidor. */
    val lookups = mutableListOf<String>()
    val writeOffs = mutableListOf<Triple<String, Int, String?>>()
    val deleted = mutableListOf<String>()
    val receipts = mutableListOf<Entry>()
    val savedLines = mutableListOf<List<CountLine>>()
    var countSessions = mutableListOf<CountSession>()
    var confirmed: CountSession? = null
    var cancelledReason: String? = null
    var pending: PendingCommand? = null
    var failure: AppFailure? = null
    var recoverResult = true
    var retried = 0

    private fun fail() {
        failure?.let { throw it }
    }

    fun addProduct(
        barcode: String,
        product: Product,
        inventory: Inventory = Inventory(product, "TRACKED", emptyList(), 0, false),
    ) {
        products[barcode] = product
        inventories[product.id] = inventory
    }

    override suspend fun lookup(barcode: String): Product {
        fail()
        lookups += barcode
        return products[barcode] ?: throw AppFailure("Produto não encontrado.", statusCode = 404)
    }

    override suspend fun search(
        text: String,
        cursor: String?,
    ): Page<ProductHit> {
        fail()
        searches += text
        return Page(searchResults.filter { it.name.contains(text, ignoreCase = true) }, null)
    }

    override suspend fun levels(): List<LevelSummary> {
        fail()
        return levelSummaries
    }

    override suspend fun expiries(
        cursor: String?,
        levelId: String?,
    ): Page<ExpiryItem> {
        fail()
        expiryRequests += cursor to levelId
        val index = cursor?.toInt() ?: 0
        val pages = levelId?.let { levelPages[it] } ?: expiryPages
        return pages.getOrElse(index) { Page(emptyList(), null) }
    }

    override suspend fun inventory(productId: String): Inventory {
        fail()
        return inventories.getValue(productId)
    }

    override suspend fun receive(entry: Entry) {
        fail()
        receipts += entry
    }

    override suspend fun writeOff(
        record: StockRecord,
        quantity: Int,
        reason: String?,
    ) {
        fail()
        writeOffs += Triple(record.id, quantity, reason)
        replaceRecord(record.id) { it.copy(quantity = it.quantity - quantity, writtenOffQuantity = it.writtenOffQuantity + quantity) }
    }

    override suspend fun deleteRecord(record: StockRecord) {
        fail()
        deleted += record.id
        replaceRecord(record.id) { null }
    }

    /** Aplica a correção ao lote nos estoques guardados; null tira o lote da lista. */
    private fun replaceRecord(
        id: String,
        change: (StockRecord) -> StockRecord?,
    ) {
        for ((productId, inventory) in inventories.toMap()) {
            if (inventory.records.none { it.id == id }) continue
            val records = inventory.records.mapNotNull { if (it.id == id) change(it) else it }.filter { it.quantity > 0 }
            inventories[productId] = inventory.copy(records = records, totalQuantity = records.sumOf { it.quantity.toLong() })
        }
    }

    override suspend fun counts(productId: String): List<CountSession> = countSessions.filter { it.productId == productId }

    override suspend fun createCount(productId: String): CountSession {
        fail()
        return CountSession("count-$productId", productId, "COUNTING", 1, emptyList()).also { countSessions += it }
    }

    override suspend fun replaceLines(
        count: CountSession,
        lines: List<CountLine>,
    ): CountSession {
        fail()
        savedLines += lines
        return count.copy(version = count.version + 1, lines = lines).also { replace(it) }
    }

    override suspend fun confirmCount(
        count: CountSession,
        emptyConfirmed: Boolean,
    ): CountSession {
        fail()
        return count.copy(status = "CONFIRMED", version = count.version + 1).also {
            confirmed = it
            replace(it)
        }
    }

    override suspend fun cancelCount(
        count: CountSession,
        reason: String,
    ): CountSession {
        fail()
        cancelledReason = reason
        return count.copy(status = "CANCELLED", version = count.version + 1).also { replace(it) }
    }

    private fun replace(session: CountSession) {
        countSessions = countSessions.map { if (it.id == session.id) session else it }.toMutableList()
    }

    override suspend fun pendingCommand(): PendingCommand? = pending

    override suspend fun recoverCommand(): Boolean {
        if (recoverResult) pending = null
        return recoverResult
    }

    override suspend fun retryPendingCommand() {
        fail()
        retried++
        pending = null
    }
}

class FakePreferences(
    private var login: LastLogin? = null,
    private var scanner: ScannerSettings = ScannerSettings(),
) : DevicePreferences {
    override fun lastLogin() = login

    override fun rememberLogin(login: LastLogin) {
        this.login = login
    }

    override fun scannerSettings() = scanner

    override fun saveScannerSettings(settings: ScannerSettings) {
        scanner = settings
    }
}

class FakeSession(
    initial: Session? = null,
) : SessionPort {
    override val session = MutableStateFlow(initial)
    override var lastEndReason: String? = null
    var loginFailure: AppFailure? = null
    var pairFailure: AppFailure? = null
    val pairedCodes = mutableListOf<String>()

    /** Falhas da retomada, em ordem; a sessão guardada continua enquanto [stored]. */
    val restoreFailures = ArrayDeque<Exception>()
    var stored = false
    var restores = 0
    var restored: Session? = null

    override suspend fun restore() {
        restores++
        restoreFailures.removeFirstOrNull()?.let { throw it }
        if (stored) session.value = restored
    }

    override suspend fun hasStoredSession() = stored

    override suspend fun login(
        cnpj: String,
        username: String,
        password: String,
    ) {
        loginFailure?.let { throw it }
        session.value = Session(Store("store", "Loja", cnpj), User("user", username, "OPERATOR"))
    }

    override suspend fun pair(code: String) {
        pairFailure?.let { throw it }
        pairedCodes += code
        session.value = Session(Store("store", "Loja", "11222333000181"), User("op", "repositor", "OPERATOR"))
    }

    override suspend fun logout() {
        session.value = null
    }

    override suspend fun changePassword(
        currentPassword: String,
        newPassword: String,
    ) = Unit
}
