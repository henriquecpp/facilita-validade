package br.com.estoque.core.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import br.com.estoque.core.domain.ScanBurstDetector

/**
 * Leituras de um leitor em modo teclado que chegam a um campo que não é o de código (quantidade,
 * data, lote): o campo volta ao valor de antes da leitura e o código é entregue a [onScan].
 */
@Stable
class ScanGuard internal constructor(
    private val onScan: (String) -> Unit,
) {
    private val detector = ScanBurstDetector()
    private var snapshot: String? = null

    internal fun onCharacter(
        char: Char,
        atMillis: Long,
        current: String,
    ) {
        if (detector.onCharacter(char, atMillis)) snapshot = current
    }

    internal fun onEnter(
        atMillis: Long,
        restore: (String) -> Unit,
    ): Boolean {
        val code = detector.onEnter(atMillis) ?: return false
        snapshot?.let(restore)
        snapshot = null
        onScan(code)
        return true
    }
}

@Composable
fun rememberScanGuard(onScan: (String) -> Unit): ScanGuard {
    val current by rememberUpdatedState(onScan)
    return remember { ScanGuard { current(it) } }
}

/**
 * Formulário pelo teclado físico: Enter, Tab e seta para baixo avançam; Shift+Tab e seta para
 * cima voltam; Enter no último campo executa [onSubmit]. As setas valem porque nem todo coletor
 * tem Tab. Com [scanGuard], uma leitura do leitor não fica neste campo.
 */
fun Modifier.formStep(
    focusManager: FocusManager,
    onSubmit: (() -> Unit)? = null,
    scanGuard: ScanGuard? = null,
    value: String = "",
    restore: (String) -> Unit = {},
): Modifier =
    onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
        val at = event.nativeKeyEvent.eventTime
        when (event.key) {
            Key.Enter, Key.NumPadEnter -> {
                if (scanGuard?.onEnter(at, restore) != true) {
                    if (onSubmit != null) onSubmit() else focusManager.moveFocus(FocusDirection.Next)
                }
                true
            }
            Key.Tab -> {
                focusManager.moveFocus(if (event.isShiftPressed) FocusDirection.Previous else FocusDirection.Next)
                true
            }
            Key.DirectionDown -> focusManager.moveFocus(FocusDirection.Next)
            Key.DirectionUp -> focusManager.moveFocus(FocusDirection.Previous)
            else -> {
                val code = event.utf16CodePoint
                if (scanGuard != null && code > 0 && !Character.isISOControl(code)) {
                    scanGuard.onCharacter(code.toChar(), at, value)
                }
                false
            }
        }
    }
