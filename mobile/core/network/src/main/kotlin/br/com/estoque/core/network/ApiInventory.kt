package br.com.estoque.core.network

import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.CountLine
import br.com.estoque.core.domain.CountSession
import br.com.estoque.core.domain.Entry
import br.com.estoque.core.domain.ExpiryDate
import br.com.estoque.core.domain.ExpiryItem
import br.com.estoque.core.domain.Inventory
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.LevelSummary
import br.com.estoque.core.domain.Page
import br.com.estoque.core.domain.PendingCommand
import br.com.estoque.core.domain.Product
import br.com.estoque.core.domain.ProductHit
import br.com.estoque.core.domain.StockRecord
import br.com.estoque.core.domain.UrgencyLevel
import br.com.estoque.core.network.generated.ApiCountSession
import br.com.estoque.core.network.generated.ApiCountSessionStatus
import br.com.estoque.core.network.generated.ApiExpirySummary
import br.com.estoque.core.network.generated.ApiInventoryDetail
import br.com.estoque.core.network.generated.ApiInventoryItemTrackingStatus
import br.com.estoque.core.network.generated.ApiPageCountSession
import br.com.estoque.core.network.generated.ApiPageExpiryItem
import br.com.estoque.core.network.generated.ApiPageInventoryItem
import br.com.estoque.core.network.generated.ApiProduct
import br.com.estoque.core.network.generated.ApiStockRecord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.net.URLEncoder
import java.util.UUID

internal class ApiInventory(
    private val api: Api,
    private val session: ApiSession,
    private val vault: SecretVault,
) : InventoryPort {
    private val commandMutex = Mutex()

    private fun owner(): String {
        val value = session.session.value ?: throw AppFailure("Entre para continuar.")
        return "pending:${value.store.id}:${value.user.id}"
    }

    private suspend fun get(
        path: String,
        expectedOwner: String? = null,
    ) = readableNetwork { session.call(expectedOwner) { api.get(path, it) } }

    private fun encoded(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun ApiProduct.toDomain() = Product(id, description, active, photoUrl)

    private fun ApiCountSession.toDomain(): CountSession =
        CountSession(
            id,
            productId,
            status.name,
            version.checkedInt(),
            lines.orEmpty().map { CountLine(it.id, it.expiresOn, it.lotCode, it.quantity.checkedInt(), it.note) },
        )

    private fun count(value: JsonObject): CountSession {
        val data = value.decodeContract<ApiCountSession>()
        if (data.lines == null) throw AppFailure("A resposta da contagem não contém as linhas. Atualize antes de continuar.")
        return data.toDomain()
    }

    override suspend fun lookup(barcode: String): Product =
        get("products/by-barcode/${encoded(barcode)}").decodeContract<ApiProduct>().toDomain()

    override suspend fun search(
        text: String,
        cursor: String?,
    ): Page<ProductHit> {
        val path = "inventory?limit=30&search=${encoded(text.trim())}" + (cursor?.let { "&cursor=${encoded(it)}" } ?: "")
        val data = get(path).decodeContract<ApiPageInventoryItem>()
        return Page(
            data.items.map {
                ProductHit(
                    productId = it.productId,
                    name = it.productName,
                    barcode = it.barcode,
                    tracked = it.trackingStatus == ApiInventoryItemTrackingStatus.TRACKED,
                    quantity = it.estimatedQuantity,
                    nearestExpiry = it.nearestExpiry,
                )
            },
            data.nextCursor,
        )
    }

    override suspend fun levels(): List<LevelSummary> =
        get("inventory/expiries/summary").decodeContract<ApiExpirySummary>().items.map {
            LevelSummary(
                UrgencyLevel(
                    it.levelId,
                    it.name,
                    it.color,
                    it.minDays?.checkedInt(),
                    it.maxDays?.checkedInt(),
                    it.notify,
                ),
                it.lots.checkedInt(),
                it.units,
            )
        }

    override suspend fun expiries(
        cursor: String?,
        levelId: String?,
    ): Page<ExpiryItem> {
        val path =
            "inventory/expiries?limit=50" + (cursor?.let { "&cursor=${encoded(it)}" } ?: "") +
                (levelId?.let { "&levelId=${encoded(it)}" } ?: "")
        val data = get(path).decodeContract<ApiPageExpiryItem>()
        return Page(
            data.items.map {
                ExpiryItem(
                    recordId = it.id,
                    productId = it.productId,
                    productName = it.productName,
                    barcode = it.barcode,
                    expiresOn = it.expiresOn,
                    lotCode = it.lotCode,
                    quantity = it.quantity,
                    daysToExpiry = it.daysToExpiry.checkedInt(),
                    level = it.levelName?.let { name -> UrgencyLevel(it.levelId, name, it.levelColor.orEmpty()) },
                    forecastLeftover = it.forecastLeftover,
                )
            },
            data.nextCursor,
        )
    }

    private fun ApiStockRecord.toDomain() =
        StockRecord(
            id = id,
            expiresOn = expiresOn,
            lotCode = lotCode,
            quantity = quantity.checkedInt(),
            launchedQuantity = (launchedQuantity ?: quantity).checkedInt(),
            soldQuantity = (soldQuantity ?: 0L).checkedInt(),
            writtenOffQuantity = (writtenOffQuantity ?: 0L).checkedInt(),
            version = (version ?: 1L).checkedInt(),
            launchedAt = launchedAt,
            launchedBy = launchedBy,
            origin = origin?.name,
            note = note,
            level = levelName?.let { UrgencyLevel(levelId, it, levelColor.orEmpty()) },
        )

    override suspend fun inventory(productId: String): Inventory {
        val data = get("inventory/products/${encoded(productId)}").decodeContract<ApiInventoryDetail>()
        return Inventory(
            data.product.toDomain(),
            data.trackingStatus.name,
            data.records.map { it.toDomain() },
            data.totalQuantity,
            data.stale,
            data.lastCountAt,
            data.projectedAt,
            data.countWindowQuantity,
        )
    }

    override suspend fun receive(entry: Entry) {
        command(
            "inventory.receipt",
            "POST",
            "inventory/receipts",
            "Entrada de ${entry.quantity} unidade(s)",
            buildJsonObject {
                put("productId", entry.productId)
                put("quantity", entry.quantity)
                put("expiresOn", entry.expiresOn)
                entry.lotCode?.let { put("lotCode", it) }
                entry.note?.let { put("note", it) }
            },
        )
    }

    override suspend fun writeOff(
        record: StockRecord,
        quantity: Int,
        reason: String?,
    ) {
        command(
            "inventory.write-off",
            "POST",
            "inventory/records/${encoded(record.id)}/write-off",
            "Baixa de $quantity unidade(s) do lote ${ExpiryDate.format(record.expiresOn)}",
            buildJsonObject {
                put("expectedVersion", record.version)
                put("quantity", quantity)
                reason?.let { put("reason", it) }
            },
        )
    }

    override suspend fun deleteRecord(record: StockRecord) {
        command(
            "inventory.delete",
            "POST",
            "inventory/records/${encoded(record.id)}/delete",
            "Exclusão do lote ${ExpiryDate.format(record.expiresOn)}",
            buildJsonObject { put("expectedVersion", record.version) },
        )
    }

    override suspend fun counts(productId: String): List<CountSession> =
        get("count-sessions?productId=${encoded(productId)}").decodeContract<ApiPageCountSession>().items.map {
            // List responses omit lines. Fetch an editable session before replacing its lines.
            if (it.status == ApiCountSessionStatus.COUNTING) {
                count(get("count-sessions/${encoded(it.id)}"))
            } else {
                it.toDomain()
            }
        }

    override suspend fun createCount(productId: String): CountSession =
        count(
            command(
                "count.create",
                "POST",
                "count-sessions",
                "Abrir contagem",
                buildJsonObject {
                    put("productId", productId)
                },
            ),
        )

    override suspend fun replaceLines(
        count: CountSession,
        lines: List<CountLine>,
    ): CountSession =
        count(
            command(
                "count.lines",
                "PUT",
                "count-sessions/${count.id}/lines",
                "Salvar linhas da contagem",
                buildJsonObject {
                    put("expectedVersion", count.version)
                    putJsonArray("lines") {
                        lines.forEach { line ->
                            addJsonObject {
                                put("id", line.id)
                                put("expiresOn", line.expiresOn)
                                put("quantity", line.quantity)
                                line.lotCode?.let { put("lotCode", it) }
                                // O PUT substitui as linhas: sem a observação, a escrita no painel sumiria.
                                line.note?.let { put("note", it) }
                            }
                        }
                    }
                },
            ),
        )

    override suspend fun confirmCount(
        count: CountSession,
        emptyConfirmed: Boolean,
    ): CountSession =
        count(
            command(
                "count.confirm",
                "POST",
                "count-sessions/${count.id}/confirm",
                "Confirmar contagem completa",
                buildJsonObject {
                    put("expectedVersion", count.version)
                    put("completeConfirmed", true)
                    put("emptyConfirmed", emptyConfirmed)
                },
            ),
        )

    override suspend fun cancelCount(
        count: CountSession,
        reason: String,
    ): CountSession =
        count(
            command(
                "count.cancel",
                "POST",
                "count-sessions/${count.id}/cancel",
                "Cancelar contagem",
                buildJsonObject {
                    put("expectedVersion", count.version)
                    put("reason", reason)
                },
            ),
        )

    private suspend fun loadPending(slot: String = owner()): JsonObject? =
        withContext(Dispatchers.IO) {
            vault.read(slot)?.let { json.parseToJsonElement(it).jsonObject }
        }

    override suspend fun pendingCommand(): PendingCommand? =
        loadPending()?.let {
            PendingCommand(it.string("key"), it.string("operation"), it.string("description"))
        }

    private suspend fun command(
        operation: String,
        method: String,
        path: String,
        description: String,
        body: JsonObject,
    ): JsonObject =
        commandMutex.withLock {
            val slot = owner()
            loadPending(slot)?.let { waiting ->
                // Erro certo, não incerto: este comando nem saiu do aparelho. Como incerto, a tela
                // travaria o formulário e o "enviar de novo" reenviaria o outro comando, mostrando
                // como feito o lançamento que nunca foi enviado.
                throw AppFailure(
                    "Antes, confirme o lançamento que ficou sem resposta do servidor (${waiting.string("description")}): " +
                        "toque em \"Enviar de novo\" na tela inicial.",
                )
            }
            val pending =
                buildJsonObject {
                    put("key", UUID.randomUUID().toString())
                    put("operation", operation)
                    put("method", method)
                    put("path", path)
                    put("description", description)
                    put("body", body)
                }
            withContext(Dispatchers.IO) { vault.write(slot, pending.toString()) }
            executePending(pending, slot)
        }

    private suspend fun executePending(
        pending: JsonObject,
        slot: String,
    ): JsonObject {
        try {
            val result =
                session.call(slot) { token ->
                    if (pending.string("method") ==
                        "PUT"
                    ) {
                        api.put(pending.string("path"), token, pending.string("key"), pending.getValue("body").jsonObject)
                    } else {
                        api.post(pending.string("path"), token, pending.string("key"), pending.getValue("body").jsonObject)
                    }
                }
            withContext(Dispatchers.IO) { vault.remove(slot) }
            return result
        } catch (failure: AppFailure) {
            if (!failure.uncertain) withContext(Dispatchers.IO) { vault.remove(slot) }
            throw failure
        } catch (failure: Exception) {
            if (failure is kotlinx.coroutines.CancellationException) throw failure
            throw AppFailure("Resposta não confirmada. O comando foi preservado; consulte o resultado ou repita com a mesma chave.", true)
        }
    }

    override suspend fun recoverCommand(): Boolean =
        commandMutex.withLock {
            val slot = owner()
            val pending = loadPending(slot) ?: return true
            val tokenResult =
                try {
                    get("operations/${pending.string("key")}?operation=${encoded(pending.string("operation"))}", slot)
                } catch (
                    failure: AppFailure,
                ) {
                    // A missing receipt does not prove the command failed or rolled back.
                    if (failure.statusCode == 404) return false
                    throw failure
                }
            check(tokenResult.containsKey("result")) { "Resposta de recuperação inválida." }
            withContext(Dispatchers.IO) { vault.remove(slot) }
            true
        }

    override suspend fun retryPendingCommand() {
        commandMutex.withLock {
            val slot = owner()
            loadPending(slot)?.let { executePending(it, slot) }
        }
    }
}
