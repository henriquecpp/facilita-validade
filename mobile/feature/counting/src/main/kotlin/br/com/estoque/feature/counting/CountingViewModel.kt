package br.com.estoque.feature.counting

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.CountLine
import br.com.estoque.core.domain.CountSession
import br.com.estoque.core.domain.ExpiryDate
import br.com.estoque.core.domain.ExpiryInput
import br.com.estoque.core.domain.ExpiryWarning
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.Product
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Contagem completa do produto: cada linha é uma validade/lote encontrada na loja. Ao concluir,
 * o total substitui o saldo anterior (não soma). O saldo contado vale a partir da última linha salva.
 */
class CountingViewModel(
    private val repository: InventoryPort,
    val product: Product,
    private val today: () -> String,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) : ViewModel() {
    enum class Field { QUANTITY, EXPIRY, LOT }

    data class Form(
        val quantity: String = "",
        val expiry: String = "",
        val lot: String = "",
    ) {
        val isEmpty: Boolean get() = this == Form()
    }

    data class State(
        val count: CountSession? = null,
        val form: Form = Form(),
        val busy: Boolean = false,
        val error: String? = null,
        val errorField: Field? = null,
        val warning: ExpiryWarning? = null,
        val notice: String? = null,
        val uncertain: Boolean = false,
        val confirming: Boolean = false,
        val cancelling: Boolean = false,
        /** Contagem confirmada ou cancelada: a tela fecha. */
        val finished: CountSession? = null,
        /** Sair é permitido mesmo com a contagem aberta (ex.: o cancelamento automático falhou). */
        val exitAllowed: Boolean = false,
        val saved: Int = 0,
        val focusRequest: Int = 0,
    ) {
        val total: Long get() = count?.lines?.sumOf { it.quantity.toLong() } ?: 0
    }

    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private var acknowledgedExpiry: String? = null

    init {
        open()
    }

    private fun command(
        leaving: Boolean = false,
        block: suspend () -> Unit,
    ) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            mutable.update { it.copy(busy = true, error = null, errorField = null, notice = null) }
            try {
                block()
                mutable.update { it.copy(busy = false, uncertain = false) }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: AppFailure) {
                // 409: outro aparelho (o painel, por exemplo) salvou ou encerrou esta contagem, e a
                // versão daqui ficou velha. Sem recarregar, todo Enter daria o mesmo erro.
                val latest = if (failure.statusCode == 409 && !failure.uncertain) latestCount() else null
                mutable.update {
                    it.copy(
                        busy = false,
                        uncertain = failure.uncertain,
                        count = latest?.takeIf { count -> count.status == "COUNTING" } ?: it.count,
                        finished = latest?.takeIf { count -> count.status != "COUNTING" } ?: it.finished,
                        error =
                            when {
                                failure.uncertain ->
                                    "A conexão caiu antes da confirmação. Os dados foram preservados: tecle Enter para enviar de novo."
                                latest != null ->
                                    "A contagem mudou em outro aparelho e as linhas foram atualizadas. Confira e tecle Enter de novo."
                                else -> failure.message
                            },
                        exitAllowed = it.exitAllowed || leaving,
                    )
                }
            } catch (error: Exception) {
                mutable.update {
                    it.copy(
                        busy = false,
                        error = error.message ?: "Não foi possível atualizar a contagem.",
                        exitAllowed = it.exitAllowed || leaving,
                    )
                }
            }
        }
    }

    /** A versão atual desta contagem no servidor; nula se não der para consultar agora. */
    private suspend fun latestCount(): CountSession? {
        val id = mutable.value.count?.id ?: return null
        return try {
            repository.counts(product.id).firstOrNull { it.id == id }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (_: Exception) {
            null
        }
    }

    /** Retoma a contagem aberta do produto ou abre uma nova, já iniciada. */
    fun open() =
        command {
            val count =
                repository.counts(product.id).firstOrNull { it.status == "COUNTING" }
                    ?: try {
                        repository.createCount(product.id)
                    } catch (failure: AppFailure) {
                        // Aberta em outro aparelho entre a consulta e a criação: retoma aquela.
                        if (failure.statusCode != 409) throw failure
                        repository.counts(product.id).firstOrNull { it.status == "COUNTING" } ?: throw failure
                    }
            mutable.update { it.copy(count = count) }
        }

    fun update(form: Form) {
        val current = mutable.value
        // Ao abrir a contagem a digitação já vale; durante um envio, o formulário fica parado.
        if ((current.busy && current.count != null) || current.uncertain) return
        val expiryChanged = form.expiry != current.form.expiry
        if (expiryChanged) acknowledgedExpiry = null
        mutable.update {
            it.copy(form = form, error = null, errorField = null, warning = if (expiryChanged) null else it.warning, notice = null)
        }
    }

    private fun invalid(
        field: Field,
        message: String,
    ): Boolean {
        mutable.update { it.copy(error = message, errorField = field, focusRequest = it.focusRequest + 1) }
        return false
    }

    fun checkQuantity(): Boolean {
        val quantity =
            mutable.value.form.quantity
                .toIntOrNull()
        return if (quantity == null || quantity !in 1..1_000_000_000) {
            invalid(Field.QUANTITY, "Informe quantas unidades desta validade você contou.")
        } else {
            true
        }
    }

    fun checkExpiry(): Boolean {
        val iso =
            ExpiryInput.parse(mutable.value.form.expiry)
                ?: return invalid(Field.EXPIRY, "Informe a validade com dia, mês e ano: 12042026.")
        val warning = ExpiryInput.warning(iso, today())
        if (warning != null && acknowledgedExpiry != iso) {
            acknowledgedExpiry = iso
            mutable.update { it.copy(warning = warning) }
            return false
        }
        return true
    }

    /** Salva a linha digitada. Linhas com a mesma validade e lote somam na conclusão. */
    fun addLine() {
        val current = mutable.value
        if (current.uncertain) return retry()
        val count = current.count ?: return
        if (!checkQuantity() || !checkExpiry()) return
        if (current.form.lot.length > 100) {
            invalid(Field.LOT, "O lote pode ter até 100 caracteres.")
            return
        }
        val line =
            CountLine(
                newId(),
                ExpiryInput.parse(current.form.expiry)!!,
                current.form.lot
                    .trim()
                    .ifEmpty { null },
                current.form.quantity.toInt(),
            )
        command {
            val updated = repository.replaceLines(count, count.lines + line)
            acknowledgedExpiry = null
            mutable.update {
                it.copy(
                    count = updated,
                    form = Form(),
                    warning = null,
                    saved = it.saved + 1,
                    notice = "Linha salva: ${line.quantity} un. de ${ExpiryDate.format(line.expiresOn)}.",
                )
            }
        }
    }

    fun removeLine(id: String) {
        val count = mutable.value.count ?: return
        command {
            val updated = repository.replaceLines(count, count.lines.filterNot { it.id == id })
            // O foco volta à quantidade: o botão de remover usado pelo teclado pode ter sumido.
            mutable.update { it.copy(count = updated, focusRequest = it.focusRequest + 1) }
        }
    }

    fun requestConfirm() {
        val current = mutable.value
        if (current.busy || current.count == null) return
        if (!current.form.isEmpty) {
            mutable.update {
                it.copy(
                    error = "Tecle Enter para salvar a linha digitada, ou apague-a, antes de concluir.",
                    focusRequest =
                        it.focusRequest + 1,
                )
            }
            return
        }
        mutable.update { it.copy(confirming = true) }
    }

    fun requestCancel() {
        if (!mutable.value.busy) mutable.update { it.copy(cancelling = true) }
    }

    fun dismissDialogs() = mutable.update { it.copy(confirming = false, cancelling = false) }

    /** Substitui o saldo pelo total contado; sem linhas, declara que não há unidades. */
    fun confirm() {
        val count = mutable.value.count ?: return
        val empty = mutable.value.total == 0L
        mutable.update { it.copy(confirming = false) }
        command {
            val confirmed = repository.confirmCount(count, emptyConfirmed = empty)
            mutable.update { it.copy(finished = confirmed) }
        }
    }

    fun cancel(reason: String) {
        val count = mutable.value.count ?: return
        mutable.update { it.copy(cancelling = false) }
        command {
            val cancelled = repository.cancelCount(count, reason.trim().ifEmpty { "Cancelada no coletor" })
            mutable.update { it.copy(finished = cancelled) }
        }
    }

    /**
     * Ao sair: uma contagem vazia é cancelada para não deixar o produto bloqueado. Retorna true
     * quando a tela pode fechar agora; senão, fecha ao terminar o cancelamento.
     */
    fun leave(): Boolean {
        val current = mutable.value
        if (current.exitAllowed || current.busy || current.uncertain) return true
        val count = current.count ?: return true
        if (count.lines.isNotEmpty()) return true
        command(leaving = true) {
            val cancelled = repository.cancelCount(count, "Contagem aberta sem linhas e abandonada no coletor")
            mutable.update { it.copy(finished = cancelled) }
        }
        return false
    }

    /** Reenvia o comando preservado e recarrega a contagem do servidor. */
    fun retry() =
        command {
            repository.retryPendingCommand()
            val sessions = repository.counts(product.id)
            val same = sessions.firstOrNull { it.id == mutable.value.count?.id }
            if (same != null && same.status != "COUNTING") {
                mutable.update { it.copy(finished = same) }
            } else {
                val active = sessions.firstOrNull { it.status == "COUNTING" } ?: repository.createCount(product.id)
                mutable.update { it.copy(count = active, form = Form(), saved = it.saved + 1) }
            }
        }
}
