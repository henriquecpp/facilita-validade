package br.com.estoque.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.estoque.core.domain.ExpiryItem
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.LevelSummary
import br.com.estoque.core.domain.PendingCommand
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Tela inicial: as validades da loja, da mais próxima de vencer para a mais distante, com uma aba
 * por nível de urgência que a loja definiu no painel (AV32). Cada aba busca só o seu nível.
 */
class ExpiriesViewModel(
    private val repository: InventoryPort,
    initialLevelId: String? = null,
) : ViewModel() {
    data class State(
        val items: List<ExpiryItem> = emptyList(),
        val nextCursor: String? = null,
        val loaded: Boolean = false,
        val busy: Boolean = false,
        val error: String? = null,
        val notice: String? = null,
        /** Lançamento enviado sem resposta confirmada (ex.: o app foi fechado no meio do envio). */
        val pending: PendingCommand? = null,
        /** Níveis da loja com lotes e unidades: as abas além de "Todas". */
        val levels: List<LevelSummary> = emptyList(),
        /** Aba escolhida: null é "Todas"; senão, o id do nível ou [NONE]. */
        val selected: String? = null,
    ) {
        val hasMore: Boolean get() = nextCursor != null

        /** As abas: os níveis com lote, mais o escolhido, mesmo vazio. */
        val tabs: List<LevelSummary>
            get() = levels.filter { it.lots > 0 || keyOf(it) == selected }
    }

    private val mutable = MutableStateFlow(State(selected = initialLevelId))
    val state = mutable.asStateFlow()

    private fun run(block: suspend () -> Unit) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            mutable.update { it.copy(busy = true, error = null) }
            try {
                block()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (error: Exception) {
                mutable.update { it.copy(error = error.message ?: "Não foi possível falar com o servidor.") }
            } finally {
                val pending = runCatching { repository.pendingCommand() }.getOrNull()
                mutable.update { it.copy(busy = false, pending = pending) }
            }
        }
    }

    private suspend fun nextPage() {
        val cursor = mutable.value.nextCursor ?: return
        val page = repository.expiries(cursor, mutable.value.selected)
        mutable.update { current ->
            current.copy(items = (current.items + page.items).distinctBy { it.recordId }, nextCursor = page.nextCursor)
        }
    }

    private suspend fun reload() {
        val levels = repository.levels()
        // Nível que a loja apagou no painel: volta para "Todas".
        val selected = mutable.value.selected?.takeIf { id -> levels.any { keyOf(it) == id } }
        val page = repository.expiries(levelId = selected)
        mutable.update {
            it.copy(levels = levels, selected = selected, items = page.items, nextCursor = page.nextCursor, loaded = true)
        }
    }

    fun refresh() = run { reload() }

    fun loadMore() = run { nextPage() }

    fun select(levelId: String?) {
        if (levelId == mutable.value.selected) return
        mutable.update { it.copy(selected = levelId, items = emptyList(), nextCursor = null, loaded = false) }
        run {
            val page = repository.expiries(levelId = levelId)
            mutable.update { it.copy(items = page.items, nextCursor = page.nextCursor, loaded = true) }
        }
    }

    /** Reenvia o mesmo comando, com a mesma chave: o servidor não duplica o lançamento. */
    fun resendPending() =
        run {
            repository.retryPendingCommand()
            mutable.update { it.copy(notice = "Lançamento confirmado pelo servidor.") }
            reload()
        }

    companion object {
        /** A faixa dos lotes fora de todos os níveis. */
        const val NONE = "NONE"

        fun keyOf(summary: LevelSummary): String = summary.level.id ?: NONE
    }
}
