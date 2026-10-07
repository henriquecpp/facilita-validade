package br.com.estoque.feature.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.input.rememberTextFieldState
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.Product
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.ScanField
import br.com.estoque.core.ui.SectionLabel
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import br.com.estoque.core.ui.redirectTypingTo

/**
 * Lançamento rápido (AV19): no laticínios há muito produto pequeno, e o operador bipa, informa a
 * quantidade e a data e já vai para o próximo, sem olhar a tela do produto. O formulário é o da
 * nova entrada; salvar volta para a leitura.
 */
@Composable
fun QuickEntryScreen(
    viewModel: QuickEntryViewModel,
    repository: InventoryPort,
    today: () -> String,
    onInitialCount: (Product) -> Unit,
    onCamera: () -> Unit,
    onSearch: (String) -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val product = state.product
    LaunchedEffect(state.initialCount) {
        state.initialCount?.let {
            viewModel.initialCountOpened()
            onInitialCount(it)
        }
    }
    if (product == null) {
        ScanStep(viewModel, onCamera, onSearch, onBack)
    } else {
        // Um modelo de entrada por leitura: cada produto lido começa com o formulário vazio.
        val entry: EntryViewModel =
            viewModel(key = "quick-entry:${state.scans}") { EntryViewModel(repository, product, today) }
        val entryState by entry.state.collectAsStateWithLifecycle()
        val submitFocus = remember { FocusRequester() }
        // Entrada registrada: volta para a leitura do próximo, com o resumo do que foi lançado.
        LaunchedEffect(entryState.saved) {
            if (entryState.saved >
                0
            ) {
                viewModel.saved("${product.description}: ${entryState.notice.orEmpty().removePrefix("Entrada registrada: ")}")
            }
        }
        AppScreen(
            title = "Lançamento rápido",
            onBack = { viewModel.clear() },
            busy = entryState.busy,
            bottomBar = {
                SubmitEntry(entry, submitFocus)
                ActionButton("Trocar de produto", { viewModel.clear() }, Modifier.fillMaxWidth(), style = ActionStyle.Quiet)
            },
        ) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                // Outro produto lido com o formulário vazio troca o produto, sem sair do lançamento.
                EntryForm(entry, onOpenBarcode = viewModel::scan, submitFocus = submitFocus)
            }
        }
    }
}

/**
 * Esperando a leitura: o campo já tem o foco, com a câmera e a pesquisa à mão. O campo aceita o
 * código ou o nome: o nome abre a pesquisa já com ele.
 */
@Composable
private fun ScanStep(
    viewModel: QuickEntryViewModel,
    onCamera: () -> Unit,
    onSearch: (String) -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val code = rememberTextFieldState()
    val scanFocus = remember { FocusRequester() }
    var scanFocused by remember { mutableStateOf(false) }
    HandleScans(viewModel::scan)
    LaunchedEffect(Unit) { runCatching { scanFocus.requestFocus() } }
    AppScreen(
        title = "Lançamento rápido",
        onBack = onBack,
        busy = state.busy,
        modifier = Modifier.redirectTypingTo(code, scanFocus) { scanFocused },
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ScanField(
                state = code,
                onScan = viewModel::scan,
                focusRequester = scanFocus,
                label = "Leia o código ou digite o nome",
                onCamera = onCamera,
                onSearch = onSearch,
                modifier = Modifier.fillMaxWidth().onFocusChanged { scanFocused = it.isFocused }.testTag("scan"),
            )
            state.error?.let { StatusBanner(it, Tone.Error) }
            state.notice?.let { StatusBanner("Registrado: $it", Tone.Success) }
            if (state.recent.size > 1) {
                SectionLabel("Lançados agora")
                state.recent.drop(1).forEach {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}
