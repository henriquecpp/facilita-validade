package br.com.estoque.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.Ean13
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.Product
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Lançamento rápido (AV19): bipa o produto, informa quantidade e validade, salva e já espera o
 * próximo, sem passar pela tela do produto. Produto sem contagem inicial abre a contagem dele.
 */
class QuickEntryViewModel(
    private val repository: InventoryPort,
) : ViewModel() {
    data class State(
        /** Produto lido, com o formulário de entrada aberto; null espera a leitura. */
        val product: Product? = null,
        val busy: Boolean = false,
        val error: String? = null,
        val notice: String? = null,
        /** Últimas entradas registradas nesta tela, da mais recente: o que já foi lançado. */
        val recent: List<String> = emptyList(),
        /** Produto sem contagem inicial lido agora: a tela abre a contagem dele. */
        val initialCount: Product? = null,
        /** Muda a cada produto lido: cada leitura abre um formulário novo, mesmo do mesmo produto. */
        val scans: Int = 0,
    )

    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()

    /**
     * Código lido: abre o formulário do produto, ou a contagem inicial se ele ainda não tem. EAN-13
     * com o último dígito errado nem é consultado.
     */
    fun scan(code: String) {
        if (mutable.value.busy) return
        if (Ean13.invalid(code)) {
            mutable.update { it.copy(error = Ean13.message(code), notice = null) }
            return
        }
        viewModelScope.launch {
            mutable.update { it.copy(busy = true, error = null, notice = null) }
            try {
                val product = repository.lookup(code)
                val inventory = repository.inventory(product.id)
                val open = repository.counts(product.id).any { it.status == "COUNTING" }
                when {
                    open && !inventory.tracked -> mutable.update { it.copy(initialCount = product) }
                    open ->
                        mutable.update {
                            it.copy(error = "${product.description}: há uma contagem em andamento. Conclua a contagem antes de lançar.")
                        }
                    !product.active -> mutable.update { it.copy(error = "${product.description} está inativo no cadastro da loja.") }
                    !inventory.tracked -> mutable.update { it.copy(initialCount = product) }
                    else -> mutable.update { it.copy(product = product, scans = it.scans + 1) }
                }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: AppFailure) {
                val message =
                    if (failure.statusCode == 404) {
                        "Código $code não encontrado. Confira o código ou pesquise pela descrição."
                    } else {
                        failure.message
                    }
                mutable.update { it.copy(error = message) }
            } catch (error: Exception) {
                mutable.update { it.copy(error = error.message ?: "Não foi possível falar com o servidor.") }
            } finally {
                mutable.update { it.copy(busy = false) }
            }
        }
    }

    /** A contagem inicial foi aberta: a tela não abre de novo ao voltar. */
    fun initialCountOpened() = mutable.update { it.copy(initialCount = null) }

    /** Entrada registrada: volta a esperar a leitura do próximo produto. */
    fun saved(summary: String) =
        mutable.update {
            it.copy(product = null, notice = summary, error = null, recent = (listOf(summary) + it.recent).take(RECENT))
        }

    /** Desiste do produto lido, sem registrar nada. */
    fun clear() = mutable.update { it.copy(product = null, error = null) }

    private companion object {
        const val RECENT = 8
    }
}
