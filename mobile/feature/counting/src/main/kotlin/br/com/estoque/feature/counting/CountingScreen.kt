package br.com.estoque.feature.counting

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.estoque.core.domain.CountLine
import br.com.estoque.core.domain.CountSession
import br.com.estoque.core.domain.ExpiryDate
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.AppTextField
import br.com.estoque.core.ui.BarTextAction
import br.com.estoque.core.ui.ConfirmDialog
import br.com.estoque.core.ui.ExpiryDateField
import br.com.estoque.core.ui.FocusOnOpen
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.IconAction
import br.com.estoque.core.ui.KeyHint
import br.com.estoque.core.ui.ListRow
import br.com.estoque.core.ui.SectionLabel
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import br.com.estoque.core.ui.appFieldColors
import br.com.estoque.core.ui.defaultAction
import br.com.estoque.core.ui.formStep
import br.com.estoque.core.ui.rememberScanGuard

private const val DEFAULT_REASON = "Cancelada no coletor"

private fun lineText(line: CountLine) = ExpiryDate.format(line.expiresOn) + (line.lotCode?.let { " · lote $it" } ?: "")

/**
 * Contagem completa do produto. As linhas contadas ficam no alto; abaixo, o formulário da próxima
 * linha; no rodapé, concluir. Cancelar fica na barra superior, longe do caminho do Enter.
 */
@Composable
fun CountingScreen(
    viewModel: CountingViewModel,
    onFinished: (CountSession) -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val focus = LocalFocusManager.current
    val haptics = LocalHapticFeedback.current
    val quantityFocus = remember { FocusRequester() }
    val expiryFocus = remember { FocusRequester() }
    val lotFocus = remember { FocusRequester() }
    val finishFocus = remember { FocusRequester() }
    val retryFocus = remember { FocusRequester() }
    val form = state.form
    var ignoredScan by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<CountLine?>(null) }
    val onScan: (String) -> Unit = { ignoredScan = it }
    HandleScans(onScan)
    val guard = rememberScanGuard(onScan)
    val leave = { if (viewModel.leave()) onBack() }
    BackHandler { leave() }
    LaunchedEffect(state.finished) { state.finished?.let(onFinished) }
    // Foco na quantidade ao abrir e a cada linha salva. A contagem chegar do servidor não move o
    // foco: quem já começou a digitar continua de onde está.
    LaunchedEffect(state.saved) {
        if (state.saved > 0) haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        runCatching { quantityFocus.requestFocus() }
    }
    LaunchedEffect(state.uncertain) { if (state.uncertain) runCatching { retryFocus.requestFocus() } }
    LaunchedEffect(state.focusRequest) {
        if (state.focusRequest > 0) {
            when (state.errorField) {
                CountingViewModel.Field.EXPIRY -> expiryFocus
                CountingViewModel.Field.LOT -> lotFocus
                else -> quantityFocus
            }.let { runCatching { it.requestFocus() } }
        }
    }
    // Durante um envio os campos ficam só leitura, sem perder o foco; travados, só sem confirmação.
    val locked = state.uncertain || state.count == null
    // Enquanto a contagem abre no servidor já dá para digitar a primeira linha: o leitor e o
    // operador são mais rápidos que a rede, e tecla em campo travado se perde.
    val opening = state.busy && state.count == null
    val fieldsEnabled = !locked || (opening && !state.uncertain)
    val sending = state.busy && state.count != null
    val lines = state.count?.lines.orEmpty()
    AppScreen(
        title = "Contagem",
        onBack = leave,
        busy = state.busy,
        actions = {
            if (state.count != null && !state.uncertain) BarTextAction("Cancelar", { viewModel.requestCancel() }, enabled = !locked)
        },
        bottomBar = {
            if (state.uncertain) {
                ActionButton(
                    "Enviar de novo",
                    { viewModel.retry() },
                    Modifier.fillMaxWidth().focusRequester(retryFocus).defaultAction(),
                    glyph = Glyph.Refresh,
                )
            } else {
                ActionButton(
                    "Concluir contagem · ${state.total} un.",
                    { viewModel.requestConfirm() },
                    Modifier.fillMaxWidth().focusRequester(finishFocus).testTag("finish"),
                    glyph = Glyph.Check,
                    enabled = !locked,
                )
            }
        },
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                viewModel.product.description,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            KeyHint("Conte todas as unidades, em todos os locais da loja.")
            AppTextField(
                value = form.quantity,
                onValueChange = { value -> viewModel.update(form.copy(quantity = value.filter { it in '0'..'9' })) },
                label = "Quantidade desta validade",
                suffix = "un.",
                enabled = fieldsEnabled,
                readOnly = sending,
                isError = state.errorField == CountingViewModel.Field.QUANTITY,
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
                enabled = fieldsEnabled,
                readOnly = sending,
                warning = state.warning,
                error = if (state.errorField == CountingViewModel.Field.EXPIRY) state.error else null,
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
                enabled = fieldsEnabled,
                readOnly = sending,
                isError = state.errorField == CountingViewModel.Field.LOT,
                // A seta/Tab continua levando ao botão fixo, mesmo com o histórico abaixo.
                modifier =
                    Modifier.fillMaxWidth().focusRequester(lotFocus).focusProperties { next = finishFocus }.testTag("lot").formStep(
                        focus,
                        onSubmit = { viewModel.addLine() },
                        scanGuard = guard,
                        value = form.lot,
                        restore = { viewModel.update(form.copy(lot = it)) },
                    ),
            )
            state.error?.takeIf { state.errorField != CountingViewModel.Field.EXPIRY }?.let {
                StatusBanner(it, if (state.uncertain) Tone.Warning else Tone.Error)
            }
            state.notice?.let { StatusBanner(it, Tone.Success) }
            ignoredScan?.let {
                StatusBanner("Leitura de $it ignorada: conclua ou cancele a contagem antes de ler outro produto.", Tone.Warning)
            }
            KeyHint("Enter no lote salva a linha.")
            // O histórico fica depois dos campos: cada nova validade continua perto do topo,
            // mesmo quando já há muitas linhas contadas no produto.
            SectionLabel(
                "Contado",
                Modifier.padding(top = 4.dp),
                trailing = "${state.total} un. · ${lines.size} ${if (lines.size == 1) "linha" else "linhas"}",
            )
            if (lines.isNotEmpty()) {
                val shape = MaterialTheme.shapes.medium
                Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)) {
                    lines.forEachIndexed { index, line ->
                        if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        LineRow(line, enabled = !locked) { removing = line }
                    }
                }
            }
        }
    }
    if (state.confirming) ConfirmCountDialog(state.total, viewModel::confirm, viewModel::dismissDialogs)
    if (state.cancelling) CancelDialog(viewModel::cancel, viewModel::dismissDialogs)
    removing?.let { line ->
        ConfirmDialog(
            title = "Remover esta linha?",
            confirmLabel = "Remover",
            onConfirm = {
                removing = null
                viewModel.removeLine(line.id)
            },
            onDismiss = { removing = null },
            style = ActionStyle.Danger,
        ) { Text("${lineText(line)}: ${line.quantity} un.") }
    }
}

@Composable
private fun LineRow(
    line: CountLine,
    enabled: Boolean,
    onRemove: () -> Unit,
) {
    ListRow(onClick = null) {
        Text(lineText(line), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text("${line.quantity} un.", style = MaterialTheme.typography.titleSmall)
        IconAction(
            Glyph.Delete,
            "Remover a linha ${lineText(line)}",
            onRemove,
            enabled = enabled,
            tint = MaterialTheme.colorScheme.error,
        )
    }
}

@Composable
private fun ConfirmCountDialog(
    total: Long,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    ConfirmDialog(
        title = "Concluir a contagem?",
        confirmLabel = if (total == 0L) "Confirmar: nenhuma unidade" else "Confirmar",
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        confirmModifier = Modifier.testTag("confirm"),
    ) {
        if (total == 0L) {
            Text("Nenhuma validade foi informada: confirme que não há nenhuma unidade deste produto na loja.")
        } else {
            Text("O saldo do produto passa a ser")
            Text("$total un.", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
            Text("conforme as linhas contadas. Não soma ao saldo anterior.")
        }
    }
}

@Composable
private fun CancelDialog(
    onCancel: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    // Motivo padrão já selecionado: Enter aceita, e digitar o substitui sem apagar antes.
    var field by rememberSaveable(stateSaver = TextFieldValue.Saver) {
        mutableStateOf(TextFieldValue(DEFAULT_REASON, TextRange(0, DEFAULT_REASON.length)))
    }
    val reason = field.text
    val reasonFocus = remember { FocusRequester() }
    val valid = reason.trim().length >= 3
    ConfirmDialog(
        title = "Cancelar a contagem?",
        confirmLabel = "Cancelar contagem",
        onConfirm = { if (valid) onCancel(reason) },
        onDismiss = onDismiss,
        dismissLabel = "Continuar contando",
        style = ActionStyle.Danger,
        confirmEnabled = valid,
        focusConfirm = false,
    ) {
        // Dentro do diálogo: ele é outra janela, com foco próprio.
        val focus = LocalFocusManager.current
        Text("As linhas são descartadas e o saldo anterior do produto é mantido.")
        OutlinedTextField(
            value = field,
            onValueChange = { field = it },
            label = { Text("Motivo") },
            singleLine = true,
            isError = !valid,
            supportingText = if (valid) null else ({ Text("Escreva ao menos 3 letras.") }),
            shape = MaterialTheme.shapes.small,
            colors = appFieldColors(),
            modifier =
                Modifier.fillMaxWidth().focusRequester(reasonFocus).formStep(focus, onSubmit = {
                    if (valid) onCancel(reason)
                }),
        )
        FocusOnOpen(reasonFocus)
    }
}
