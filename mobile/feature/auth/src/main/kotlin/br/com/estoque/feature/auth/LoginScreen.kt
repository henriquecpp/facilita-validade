package br.com.estoque.feature.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import br.com.estoque.core.domain.DevicePreferences
import br.com.estoque.core.domain.Login
import br.com.estoque.core.domain.PairDevice
import br.com.estoque.core.domain.PairingCode
import br.com.estoque.core.ui.APP_NAME
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.AppTextField
import br.com.estoque.core.ui.BusyBar
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.GlyphIcon
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.KeyHint
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import br.com.estoque.core.ui.formStep
import br.com.estoque.core.ui.rememberScanGuard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class LoginViewModel(
    private val login: Login,
    private val preferences: DevicePreferences,
    private val pairDevice: PairDevice,
) : ViewModel() {
    data class State(
        val busy: Boolean = false,
        val error: String? = null,
    )

    /**
     * CNPJ e usuário do último acesso neste aparelho; a senha nunca é guardada. Lido a cada
     * vez que a tela aparece: o modelo vive enquanto o app está aberto, e quem acabou de sair
     * ou de trocar a senha volta com os campos preenchidos.
     */
    val remembered get() = preferences.lastLogin()
    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()

    fun submit(
        cnpj: String,
        username: String,
        password: String,
    ) {
        if (mutable.value.busy) return
        viewModelScope.launch {
            mutable.value = State(busy = true)
            try {
                login(cnpj, username, password)
                mutable.value = State()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (error: Exception) {
                mutable.value = State(error = error.message ?: "Não foi possível entrar. Verifique a conexão.")
            }
        }
    }

    /**
     * Entrada pelo QR do painel, venha ele da câmera, do leitor em modo Intent ou do
     * leitor digitando no campo. Leitura que não é código de acesso é ignorada em
     * silêncio: bipar um produto na tela de login não deve mostrar erro.
     */
    fun pair(code: String) {
        if (mutable.value.busy || !PairingCode.recognizes(code)) return
        viewModelScope.launch {
            mutable.value = State(busy = true)
            try {
                pairDevice(code)
                mutable.value = State()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (error: Exception) {
                mutable.value = State(error = error.message ?: "Não foi possível entrar pelo QR. Verifique a conexão.")
            }
        }
    }
}

@Composable
fun LoginScreen(
    viewModel: LoginViewModel,
    notice: String? = null,
    onPairWithCamera: () -> Unit = {},
    appVersion: String = "",
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val focus = LocalFocusManager.current
    // O QR do painel chega por três caminhos, todos para o mesmo lugar: a câmera
    // (botão abaixo), o leitor do coletor em modo Intent e o leitor em modo teclado,
    // que "digita" o código no campo em foco — o ScanGuard devolve o campo ao que era.
    HandleScans { viewModel.pair(it) }
    val scanGuard = rememberScanGuard { viewModel.pair(it) }
    var cnpj by rememberSaveable { mutableStateOf(viewModel.remembered?.cnpj.orEmpty()) }
    var username by rememberSaveable { mutableStateOf(viewModel.remembered?.username.orEmpty()) }
    // A senha não entra no estado salvo da tela.
    var password by remember { mutableStateOf("") }
    val cnpjFocus = remember { FocusRequester() }
    val passwordFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { (if (viewModel.remembered != null) passwordFocus else cnpjFocus).requestFocus() }
    val submit = { viewModel.submit(cnpj, username, password) }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Brand()
        BusyBar(state.busy)
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            notice?.let { StatusBanner(it, Tone.Info) }
            AppTextField(
                value = cnpj,
                onValueChange = { cnpj = it },
                label = "CNPJ da loja",
                readOnly = state.busy,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii),
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .focusRequester(cnpjFocus)
                        .formStep(focus, scanGuard = scanGuard, value = cnpj, restore = { cnpj = it }),
            )
            AppTextField(
                value = username,
                onValueChange = { username = it },
                label = "Usuário",
                readOnly = state.busy,
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .formStep(focus, scanGuard = scanGuard, value = username, restore = { username = it }),
            )
            AppTextField(
                value = password,
                onValueChange = { password = it },
                label = "Senha",
                readOnly = state.busy,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .focusRequester(passwordFocus)
                        .formStep(focus, onSubmit = submit, scanGuard = scanGuard, value = password, restore = { password = it }),
            )
            state.error?.let { StatusBanner(it, Tone.Error) }
            ActionButton(
                if (state.busy) "Entrando…" else "Entrar",
                submit,
                Modifier.fillMaxWidth().padding(top = 4.dp),
            )
            ActionButton(
                "Entrar com QR",
                onPairWithCamera,
                Modifier.fillMaxWidth(),
                style = ActionStyle.Secondary,
                glyph = Glyph.Qr,
                enabled = !state.busy,
            )
            KeyHint("Enter avança; na senha, entra. No coletor, basta apontar o leitor para o QR do painel.")
            if (appVersion.isNotEmpty()) {
                Text(
                    "Versão $appVersion",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.outline,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                )
            }
        }
    }
}

/** Faixa de identidade do aplicativo no login. */
@Composable
private fun Brand() {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.primary)
            .padding(horizontal = 16.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(44.dp).background(MaterialTheme.colorScheme.onPrimary, MaterialTheme.shapes.small),
            contentAlignment = Alignment.Center,
        ) { GlyphIcon(Glyph.Barcode, null, Modifier.size(28.dp), tint = MaterialTheme.colorScheme.primary) }
        Column {
            Text(APP_NAME, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onPrimary)
            Text(
                "Entre na sua loja",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f),
            )
        }
    }
}
