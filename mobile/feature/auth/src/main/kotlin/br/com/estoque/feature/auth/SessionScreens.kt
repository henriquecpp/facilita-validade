package br.com.estoque.feature.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import br.com.estoque.core.domain.SessionPort
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.AppTextField
import br.com.estoque.core.ui.BarTextAction
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.KeyHint
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import br.com.estoque.core.ui.formStep
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class SessionViewModel(
    private val repository: SessionPort,
    private val retryMillis: Long = 5_000,
) : ViewModel() {
    data class State(
        val restoring: Boolean = true,
        val busy: Boolean = false,
        val message: String? = null,
        /** Sessão guardada, mas sem servidor ao abrir o app: tentando de novo sozinho. */
        val reconnecting: Boolean = false,
    )

    val session = repository.session
    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private var restoring: Job? = null

    init {
        retryRestore()
        // Sessão que termina sem o operador sair (vencida, ou o administrador desconectou o
        // aparelho pelo painel): o login diz o motivo, em vez de só reaparecer. Sair e trocar a
        // senha não deixam motivo, e o recado deles vem do próprio comando.
        viewModelScope.launch {
            var previous = repository.session.value
            repository.session.collect { current ->
                if (previous != null && current == null) {
                    repository.lastEndReason?.let { reason -> mutable.update { it.copy(message = reason) } }
                }
                previous = current
            }
        }
    }

    /**
     * Retoma a sessão guardada. Sem rede — o coletor recém-ligado, antes do Wi-Fi —, ela segue
     * guardada: o app tenta de novo sozinho, em vez de mandar o operador para o login, que
     * pediria a senha ou um QR novo do painel. Só a sessão recusada pelo servidor vai ao login.
     */
    fun retryRestore() {
        restoring?.cancel()
        restoring =
            viewModelScope.launch {
                while (true) {
                    try {
                        repository.restore()
                        mutable.value = State(restoring = false)
                        return@launch
                    } catch (cancel: CancellationException) {
                        throw cancel
                    } catch (error: Exception) {
                        if (!repository.hasStoredSession()) {
                            mutable.value =
                                State(restoring = false, message = error.message ?: "Não foi possível restaurar a sessão. Entre novamente.")
                            return@launch
                        }
                        mutable.value =
                            State(restoring = false, reconnecting = true, message = "Sem conexão com o servidor. Tentando de novo…")
                        delay(retryMillis)
                    }
                }
            }
    }

    /** Desiste da sessão guardada por agora e mostra o login, para entrar com outra conta. */
    fun useAnotherAccount() {
        restoring?.cancel()
        mutable.value = State(restoring = false)
    }

    /** Recado de uma sessão anterior ("Sessão encerrada.") não vale para a próxima. */
    fun clearMessage() {
        if (!mutable.value.busy) mutable.value = mutable.value.copy(message = null)
    }

    fun logout() =
        command {
            repository.logout()
            "Sessão encerrada."
        }

    fun changePassword(
        current: String,
        replacement: String,
    ) = command {
        require(replacement.length >= 12) { "A nova senha deve ter pelo menos 12 caracteres." }
        repository.changePassword(current, replacement)
        "Senha alterada. Entre novamente com a nova senha."
    }

    private fun command(block: suspend () -> String) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            mutable.value = mutable.value.copy(busy = true, message = null)
            try {
                mutable.value = State(restoring = false, message = block())
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (error: Exception) {
                mutable.value = State(restoring = false, message = error.message ?: "Verifique sua conexão e tente novamente.")
            }
        }
    }
}

private const val MIN_PASSWORD = 12

/**
 * Troca de senha. Obrigatória (sem [onBack]) quando a senha é temporária: aí a única saída é
 * sair da conta. Pelo aparelho, é opcional e o Voltar retorna.
 */
@Composable
fun ChangePasswordScreen(
    state: SessionViewModel.State,
    submit: (String, String) -> Unit,
    logout: () -> Unit,
    onBack: (() -> Unit)? = null,
) {
    var current by remember { mutableStateOf("") }
    var replacement by remember { mutableStateOf("") }
    val focus = LocalFocusManager.current
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { first.requestFocus() }
    val ready = current.isNotBlank() && replacement.length >= MIN_PASSWORD
    val send = { if (ready) submit(current, replacement) }
    val required = onBack == null
    AppScreen(
        title = if (required) "Defina sua senha" else "Trocar senha",
        onBack = onBack,
        busy = state.busy,
        actions = { if (required) BarTextAction("Sair", logout, enabled = !state.busy) },
        bottomBar = {
            ActionButton("Alterar senha", send, Modifier.fillMaxWidth(), glyph = Glyph.Lock, enabled = ready)
        },
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                if (required) {
                    "Troque a senha temporária antes de acessar a loja."
                } else {
                    "Depois da troca, entre de novo com a nova senha."
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            AppTextField(
                value = current,
                onValueChange = { current = it },
                label = if (required) "Senha atual ou temporária" else "Senha atual",
                readOnly = state.busy,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth().focusRequester(first).formStep(focus),
            )
            AppTextField(
                value = replacement,
                onValueChange = { replacement = it },
                label = "Nova senha",
                readOnly = state.busy,
                visualTransformation = PasswordVisualTransformation(),
                supporting =
                    if (replacement.length < MIN_PASSWORD) {
                        "Pelo menos $MIN_PASSWORD caracteres (${replacement.length}/$MIN_PASSWORD)"
                    } else {
                        "${replacement.length} caracteres"
                    },
                modifier = Modifier.fillMaxWidth().formStep(focus, onSubmit = send),
            )
            state.message?.let { StatusBanner(it, Tone.Error) }
            KeyHint("Enter avança; na nova senha, confirma.")
        }
    }
}
