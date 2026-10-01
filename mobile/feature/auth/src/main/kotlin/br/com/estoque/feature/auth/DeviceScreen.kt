package br.com.estoque.feature.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.estoque.core.domain.BarcodeRead
import br.com.estoque.core.domain.DevicePreferences
import br.com.estoque.core.domain.ScanSource
import br.com.estoque.core.domain.ScannerMode
import br.com.estoque.core.domain.ScannerPresets
import br.com.estoque.core.domain.ScannerSettings
import br.com.estoque.core.domain.Session
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.AppTextField
import br.com.estoque.core.ui.ConfirmDialog
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.KeyHint
import br.com.estoque.core.ui.ScanField
import br.com.estoque.core.ui.SectionLabel
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import br.com.estoque.core.ui.Tones
import br.com.estoque.core.ui.formStep
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Configuração do leitor deste aparelho. Um coletor novo costuma exigir só esta configuração. */
class DeviceViewModel(
    private val preferences: DevicePreferences,
    private val onScannerChanged: () -> Unit,
) : ViewModel() {
    data class State(
        val settings: ScannerSettings,
        val saved: Boolean = false,
        val lastRead: BarcodeRead? = null,
    )

    private val mutable = MutableStateFlow(State(preferences.scannerSettings()))
    val state = mutable.asStateFlow()

    fun change(settings: ScannerSettings) = mutable.update { it.copy(settings = settings, saved = false) }

    fun save() {
        val settings = mutable.value.settings
        if (!settings.isComplete) return
        preferences.saveScannerSettings(settings)
        onScannerChanged()
        mutable.update { it.copy(saved = true) }
    }

    fun onRead(read: BarcodeRead) = mutable.update { it.copy(lastRead = read) }
}

/** Sessão e leitor do aparelho: o que o suporte pergunta primeiro e o que se ajusta uma vez. */
@Composable
fun DeviceScreen(
    viewModel: DeviceViewModel,
    session: Session,
    appVersion: String,
    onChangePassword: () -> Unit,
    onLogout: () -> Unit,
    onBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val settings = state.settings
    val focus = LocalFocusManager.current
    val testCode = rememberTextFieldState()
    val testFocus = remember { FocusRequester() }
    var confirmLogout by remember { mutableStateOf(false) }
    HandleScans { viewModel.onRead(BarcodeRead(it, ScanSource.DEVICE)) }
    val preset = ScannerPresets.all.firstOrNull { it.action == settings.action && it.extra == settings.extra }
    var custom by remember { mutableStateOf(settings.mode == ScannerMode.BROADCAST && preset == null) }
    AppScreen(title = "Aparelho", onBack = onBack) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SectionLabel("Sessão")
            Bordered {
                Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(session.store.name, style = MaterialTheme.typography.titleSmall)
                    Text("Usuário ${session.user.username}", style = MaterialTheme.typography.bodyMedium)
                    // A versão é o que o suporte pergunta primeiro.
                    Text(
                        "Versão $appVersion",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ActionButton("Trocar senha", onChangePassword, Modifier.weight(1f), style = ActionStyle.Secondary)
                ActionButton("Sair", { confirmLogout = true }, Modifier.weight(1f), style = ActionStyle.Danger, glyph = Glyph.Logout)
            }
            SectionLabel("Leitor de código de barras", Modifier.padding(top = 8.dp))
            Bordered {
                Option("Teclado: o leitor digita o código e tecla Enter", settings.mode == ScannerMode.KEYBOARD) {
                    custom = false
                    viewModel.change(ScannerSettings())
                }
                ScannerPresets.all.forEach { option ->
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Option("Intent: ${option.label}", settings.mode == ScannerMode.BROADCAST && !custom && preset == option) {
                        custom = false
                        viewModel.change(ScannerSettings(ScannerMode.BROADCAST, option.action, option.extra))
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Option("Intent personalizado (ação e extra do manual)", settings.mode == ScannerMode.BROADCAST && custom) {
                    custom = true
                    viewModel.change(settings.copy(mode = ScannerMode.BROADCAST))
                }
            }
            if (settings.mode == ScannerMode.BROADCAST) {
                preset?.takeIf { !custom }?.let { KeyHint(it.hint) }
                AppTextField(
                    value = settings.action,
                    onValueChange = { viewModel.change(settings.copy(action = it.trim())) },
                    label = "Ação do Intent",
                    enabled = custom,
                    modifier = Modifier.fillMaxWidth().formStep(focus),
                )
                AppTextField(
                    value = settings.extra,
                    onValueChange = { viewModel.change(settings.copy(extra = it.trim())) },
                    label = "Extra com o código",
                    enabled = custom,
                    modifier = Modifier.fillMaxWidth().formStep(focus, onSubmit = { viewModel.save() }),
                )
            }
            ActionButton("Salvar leitor", { viewModel.save() }, Modifier.fillMaxWidth(), glyph = Glyph.Check, enabled = settings.isComplete)
            if (state.saved) StatusBanner("Leitor salvo. As próximas leituras já usam este modo.", Tone.Success)
            SectionLabel("Teste de leitura", Modifier.padding(top = 8.dp))
            KeyHint("Leia qualquer código: no modo teclado ele aparece no campo; no modo Intent, logo abaixo.")
            ScanField(
                state = testCode,
                onScan = { viewModel.onRead(BarcodeRead(it, ScanSource.KEYBOARD)) },
                focusRequester = testFocus,
                label = "Campo de teste",
                modifier = Modifier.fillMaxWidth(),
            )
            state.lastRead?.let {
                val origin = if (it.source == ScanSource.DEVICE) "Intent do leitor" else "teclado"
                StatusBanner("Lido por $origin: ${it.value}", Tone.Info)
            }
        }
    }
    if (confirmLogout) {
        ConfirmDialog(
            title = "Sair da conta?",
            confirmLabel = "Sair",
            onConfirm = {
                confirmLogout = false
                onLogout()
            },
            onDismiss = { confirmLogout = false },
            style = ActionStyle.Danger,
        ) { Text("Para entrar de novo, leia o QR do painel ou informe CNPJ, usuário e senha.") }
    }
}

@Composable
private fun Bordered(content: @Composable ColumnScope.() -> Unit) {
    val shape = MaterialTheme.shapes.medium
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape),
        content = content,
    )
}

/** Opção do leitor: recebe foco pelas setas, e o Enter a escolhe. */
@Composable
private fun Option(
    label: String,
    selected: Boolean,
    onSelect: () -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (focused) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
            .then(if (focused) Modifier.border(3.dp, Tones.Focus) else Modifier)
            .selectable(selected, interactionSource = source, indication = ripple(), role = Role.RadioButton, onClick = onSelect)
            .padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, modifier = Modifier.padding(8.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(end = 8.dp))
    }
}
