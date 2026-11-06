package br.com.estoque.app

import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.CountLine
import br.com.estoque.core.domain.CountSession
import br.com.estoque.core.domain.Entry
import br.com.estoque.core.domain.ExpiryItem
import br.com.estoque.core.domain.Inventory
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.LevelSummary
import br.com.estoque.core.domain.Page
import br.com.estoque.core.domain.PendingCommand
import br.com.estoque.core.domain.Product
import br.com.estoque.core.domain.ProductHit
import br.com.estoque.core.domain.PushPort
import br.com.estoque.core.domain.PushSettings
import br.com.estoque.core.domain.Session
import br.com.estoque.core.domain.SessionPort
import br.com.estoque.core.domain.StockRecord
import br.com.estoque.core.domain.Store
import br.com.estoque.core.domain.UrgencyLevel
import br.com.estoque.core.domain.User
import br.com.estoque.core.ui.daysUntil
import br.com.estoque.core.ui.todayIso
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.text.Normalizer
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Loja de mentira, só na memória, para o APK de teste offline. Imita o que o servidor responde
 * nas telas do coletor: qualquer código lido vira um produto sem contagem inicial (abre a
 * contagem), e quatro produtos de exemplo já vêm com lotes. Fechar o app apaga tudo.
 */
class DemoStore {
    private val mutex = Mutex()
    private val products = linkedMapOf<String, DemoProduct>()
    private val counts = mutableListOf<CountSession>()
    private val state = MutableStateFlow<Session?>(null)

    init {
        sample("789100010001", "IOGURTE NATURAL INTEGRAL 170G", 2 to 6, 12 to 4)
        sample("789100010002", "LEITE FERMENTADO 480G C/6", -1 to 2, 20 to 10)
        sample("789100010003", "QUEIJO MUSSARELA FATIADO 150G", 45 to 8)
        sample("789100010004", "REQUEIJAO CREMOSO 200G")
    }

    val session: SessionPort =
        object : SessionPort {
            override val session: StateFlow<Session?> = state.asStateFlow()
            override val lastEndReason: String? = null

            override suspend fun restore() = Unit

            override suspend fun hasStoredSession() = state.value != null

            override suspend fun login(
                cnpj: String,
                username: String,
                password: String,
            ) {
                delay(LATENCY)
                // "operador" entra como operador; qualquer outro nome, como proprietário.
                val role = if (username.contains("operador", ignoreCase = true)) "OPERATOR" else "OWNER"
                state.value = Session(Store(STORE_ID, STORE_NAME, cnpj), User("demo-$username", username, role))
            }

            override suspend fun pair(code: String) {
                delay(LATENCY)
                state.value = Session(Store(STORE_ID, STORE_NAME, "11222333000181"), User("demo-coletor", "coletor", "OPERATOR"))
            }

            override suspend fun logout() {
                state.value = null
            }

            override suspend fun changePassword(
                currentPassword: String,
                newPassword: String,
            ) = delay(LATENCY)
        }

    val push: PushPort =
        object : PushPort {
            override suspend fun settings() = PushSettings(false, null, null, null, null)

            override suspend fun register(token: String) = Unit

            override suspend fun unregister(token: String) = Unit
        }

    val inventory: InventoryPort =
        object : InventoryPort {
            override suspend fun lookup(barcode: String): Product =
                locked {
                    val code = barcode.trim()
                    products.values.firstOrNull { it.barcode == code }?.product
                        ?: DemoProduct(Product(UUID.randomUUID().toString(), "PRODUTO $code", true), code, tracked = false)
                            .also { products[it.product.id] = it }
                            .product
                }

            override suspend fun search(
                text: String,
                cursor: String?,
            ): Page<ProductHit> =
                locked {
                    val words = plain(text).split(' ').filter { it.isNotBlank() }
                    val hits =
                        products.values
                            .filter { product ->
                                words.all { plain(product.product.description).contains(it) || product.barcode.contains(it) }
                            }.map {
                                val lots = it.records.filter { record -> record.quantity > 0 }
                                ProductHit(
                                    it.product.id,
                                    it.product.description,
                                    it.barcode,
                                    it.tracked,
                                    lots.sumOf { record ->
                                        record.quantity.toLong()
                                    },
                                    lots.minOfOrNull { record -> record.expiresOn },
                                )
                            }
                    Page(hits, null)
                }

            override suspend fun levels(): List<LevelSummary> =
                locked {
                    val lots = openLots()
                    LEVELS.map { level ->
                        val inLevel = lots.filter { levelOf(it.second.expiresOn)?.id == level.id }
                        LevelSummary(level, inLevel.size, inLevel.sumOf { it.second.quantity.toLong() })
                    }
                }

            override suspend fun expiries(
                cursor: String?,
                levelId: String?,
            ): Page<ExpiryItem> =
                locked {
                    val items =
                        openLots()
                            .map { (product, record) ->
                                ExpiryItem(
                                    recordId = record.id,
                                    productId = product.product.id,
                                    productName = product.product.description,
                                    barcode = product.barcode,
                                    expiresOn = record.expiresOn,
                                    lotCode = record.lotCode,
                                    quantity = record.quantity.toLong(),
                                    daysToExpiry = daysUntil(record.expiresOn) ?: 0,
                                    level = levelOf(record.expiresOn),
                                )
                            }.filter { levelId == null || it.level?.id == levelId || (levelId == "NONE" && it.level == null) }
                            .sortedWith(compareBy({ it.expiresOn }, { it.productName }))
                    Page(items, null)
                }

            override suspend fun inventory(productId: String): Inventory =
                locked {
                    val product = find(productId)
                    val records = product.records.sortedBy { it.expiresOn }.map { it.copy(level = levelOf(it.expiresOn)) }
                    Inventory(
                        product = product.product,
                        trackingStatus = if (product.tracked) "TRACKED" else "UNTRACKED",
                        records = records,
                        totalQuantity = records.sumOf { it.quantity.toLong() },
                        stale = false,
                        lastCountAt = product.lastCountAt,
                        projectedAt = product.lastCountAt?.let { now() },
                    )
                }

            override suspend fun receive(entry: Entry) {
                locked {
                    val record =
                        StockRecord(
                            id = UUID.randomUUID().toString(),
                            expiresOn = entry.expiresOn,
                            lotCode = entry.lotCode,
                            quantity = entry.quantity,
                            launchedAt = now(),
                            launchedBy = username(),
                            origin = "APP_RECEIPT",
                            note = entry.note,
                        )
                    find(entry.productId).records.add(record)
                }
            }

            override suspend fun writeOff(
                record: StockRecord,
                quantity: Int,
                reason: String?,
            ) {
                locked {
                    val (product, current) = lot(record)
                    if (quantity !in 1..current.quantity) {
                        throw AppFailure("A baixa deve ser de 1 a ${current.quantity} unidade(s).", statusCode = 400)
                    }
                    product.records.remove(current)
                    val left =
                        current.copy(
                            quantity = current.quantity - quantity,
                            writtenOffQuantity = current.writtenOffQuantity + quantity,
                            version = current.version + 1,
                        )
                    if (left.quantity > 0) product.records.add(left)
                }
            }

            override suspend fun deleteRecord(record: StockRecord) {
                locked {
                    val (product, current) = lot(record)
                    product.records.remove(current)
                }
            }

            override suspend fun counts(productId: String): List<CountSession> =
                locked { counts.filter { it.productId == productId }.reversed() }

            override suspend fun createCount(productId: String): CountSession =
                locked {
                    find(productId)
                    counts.firstOrNull { it.productId == productId && it.status == COUNTING }
                        ?: CountSession(UUID.randomUUID().toString(), productId, COUNTING, 1, emptyList()).also { counts += it }
                }

            override suspend fun replaceLines(
                count: CountSession,
                lines: List<CountLine>,
            ): CountSession = locked { update(count) { it.copy(lines = lines) } }

            override suspend fun confirmCount(
                count: CountSession,
                emptyConfirmed: Boolean,
            ): CountSession =
                locked {
                    val current = open(count)
                    if (current.lines.isEmpty() &&
                        !emptyConfirmed
                    ) {
                        throw AppFailure("Confirme que o produto não tem nenhuma unidade.", statusCode = 400)
                    }
                    val product = find(current.productId)
                    val at = now()
                    product.records.clear()
                    product.records +=
                        current.lines.map {
                            StockRecord(
                                UUID.randomUUID().toString(),
                                it.expiresOn,
                                it.lotCode,
                                it.quantity,
                                launchedAt = at,
                                launchedBy = username(),
                                origin = "COUNT",
                                note = it.note,
                            )
                        }
                    product.tracked = true
                    product.lastCountAt = at
                    update(current) { it.copy(status = "CONFIRMED") }
                }

            override suspend fun cancelCount(
                count: CountSession,
                reason: String,
            ): CountSession = locked { update(count) { it.copy(status = "CANCELLED") } }

            override suspend fun pendingCommand(): PendingCommand? = null

            override suspend fun recoverCommand() = true

            override suspend fun retryPendingCommand() = Unit
        }

    /** Simula a ida e volta ao servidor, para os estados de "enviando" aparecerem como no real. */
    private suspend fun <T> locked(block: () -> T): T {
        delay(LATENCY)
        return mutex.withLock { block() }
    }

    private fun find(productId: String) = products[productId] ?: throw AppFailure("Produto não encontrado.", statusCode = 404)

    private fun lot(record: StockRecord): Pair<DemoProduct, StockRecord> {
        for (product in products.values) {
            val current = product.records.firstOrNull { it.id == record.id } ?: continue
            if (current.version != record.version) throw AppFailure("O lote mudou. Atualize a tela.", statusCode = 409)
            return product to current
        }
        throw AppFailure("Lote não encontrado.", statusCode = 404)
    }

    private fun open(count: CountSession): CountSession {
        val current = counts.firstOrNull { it.id == count.id } ?: throw AppFailure("Contagem não encontrada.", statusCode = 404)
        if (current.status != COUNTING ||
            current.version != count.version
        ) {
            throw AppFailure("A contagem mudou. Atualize a tela.", statusCode = 409)
        }
        return current
    }

    private fun update(
        count: CountSession,
        change: (CountSession) -> CountSession,
    ): CountSession {
        val current = open(count)
        val updated = change(current).copy(version = current.version + 1)
        counts[counts.indexOf(current)] = updated
        return updated
    }

    private fun openLots() =
        products.values
            .filter { it.tracked }
            .flatMap { product -> product.records.filter { it.quantity > 0 }.map { product to it } }

    private fun username() = state.value?.user?.username

    private fun sample(
        prefix: String,
        description: String,
        vararg lots: Pair<Int, Int>,
    ) {
        val product = DemoProduct(Product("demo-$prefix", description, true), prefix + checkDigit(prefix), tracked = lots.isNotEmpty())
        lots.forEachIndexed { index, (days, quantity) ->
            product.records +=
                StockRecord(
                    "demo-$prefix-$index",
                    inDays(days),
                    "L${index + 1}",
                    quantity,
                    launchedAt = now(),
                    launchedBy = "admin",
                    origin = "COUNT",
                )
        }
        if (product.tracked) product.lastCountAt = now()
        products[product.product.id] = product
    }

    private class DemoProduct(
        val product: Product,
        val barcode: String,
        var tracked: Boolean,
        val records: MutableList<StockRecord> = mutableListOf(),
        var lastCountAt: String? = null,
    )

    private companion object {
        const val LATENCY = 250L
        const val COUNTING = "COUNTING"
        const val STORE_ID = "demo-store"
        const val STORE_NAME = "Loja de teste (offline)"

        val LEVELS =
            listOf(
                UrgencyLevel("5d1c8f0e-0000-4000-8000-000000000001", "Vencido", "#c62828", null, -1, true),
                UrgencyLevel("5d1c8f0e-0000-4000-8000-000000000002", "Urgente", "#ef6c00", 0, 7, true),
                UrgencyLevel("5d1c8f0e-0000-4000-8000-000000000003", "Atenção", "#f9a825", 8, 30, true),
                UrgencyLevel("5d1c8f0e-0000-4000-8000-000000000004", "Em dia", "#2e7d32", 31, null),
            )

        fun levelOf(expiresOn: String): UrgencyLevel? {
            val days = daysUntil(expiresOn) ?: return null
            return LEVELS.firstOrNull { days in (it.minDays ?: Int.MIN_VALUE)..(it.maxDays ?: Int.MAX_VALUE) }
        }

        fun checkDigit(prefix: String): Int = (10 - prefix.indices.sumOf { (prefix[it] - '0') * if (it % 2 == 0) 1 else 3 } % 10) % 10

        fun inDays(days: Int): String = todayIso(Calendar.getInstance().apply { add(Calendar.DAY_OF_MONTH, days) })

        fun now(): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
                .apply {
                    timeZone = TimeZone.getTimeZone("UTC")
                }.format(Date())

        fun plain(text: String): String =
            Normalizer
                .normalize(text.lowercase(Locale.ROOT), Normalizer.Form.NFD)
                .replace(Regex("\\p{M}"), "")
    }
}
