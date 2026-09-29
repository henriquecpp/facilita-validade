package br.com.estoque.core.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Cores de apoio fora do esquema do Material.
 *
 * O foco é âmbar: no coletor a operação é pelo teclado físico, e o elemento que vai receber o
 * Enter precisa saltar aos olhos tanto sobre o verde-petróleo dos botões quanto sobre o branco.
 */
object Tones {
    val Brand = Color(0xFF0E5A61)
    val BrandDark = Color(0xFF09434A)
    val Focus = Color(0xFFFFB300)
    val FocusedField = Color(0xFFEAF5F6)
    val Success = Color(0xFF1B6B33)
    val SuccessContainer = Color(0xFFDDF1E2)
    val OnSuccessContainer = Color(0xFF0B3A19)
    val Warning = Color(0xFF8A5300)
    val WarningContainer = Color(0xFFFFEFC7)
    val OnWarningContainer = Color(0xFF452A00)
    val Badge = Color(0xFFD32F2F)
}

private val Ink = Color(0xFF151C1D)

// Tema claro só: o coletor trabalha sob a luz da loja, e o contraste alto vale mais que um tema escuro.
private val Colors =
    lightColorScheme(
        primary = Tones.Brand,
        onPrimary = Color.White,
        primaryContainer = Color(0xFFD5ECEE),
        onPrimaryContainer = Color(0xFF00363B),
        inversePrimary = Color(0xFF7FD3DB),
        secondary = Color(0xFF4A6366),
        onSecondary = Color.White,
        secondaryContainer = Color(0xFFE3ECED),
        onSecondaryContainer = Color(0xFF1B2B2D),
        tertiary = Color(0xFF4A6366),
        onTertiary = Color.White,
        tertiaryContainer = Color(0xFFE3ECED),
        onTertiaryContainer = Color(0xFF1B2B2D),
        background = Color(0xFFF2F5F5),
        onBackground = Ink,
        surface = Color.White,
        onSurface = Ink,
        surfaceVariant = Color(0xFFE8EEEE),
        onSurfaceVariant = Color(0xFF465253),
        surfaceTint = Tones.Brand,
        inverseSurface = Color(0xFF263031),
        inverseOnSurface = Color(0xFFEEF3F3),
        error = Color(0xFFB3261E),
        onError = Color.White,
        errorContainer = Color(0xFFFCE4E1),
        onErrorContainer = Color(0xFF5C1410),
        outline = Color(0xFF7B8889),
        outlineVariant = Color(0xFFD3DCDD),
        scrim = Color.Black,
        surfaceBright = Color.White,
        surfaceDim = Color(0xFFD8E0E0),
        surfaceContainerLowest = Color.White,
        surfaceContainerLow = Color(0xFFF7F9F9),
        surfaceContainer = Color(0xFFF1F4F4),
        // Diálogos usam este papel: brancos, como o resto da interface.
        surfaceContainerHigh = Color.White,
        surfaceContainerHighest = Color(0xFFE6ECEC),
    )

private val Type =
    Typography().let { base ->
        base.copy(
            headlineMedium = base.headlineMedium.copy(fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold),
            headlineSmall = base.headlineSmall.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
            titleLarge = base.titleLarge.copy(fontSize = 19.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
            titleMedium = base.titleMedium.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
            titleSmall = base.titleSmall.copy(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
            bodyLarge = base.bodyLarge.copy(fontSize = 16.sp, lineHeight = 22.sp, letterSpacing = 0.2.sp),
            bodyMedium = base.bodyMedium.copy(fontSize = 14.sp, lineHeight = 19.sp),
            bodySmall = base.bodySmall.copy(fontSize = 12.5.sp, lineHeight = 17.sp),
            labelLarge = base.labelLarge.copy(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
            labelMedium = base.labelMedium.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
            labelSmall = base.labelSmall.copy(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp),
        )
    }

private val AppShapes =
    Shapes(
        extraSmall = RoundedCornerShape(6.dp),
        small = RoundedCornerShape(8.dp),
        medium = RoundedCornerShape(12.dp),
        large = RoundedCornerShape(16.dp),
        extraLarge = RoundedCornerShape(18.dp),
    )

/** Tema do aplicativo, desenhado para os 320 dp de largura do coletor e para leitura rápida. */
@Composable
fun EstoqueTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Colors, typography = Type, shapes = AppShapes, content = content)
}
