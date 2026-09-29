package br.com.estoque.core.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.unit.dp

/**
 * Pergunta de confirmação. O botão de confirmar recebe o foco ao abrir: o Enter confirma e o
 * Voltar/Esc desiste. Com [focusConfirm] falso, o conteúdo cuida do foco (ex.: um campo de motivo,
 * com [FocusOnOpen]). Sem [dismissLabel], é só um aviso com um botão.
 */
@Composable
fun ConfirmDialog(
    title: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    dismissLabel: String? = "Voltar",
    style: ActionStyle = ActionStyle.Primary,
    confirmEnabled: Boolean = true,
    confirmModifier: Modifier = Modifier,
    focusConfirm: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val confirmFocus = remember { FocusRequester() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp), content = content) },
        confirmButton = {
            ActionButton(
                confirmLabel,
                onConfirm,
                confirmModifier.focusRequester(confirmFocus).defaultAction(),
                style = style,
                enabled = confirmEnabled,
            )
            if (focusConfirm) FocusOnOpen(confirmFocus)
        },
        dismissButton = dismissLabel?.let { { ActionButton(it, onDismiss, style = ActionStyle.Quiet) } },
    )
}

/**
 * Leva o foco a [requester] quando o elemento aparece. Num diálogo, precisa ficar dentro do
 * conteúdo dele: o diálogo é outra janela, montada depois de quem o abriu.
 */
@Composable
fun FocusOnOpen(requester: FocusRequester) {
    LaunchedEffect(requester) { runCatching { requester.requestFocus() } }
}
