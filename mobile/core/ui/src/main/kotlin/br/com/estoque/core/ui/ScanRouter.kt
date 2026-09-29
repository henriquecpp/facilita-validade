package br.com.estoque.core.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier

/**
 * Entrega as leituras do leitor do aparelho (broadcast) e da câmera à tela visível. A tela mais
 * recente que registrou um tratador recebe a leitura; ao sair, o tratador anterior volta a valer.
 */
class ScanRouter {
    private val handlers = ArrayDeque<(String) -> Unit>()

    fun dispatch(code: String) {
        handlers.lastOrNull()?.invoke(code)
    }

    internal fun push(handler: (String) -> Unit) = handlers.addLast(handler)

    internal fun remove(handler: (String) -> Unit) {
        handlers.remove(handler)
    }
}

val LocalScanRouter = staticCompositionLocalOf { ScanRouter() }

@Composable
fun HandleScans(onScan: (String) -> Unit) {
    val router = LocalScanRouter.current
    val current by rememberUpdatedState(onScan)
    DisposableEffect(router) {
        val handler: (String) -> Unit = { current(it) }
        router.push(handler)
        onDispose { router.remove(handler) }
    }
}

/** Dica curta das teclas da tela, para quem opera pelo teclado do coletor. */
@Composable
fun KeyHint(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
}
