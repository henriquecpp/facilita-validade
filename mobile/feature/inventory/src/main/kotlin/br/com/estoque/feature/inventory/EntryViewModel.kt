package br.com.estoque.feature.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.Entry
import br.com.estoque.core.domain.ExpiryDate
import br.com.estoque.core.domain.ExpiryInput
import br.com.estoque.core.domain.ExpiryWarning
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.Product
import br.com.estoque.core.domain.ReceiveEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Nova mercadoria: acrescenta unidades a partir de agora, num lote novo com a data e a hora do
 * lançamento. Correção de lote é baixa ou exclusão (tela do produto).
 */
class EntryViewModel(
    private val repository: InventoryPort,
    val product: Product,
    private val today: () -> String,
) : ViewModel() {
    enum class Field { QUANTITY, EXPIRY, LOT, NOTE }

    data class Form(
        val quantity: String = "",
        val expiry: String = "",
        val lot: String = "",
        /** Observação do lote (AV23), como no painel. */
        val note: String = "",
    ) {
        val isEmpty: Boolean get() = this == Form()
    }

    data class State(
        val form: Form = Form(),
        val busy: Boolean = false,
        val error: String? = null,
        val errorField: Field? = null,
        val warning: ExpiryWarning? = null,
        val notice: String? = null,
        /** Envio sem confirmação: o formulário fica travado até reenviar o mesmo comando. */
        val uncertain: Boolean = false,
        /** Muda a cada entrada confirmada: a tela devolve o foco à quantidade. */
        val saved: Int = 0,
        /** Muda a cada erro de campo: a tela leva o foco ao campo com problema. */
        val focusRequest: Int = 0,
    )

    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private var acknowledgedExpiry: String? = null

    fun update(form: Form) {
        val current = mutable.value
        if (current.busy || current.uncertain) return
        val expiryChanged = form.expiry != current.form.expiry
        if (expiryChanged) acknowledgedExpiry = null
        mutable.update {
            it.copy(
                form = form,
                error = null,
                errorField = null,
                warning = if (expiryChanged) null else it.warning,
                notice = null,
            )
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
        if (quantity == null || quantity !in 1..1_000_000_000) {
            return invalid(Field.QUANTITY, "Informe a quantidade recebida, em unidades inteiras.")
        }
        return true
    }

    /** Valida a data; uma validade suspeita pede um segundo Enter antes de seguir. */
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

    fun submit() {
        val current = mutable.value
        if (current.busy) return
        if (current.uncertain) return retry()
        if (!checkQuantity() || !checkExpiry()) return
        if (current.form.lot.length > 100) {
            invalid(Field.LOT, "O lote pode ter até 100 caracteres.")
            return
        }
        if (current.form.note.length > 1000) {
            invalid(Field.NOTE, "A observação pode ter até 1.000 caracteres.")
            return
        }
        val entry =
            Entry(
                product.id,
                current.form.quantity.toInt(),
                ExpiryInput.parse(current.form.expiry)!!,
                current.form.lot
                    .trim()
                    .ifEmpty { null },
                current.form.note
                    .trim()
                    .ifEmpty { null },
            )
        send(entry) { ReceiveEntry(repository)(entry) }
    }

    /** Reenvia o comando preservado, com a mesma chave: o servidor não duplica a entrada. */
    fun retry() {
        val form = mutable.value.form
        val entry = Entry(product.id, form.quantity.toIntOrNull() ?: 0, ExpiryInput.parse(form.expiry).orEmpty(), null, null)
        send(entry) { repository.retryPendingCommand() }
    }

    private fun send(
        entry: Entry,
        command: suspend () -> Unit,
    ) {
        viewModelScope.launch {
            mutable.update { it.copy(busy = true, error = null, notice = null) }
            try {
                command()
                acknowledgedExpiry = null
                mutable.update {
                    State(
                        notice = "Entrada registrada: ${entry.quantity} un., validade ${ExpiryDate.format(entry.expiresOn)}.",
                        saved = it.saved + 1,
                        focusRequest = it.focusRequest,
                    )
                }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: AppFailure) {
                mutable.update {
                    it.copy(
                        busy = false,
                        uncertain = failure.uncertain,
                        error =
                            if (failure.uncertain) {
                                "A conexão caiu antes da confirmação. Os dados foram preservados: tecle Enter para enviar de novo, sem duplicar."
                            } else {
                                failure.message
                            },
                    )
                }
            } catch (error: Exception) {
                mutable.update { it.copy(busy = false, error = error.message ?: "Não foi possível registrar a entrada.") }
            }
        }
    }
}
