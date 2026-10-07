package br.com.estoque.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.CountSession
import br.com.estoque.core.domain.Ean13
import br.com.estoque.core.domain.ExpiryDate
import br.com.estoque.core.domain.Inventory
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.StockRecord
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface ProductKey {
    data class Barcode(
        val code: String,
    ) : ProductKey

    data class Id(
        val productId: String,
    ) : ProductKey
}

class ProductViewModel(
    private val repository: InventoryPort,
    private val key: ProductKey,
) : ViewModel() {
    data class State(
        val busy: Boolean = false,
        val inventory: Inventory? = null,
        /** Contagem aberta deste produto, que bloqueia novas entradas até ser concluída. */
        val openCount: CountSession? = null,
        val error: String? = null,
        val notice: String? = null,
        /** Baixa ou exclusão sem confirmação do servidor: reenviar não repete a correção. */
        val uncertain: Boolean = false,
    )

    /** Código lido que abriu a tela; confirma ao operador que o produto é o da gôndola. */
    val scannedCode: String? = (key as? ProductKey.Barcode)?.code

    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()

    private fun run(
        notice: String? = null,
        block: suspend () -> Unit,
    ) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            mutable.update { it.copy(busy = true, error = null, notice = null) }
            try {
                block()
                mutable.update { it.copy(notice = notice, uncertain = false) }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: AppFailure) {
                val message =
                    if (failure.statusCode == 404 && key is ProductKey.Barcode && mutable.value.inventory == null) {
                        "Código ${key.code} não está no catálogo da loja. " +
                            "Se o produto foi cadastrado há pouco no sistema da loja, o catálogo se atualiza sozinho: " +
                            "tente de novo em alguns minutos. Senão, confira o código ou pesquise pela descrição."
                    } else {
                        failure.message
                    }
                mutable.update { it.copy(error = message, uncertain = failure.uncertain) }
            } catch (error: Exception) {
                mutable.update { it.copy(error = error.message ?: "Não foi possível falar com o servidor.") }
            } finally {
                mutable.update { it.copy(busy = false) }
            }
        }
    }

    private suspend fun reload() {
        val productId =
            mutable.value.inventory
                ?.product
                ?.id ?: when (key) {
                is ProductKey.Barcode -> repository.lookup(key.code).id
                is ProductKey.Id -> key.productId
            }
        coroutineScope {
            val inventory = async { repository.inventory(productId) }
            val counts = async { repository.counts(productId) }
            mutable.update { current ->
                current.copy(
                    inventory = inventory.await(),
                    openCount = counts.await().firstOrNull { it.status == "COUNTING" },
                )
            }
        }
    }

    fun load() {
        // EAN-13 com o último dígito errado nem é consultado.
        if (key is ProductKey.Barcode && mutable.value.inventory == null && Ean13.invalid(key.code)) {
            mutable.update { it.copy(error = Ean13.message(key.code)) }
            return
        }
        run { reload() }
    }

    /** Baixa manual de parte ou de todo o saldo do lote (AV05, AV21). */
    fun writeOff(
        record: StockRecord,
        quantity: Int,
        reason: String?,
    ) = run("Baixa de $quantity un. do lote ${ExpiryDate.format(record.expiresOn)} registrada.") {
        require(quantity in 1..record.quantity) { "Informe de 1 a ${record.quantity} unidades." }
        repository.writeOff(record, quantity, reason?.trim()?.ifEmpty { null })
        reload()
    }

    /** Exclui o lote; as vendas dele vão para os outros lotes (AV07, AV21). */
    fun delete(record: StockRecord) =
        run("Lote ${ExpiryDate.format(record.expiresOn)} excluído.") {
            repository.deleteRecord(record)
            reload()
        }

    /** Reenvia a correção que ficou sem resposta, com a mesma chave. */
    fun resendPending() =
        run("Correção confirmada pelo servidor.") {
            repository.retryPendingCommand()
            reload()
        }
}
