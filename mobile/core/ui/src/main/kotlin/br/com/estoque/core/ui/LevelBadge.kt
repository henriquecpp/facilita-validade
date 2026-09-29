package br.com.estoque.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.dp
import br.com.estoque.core.domain.UrgencyLevel

/** Cinza da faixa sem nível, o mesmo do painel. */
private val NoLevel = Color(0xFF9E9E9E)

/** `#rrggbb` → cor; texto fora do formato fica nulo. */
fun parseLevelColor(hex: String?): Color? {
    val value = hex?.trim()?.removePrefix("#") ?: return null
    if (value.length != 6) return null
    return value.toLongOrNull(16)?.let { Color(0xFF000000 or it) }
}

/** Cor do nível que a loja escolheu: a faixa da lista, o ponto da aba e o selo usam a mesma. */
fun levelColor(level: UrgencyLevel?): Color = parseLevelColor(level?.color) ?: NoLevel

/** Cor de texto do nível sobre fundo branco: a mesma cor escurecida, para dar contraste. */
fun levelTextColor(level: UrgencyLevel?): Color {
    val color = levelColor(level)
    return lerp(color, Color.Black, if (color.luminance() > 0.35f) 0.45f else 0.15f)
}

/** Selo com o nome do nível, na cor dele; o texto fica preto ou branco conforme o fundo. */
@Composable
fun LevelBadge(
    level: UrgencyLevel?,
    modifier: Modifier = Modifier,
    text: String = level?.name ?: "Sem nível",
) {
    val background = levelColor(level)
    Text(
        text,
        color = if (background.luminance() > 0.5f) Color(0xFF1F1F1F) else Color.White,
        style = MaterialTheme.typography.labelMedium,
        modifier = modifier.background(background, MaterialTheme.shapes.extraSmall).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
