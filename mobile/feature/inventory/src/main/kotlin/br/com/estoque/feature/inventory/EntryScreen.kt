package br.com.estoque.feature.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.AppTextField
import br.com.estoque.core.ui.ExpiryDateField
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import br.com.estoque.core.ui.defaultAction
import br.com.estoque.core.ui.formStep
import br.com.estoque.core.ui.rememberScanGuard

/**
 * Mercadoria que chegou: quantidade, validade, lote e observação, só com o teclado; Enter na
 * observação registra. O botão de registrar fica fixo no rodapé, visível sem rolar.
 */
@Composable
fun EntryScreen(
    viewModel: EntryViewModel,
    onOpenBarcode: (String) -> Unit,
    onBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val submitFocus = remember { FocusRequester() }
    AppScreen(
        title = "Nova entrada",
        onBack = onBack,
        busy = state.busy,
        bottomBar = { SubmitEntry(viewModel, submitFocus) },
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            EntryForm(viewModel, onOpenBarcode, submitFocus)
        }
    }
}

/** Botão do rodapé: registra, ou reenvia o mesmo comando quando a resposta não chegou. */
@Composable
internal fun SubmitEntry(
    viewModel: EntryViewModel,
    focus: FocusRequester,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    ActionButton(
        if (state.uncertain) "Enviar de novo" else "Registrar entrada",
        { viewModel.submit() },
        Modifier
            .fillMaxWidth()
            .focusRequester(focus)
            .defaultAction()
            .testTag("submit"),
        glyph = if (state.uncertain) Glyph.Refresh else Glyph.Check,
    )
}

/**
 * Os campos da entrada, usados na tela de nova entrada e no lançamento rápido. Uma leitura de
 * outro produto com o formulário vazio vai para [onOpenBarcode]; com dados digitados, só avisa.
 */
@Composable
internal fun EntryForm(
    viewModel: EntryViewModel,
    onOpenBarcode: (String) -> Unit,
    submitFocus: FocusRequester,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val focus = LocalFocusManager.current
    val haptics = LocalHapticFeedback.current
    val quantityFocus = remember { FocusRequester() }
    val expiryFocus = remember { FocusRequester() }
    val lotFocus = remember { FocusRequester() }
    val noteFocus = remember { FocusRequester() }
    val form = state.form
    var blockedScan by remember { mutableStateOf<String?>(null) }
    val onScan: (String) -> Unit = { code ->
        if (viewModel.state.value.form.isEmpty && !viewModel.state.value.uncertain) {
            onOpenBarcode(code)
        } else {
            blockedScan = code
        }
    }
    HandleScans(onScan)
    val guard = rememberScanGuard(onScan)
    LaunchedEffect(state.saved) {
        blockedScan = null
        if (state.saved > 0) haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        quantityFocus.requestFocus()
    }
    LaunchedEffect(state.focusRequest) {
        if (state.focusRequest > 0) {
            when (state.errorField) {
                EntryViewModel.Field.QUANTITY -> quantityFocus
                EntryViewModel.Field.EXPIRY -> expiryFocus
                EntryViewModel.Field.LOT -> lotFocus
                EntryViewModel.Field.NOTE -> noteFocus
                null -> null
            }?.requestFocus()
        }
    }
    // Sem confirmação do servidor, os campos travam e o Enter no botão reenvia o mesmo comando.
    LaunchedEffect(state.uncertain) { if (state.uncertain) runCatching { submitFocus.requestFocus() } }
    Text(
        viewModel.product.description,
        style = MaterialTheme.typography.titleMedium,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
    state.notice?.let { StatusBanner(it, Tone.Success) }
    blockedScan?.let {
        StatusBanner("Leitura de $it ignorada: registre ou apague esta entrada antes de ler outro produto.", Tone.Warning)
    }
    AppTextField(
        value = form.quantity,
        onValueChange = { value -> viewModel.update(form.copy(quantity = value.filter { it in '0'..'9' })) },
        label = "Quantidade recebida",
        suffix = "un.",
        enabled = !state.uncertain,
        readOnly = state.busy,
        isError = state.errorField == EntryViewModel.Field.QUANTITY,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier =
            Modifier.fillMaxWidth().focusRequester(quantityFocus).testTag("quantity").formStep(
                focus,
                onSubmit = { if (viewModel.checkQuantity()) expiryFocus.requestFocus() },
                scanGuard = guard,
                value = form.quantity,
                restore = { viewModel.update(form.copy(quantity = it)) },
            ),
    )
    ExpiryDateField(
        value = form.expiry,
        onValueChange = { viewModel.update(form.copy(expiry = it)) },
        enabled = !state.uncertain,
        readOnly = state.busy,
        warning = state.warning,
        error = if (state.errorField == EntryViewModel.Field.EXPIRY) state.error else null,
        modifier =
            Modifier.fillMaxWidth().focusRequester(expiryFocus).testTag("expiry").formStep(
                focus,
                onSubmit = { if (viewModel.checkExpiry()) lotFocus.requestFocus() },
                scanGuard = guard,
                value = form.expiry,
                restore = { viewModel.update(form.copy(expiry = it)) },
            ),
    )
    AppTextField(
        value = form.lot,
        onValueChange = { viewModel.update(form.copy(lot = it)) },
        label = "Lote (opcional)",
        enabled = !state.uncertain,
        readOnly = state.busy,
        isError = state.errorField == EntryViewModel.Field.LOT,
        modifier =
            Modifier.fillMaxWidth().focusRequester(lotFocus).testTag("lot").formStep(
                focus,
                onSubmit = { noteFocus.requestFocus() },
                scanGuard = guard,
                value = form.lot,
                restore = { viewModel.update(form.copy(lot = it)) },
            ),
    )
    AppTextField(
        value = form.note,
        onValueChange = { viewModel.update(form.copy(note = it)) },
        label = "Observação (opcional)",
        enabled = !state.uncertain,
        readOnly = state.busy,
        isError = state.errorField == EntryViewModel.Field.NOTE,
        modifier =
            Modifier.fillMaxWidth().focusRequester(noteFocus).testTag("note").formStep(
                focus,
                onSubmit = { viewModel.submit() },
                scanGuard = guard,
                value = form.note,
                restore = { viewModel.update(form.copy(note = it)) },
            ),
    )
    // Erro da validade aparece no próprio campo; os demais, aqui.
    state.error?.takeIf { state.errorField != EntryViewModel.Field.EXPIRY }?.let {
        // Sem confirmação não é recusa: os dados estão guardados e o reenvio não duplica.
        StatusBanner(it, if (state.uncertain) Tone.Warning else Tone.Error)
    }
}
