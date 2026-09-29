package br.com.estoque.core.ui

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.placeCursorAtEnd
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import br.com.estoque.core.domain.BarcodeGate

private fun isLineBreak(char: Char) = char == '\n' || char == '\r'

/** Leitor que manda CR/LF junto do código: a quebra não entra no campo (o Enter já consulta). */
private val NoLineBreaks =
    InputTransformation {
        val text = asCharSequence()
        if (text.any(::isLineBreak)) replace(0, length, text.filterNot(::isLineBreak))
    }

/**
 * Campo do código de barras: recebe o leitor em modo teclado ou a digitação. Enter consulta;
 * leituras repetidas em menos de um segundo são ignoradas (não somam quantidade). As setas saem
 * do campo, rumo à lista e aos botões. Os ícones são só para o toque (AV24): à esquerda, a câmera,
 * para o código que o leitor não pega; à direita, a lupa, que pesquisa pela descrição — para o
 * código manchado ou o produto sem código.
 *
 * Com [onSearch], o campo também aceita o nome: o que tem letra abre a pesquisa já com o texto, e
 * só dígitos (espaços ignorados) são um código. Sem [onSearch], todo texto é código.
 *
 * O texto fica num [TextFieldState] da tela, não numa String: a tecla que [redirectTypingTo]
 * traz de fora entra no mesmo buffer em que cai o resto da leitura, na hora e na ordem, sem
 * esperar a recomposição — o leitor digita mais rápido que um quadro.
 */
@Composable
fun ScanField(
    state: TextFieldState,
    onScan: (String) -> Unit,
    focusRequester: FocusRequester,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    label: String = "Leia ou digite o código",
    onCamera: (() -> Unit)? = null,
    onSearch: ((String) -> Unit)? = null,
) {
    val gate = remember { BarcodeGate() }
    val focusManager = LocalFocusManager.current
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val colors = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.small
    val submit: () -> Unit = {
        val text = state.text.toString().trim()
        val digits = text.filterNot(Char::isWhitespace)
        if (onSearch != null && digits.isNotEmpty() && digits.any { it !in '0'..'9' }) {
            state.clearText()
            onSearch(text)
        } else {
            gate.accept(if (digits.isNotEmpty() && digits.all { it in '0'..'9' }) digits else text, SystemClock.elapsedRealtime())?.let {
                state.clearText()
                onScan(it)
            }
        }
    }
    BasicTextField(
        state = state,
        enabled = enabled,
        inputTransformation = NoLineBreaks,
        lineLimits = TextFieldLineLimits.SingleLine,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface),
        cursorBrush = SolidColor(colors.primary),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Search),
        onKeyboardAction = { submit() },
        interactionSource = source,
        modifier =
            modifier.focusRequester(focusRequester).onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.Enter, Key.NumPadEnter -> {
                        submit()
                        true
                    }
                    Key.DirectionDown -> focusManager.moveFocus(FocusDirection.Next)
                    Key.DirectionUp -> focusManager.moveFocus(FocusDirection.Previous)
                    else -> false
                }
            },
        decorator = { inner ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clip(shape)
                    .background(if (focused) Tones.FocusedField else colors.surface)
                    .border(if (focused) 2.dp else 1.dp, if (focused) colors.primary else colors.outline, shape)
                    .padding(start = if (onCamera != null) 2.dp else 12.dp, end = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (onCamera != null) {
                    TouchIcon(Glyph.Camera, "Ler pela câmera", onCamera)
                } else {
                    GlyphIcon(Glyph.Barcode, null, Modifier.size(22.dp), tint = if (focused) colors.primary else colors.onSurfaceVariant)
                }
                Box(Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 12.dp)) {
                    if (state.text.isEmpty()) {
                        Text(
                            label,
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    inner()
                }
                when {
                    state.text.isNotEmpty() -> TouchIcon(Glyph.Forward, "Consultar o que foi digitado", submit)
                    onSearch != null -> TouchIcon(Glyph.Search, "Pesquisar pela descrição") { onSearch("") }
                }
            }
        },
    )
}

/** Ícone dentro de um campo, só para o toque: o teclado tem o Enter e o leitor. */
@Composable
private fun TouchIcon(
    glyph: Glyph,
    label: String,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, modifier = Modifier.focusProperties { canFocus = false }) {
        GlyphIcon(glyph, label, tint = MaterialTheme.colorScheme.primary)
    }
}

/**
 * Leitor em modo teclado numa tela sem campo de código, como a inicial: as teclas da leitura são
 * juntadas aqui, e o Enter que o leitor manda no fim entrega o código. Pausa de mais de um
 * segundo recomeça a leitura; Enter sem nada juntado segue para o botão em foco.
 */
@Composable
fun rememberKeyboardScans(onScan: (String) -> Unit): Modifier {
    val current by rememberUpdatedState(onScan)
    val gate = remember { BarcodeGate() }
    val buffer = remember { StringBuilder() }
    val last = remember { longArrayOf(0L) }
    return remember {
        Modifier.onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            val now = SystemClock.elapsedRealtime()
            if (now - last[0] > 1000) buffer.clear()
            last[0] = now
            if (event.key == Key.Enter || event.key == Key.NumPadEnter) {
                if (buffer.isEmpty()) return@onPreviewKeyEvent false
                val code = buffer.toString()
                buffer.clear()
                gate.accept(code, now)?.let { current(it) }
                return@onPreviewKeyEvent true
            }
            val code = event.utf16CodePoint
            if (code <= 0 || Character.isISOControl(code) || Character.isWhitespace(code)) return@onPreviewKeyEvent false
            buffer.append(code.toChar())
            true
        }
    }
}

/**
 * Em telas sem formulário, uma tecla imprimível com o foco fora do campo de código (numa linha
 * da lista, num botão) é levada ao campo: a leitura do leitor em modo teclado nunca se perde nem
 * aciona o item em foco. A tecla entra direto no [field], com o cursor no fim, e o foco vai para
 * o campo: as teclas seguintes da mesma leitura caem atrás dela.
 */
fun Modifier.redirectTypingTo(
    field: TextFieldState,
    target: FocusRequester,
    isTargetFocused: () -> Boolean,
): Modifier =
    onPreviewKeyEvent { event ->
        if (event.type != KeyEventType.KeyDown || isTargetFocused()) return@onPreviewKeyEvent false
        val code = event.utf16CodePoint
        if (code <= 0 || Character.isISOControl(code) || Character.isWhitespace(code)) return@onPreviewKeyEvent false
        field.edit {
            append(code.toChar().toString())
            placeCursorAtEnd()
        }
        target.requestFocus()
        true
    }
