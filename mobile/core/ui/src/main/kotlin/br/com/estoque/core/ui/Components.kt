package br.com.estoque.core.ui

import android.content.res.Configuration
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

/** Ícones do aplicativo, desenhados como vetores no próprio módulo, sem a biblioteca de ícones. */
enum class Glyph(
    internal val res: Int,
) {
    Back(R.drawable.ic_back),
    Forward(R.drawable.ic_forward),
    Barcode(R.drawable.ic_barcode),
    Camera(R.drawable.ic_camera),
    Bell(R.drawable.ic_bell),
    Settings(R.drawable.ic_settings),
    Refresh(R.drawable.ic_refresh),
    Add(R.drawable.ic_add),
    Check(R.drawable.ic_check),
    Close(R.drawable.ic_close),
    Warning(R.drawable.ic_warning),
    Error(R.drawable.ic_error),
    Info(R.drawable.ic_info),
    Done(R.drawable.ic_check_circle),
    Delete(R.drawable.ic_delete),
    History(R.drawable.ic_history),
    Logout(R.drawable.ic_logout),
    Qr(R.drawable.ic_qr),
    Count(R.drawable.ic_count),
    Lock(R.drawable.ic_lock),
    Chevron(R.drawable.ic_chevron_right),
    Calendar(R.drawable.ic_calendar),
    Search(R.drawable.ic_search),
    Remove(R.drawable.ic_remove),
    Quick(R.drawable.ic_bolt),
}

@Composable
fun GlyphIcon(
    glyph: Glyph,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = LocalContentColor.current,
) = Icon(painterResource(glyph.res), contentDescription, modifier, tint)

/**
 * Há teclado físico, como no coletor: a tela pode levar o foco a um campo sem que o teclado
 * virtual cubra metade dela. No celular, o foco automático fica só para os formulários.
 */
@Composable
fun hasPhysicalKeyboard(): Boolean = LocalConfiguration.current.keyboard != Configuration.KEYBOARD_NOKEYS

/**
 * Botões só aceitam foco no modo teclado. A ação padrão da tela é a exceção: recebe o foco ao
 * abrir, para que o Enter já a acione, mesmo que a última interação tenha sido um toque.
 */
fun Modifier.defaultAction(): Modifier = focusProperties { canFocus = true }

/**
 * Estrutura comum das telas: barra superior com título, faixa de progresso, conteúdo e, quando
 * houver, a ação principal fixa no rodapé, sempre visível sem rolar.
 */
@Composable
fun AppScreen(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    busy: Boolean = false,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        AppTopBar(title, subtitle, onBack, actions)
        BusyBar(busy)
        Column(Modifier.weight(1f).fillMaxWidth(), content = content)
        if (bottomBar != null) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                content = bottomBar,
            )
        }
    }
}

@Composable
fun AppTopBar(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.primary)
            .heightIn(min = 52.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CompositionLocalProvider(LocalContentColor provides colors.onPrimary) {
            if (onBack != null) {
                // Para o toque. No teclado, Voltar/Esc fazem o mesmo, e o foco não para aqui.
                IconAction(Glyph.Back, "Voltar", onBack, keyboard = false)
            } else {
                Spacer(Modifier.width(8.dp))
            }
            Column(Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 6.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitle?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onPrimary.copy(alpha = 0.82f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            actions()
        }
    }
}

/**
 * Ação só com ícone, na barra superior ou numa linha. [badge] mostra uma contagem, como alertas
 * não lidos; com [keyboard] falso, a ação fica fora da navegação pelo teclado.
 */
@Composable
fun IconAction(
    glyph: Glyph,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    badge: Long = 0,
    enabled: Boolean = true,
    keyboard: Boolean = true,
    tint: Color = LocalContentColor.current,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    Box(
        modifier
            .size(44.dp)
            .then(if (keyboard) Modifier else Modifier.focusProperties { canFocus = false })
            .clip(CircleShape)
            .then(if (focused) Modifier.border(3.dp, Tones.Focus, CircleShape) else Modifier)
            .clickable(interactionSource = source, indication = ripple(), enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        GlyphIcon(glyph, null, Modifier.size(24.dp), tint = tint.copy(alpha = if (enabled) 1f else 0.45f))
        if (badge > 0) {
            Text(
                if (badge > 99) "99+" else badge.toString(),
                color = Color.White,
                style = MaterialTheme.typography.labelSmall,
                modifier =
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 3.dp, end = 1.dp)
                        .background(Tones.Badge, CircleShape)
                        .padding(horizontal = 5.dp, vertical = 1.dp),
            )
        }
    }
}

/** Ação em texto na barra superior, para o que não tem ícone óbvio. */
@Composable
fun BarTextAction(
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val shape = MaterialTheme.shapes.small
    Box(
        Modifier
            .heightIn(min = 40.dp)
            .clip(shape)
            .then(if (focused) Modifier.border(3.dp, Tones.Focus, shape) else Modifier)
            .clickable(interactionSource = source, indication = ripple(), enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = LocalContentColor.current.copy(alpha = if (enabled) 1f else 0.5f))
    }
}

/** Faixa fina sob a barra: indica comunicação com o servidor sem empurrar o conteúdo. */
@Composable
fun BusyBar(busy: Boolean) {
    Box(Modifier.fillMaxWidth().height(3.dp)) {
        if (busy) {
            LinearProgressIndicator(
                Modifier.fillMaxSize(),
                color = Tones.Focus,
                trackColor = MaterialTheme.colorScheme.primaryContainer,
            )
        }
    }
}

enum class ActionStyle { Primary, Secondary, Quiet, Danger }

/**
 * Botão do aplicativo. Com foco, ganha a borda âmbar: quem opera pelo teclado sempre sabe o que o
 * Enter vai acionar.
 */
@Composable
fun ActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    style: ActionStyle = ActionStyle.Primary,
    glyph: Glyph? = null,
    enabled: Boolean = true,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val colors = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.small
    val focusBorder = BorderStroke(3.dp, Tones.Focus)
    val padding = PaddingValues(horizontal = 14.dp, vertical = 10.dp)
    val sized = modifier.heightIn(min = 48.dp)
    val content: @Composable RowScope.() -> Unit = {
        glyph?.let {
            GlyphIcon(it, null, Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, textAlign = TextAlign.Center, style = MaterialTheme.typography.labelLarge)
    }
    when (style) {
        ActionStyle.Primary ->
            Button(
                onClick = onClick,
                modifier = sized,
                enabled = enabled,
                shape = shape,
                colors = ButtonDefaults.buttonColors(containerColor = if (focused) Tones.BrandDark else colors.primary),
                border = if (focused) focusBorder else null,
                contentPadding = padding,
                interactionSource = source,
                content = content,
            )
        ActionStyle.Secondary ->
            OutlinedButton(
                onClick = onClick,
                modifier = sized,
                enabled = enabled,
                shape = shape,
                colors =
                    ButtonDefaults.outlinedButtonColors(
                        containerColor = if (focused) colors.primaryContainer else colors.surface,
                        contentColor = colors.primary,
                    ),
                border = if (focused) focusBorder else BorderStroke(1.dp, if (enabled) colors.primary else colors.outlineVariant),
                contentPadding = padding,
                interactionSource = source,
                content = content,
            )
        ActionStyle.Quiet ->
            TextButton(
                onClick = onClick,
                modifier = sized,
                enabled = enabled,
                shape = shape,
                colors =
                    ButtonDefaults.textButtonColors(
                        containerColor = if (focused) colors.primaryContainer else Color.Transparent,
                        contentColor = colors.primary,
                    ),
                border = if (focused) focusBorder else null,
                contentPadding = padding,
                interactionSource = source,
                content = content,
            )
        ActionStyle.Danger ->
            OutlinedButton(
                onClick = onClick,
                modifier = sized,
                enabled = enabled,
                shape = shape,
                colors =
                    ButtonDefaults.outlinedButtonColors(
                        containerColor = if (focused) colors.errorContainer else colors.surface,
                        contentColor = colors.error,
                    ),
                border = if (focused) focusBorder else BorderStroke(1.dp, if (enabled) colors.error else colors.outlineVariant),
                contentPadding = padding,
                interactionSource = source,
                content = content,
            )
    }
}

enum class Tone { Info, Success, Warning, Error }

/** Mensagem em faixa colorida: erro, aviso, sucesso ou informação, sempre com ícone. */
@Composable
fun StatusBanner(
    text: String,
    tone: Tone,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    val container: Color
    val content: Color
    val glyph: Glyph
    when (tone) {
        Tone.Info -> {
            container = colors.secondaryContainer
            content = colors.onSecondaryContainer
            glyph = Glyph.Info
        }
        Tone.Success -> {
            container = Tones.SuccessContainer
            content = Tones.OnSuccessContainer
            glyph = Glyph.Done
        }
        Tone.Warning -> {
            container = Tones.WarningContainer
            content = Tones.OnWarningContainer
            glyph = Glyph.Warning
        }
        Tone.Error -> {
            container = colors.errorContainer
            content = colors.onErrorContainer
            glyph = Glyph.Error
        }
    }
    Column(
        modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(container)
            .padding(horizontal = 10.dp, vertical = 8.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GlyphIcon(glyph, null, Modifier.size(20.dp), tint = content)
            Text(text, color = content, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        }
        action?.invoke()
    }
}

/**
 * Escolha única em faixa segmentada, como o filtro por risco: as opções dividem a largura por
 * igual, então cabem nos 320 dp do coletor, e as setas passam de uma para outra.
 */
@Composable
fun SegmentedChoice(
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.small
    Row(
        modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(shape)
            .border(1.dp, colors.outline, shape)
            .selectableGroup(),
    ) {
        options.forEachIndexed { index, label ->
            if (index > 0) Box(Modifier.width(1.dp).fillMaxHeight().background(colors.outline))
            val source = remember { MutableInteractionSource() }
            val focused by source.collectIsFocusedAsState()
            val chosen = index == selected
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .background(if (chosen) colors.primary else colors.surface)
                    .then(if (focused) Modifier.border(3.dp, Tones.Focus) else Modifier)
                    .selectable(chosen, interactionSource = source, indication = ripple(), role = Role.Tab, onClick = { onSelect(index) }),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelLarge.copy(fontSize = 13.sp),
                    color = if (chosen) colors.onPrimary else colors.onSurface,
                    maxLines = 1,
                )
            }
        }
    }
}

/**
 * Linha de lista. Clicável, recebe foco pelas setas e destaca-se com fundo e borda; [accent] é a
 * faixa colorida à esquerda (o nível de risco, por exemplo).
 */
@Composable
fun ListRow(
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    accent: Color? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val colors = MaterialTheme.colorScheme
    Row(
        modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .background(if (focused) colors.primaryContainer else colors.surface)
            .then(if (focused) Modifier.border(3.dp, Tones.Focus) else Modifier)
            .then(
                if (onClick != null) {
                    Modifier.clickable(interactionSource = source, indication = ripple(), onClick = onClick)
                } else {
                    Modifier
                },
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (accent != null) Box(Modifier.width(5.dp).fillMaxHeight().background(accent))
        Row(
            Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            content = content,
        )
    }
}

/** Título curto de seção, em versalete, com um complemento opcional à direita. */
@Composable
fun SectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    trailing: String? = null,
) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            text.uppercase(Locale.ROOT),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        trailing?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
fun EmptyState(
    text: String,
    modifier: Modifier = Modifier,
    glyph: Glyph = Glyph.Info,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        GlyphIcon(glyph, null, Modifier.size(36.dp), tint = MaterialTheme.colorScheme.outline)
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

/** Cores dos campos: com foco, o campo ganha fundo tingido além da borda. */
@Composable
fun appFieldColors(): TextFieldColors {
    val colors = MaterialTheme.colorScheme
    return OutlinedTextFieldDefaults.colors(
        focusedContainerColor = Tones.FocusedField,
        unfocusedContainerColor = colors.surface,
        disabledContainerColor = colors.surfaceVariant,
        errorContainerColor = colors.surface,
        focusedBorderColor = colors.primary,
        unfocusedBorderColor = colors.outline,
    )
}

/**
 * Campo de texto de uma linha no padrão do aplicativo. Durante um envio, prefira [readOnly] a
 * desabilitar: o campo desabilitado perde o foco, e quem usa o teclado fica sem onde estava.
 */
@Composable
fun AppTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    isError: Boolean = false,
    supporting: String? = null,
    suffix: String? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        supportingText = supporting?.let { { Text(it) } },
        suffix = suffix?.let { { Text(it) } },
        singleLine = true,
        enabled = enabled,
        readOnly = readOnly,
        isError = isError,
        keyboardOptions = keyboardOptions,
        visualTransformation = visualTransformation,
        shape = MaterialTheme.shapes.small,
        colors = appFieldColors(),
        modifier = modifier,
    )
}

/** Uma opção de [ChoiceChips]: a chave, o texto, a contagem e, se houver, a cor do ponto. */
data class ChipOption(
    val key: String?,
    val label: String,
    val count: Int? = null,
    val color: Color? = null,
)

/**
 * Escolha única em fichas lado a lado, roláveis na horizontal: cabem quantos níveis a loja criar,
 * mesmo nos 320 dp do coletor. As setas passam de uma ficha para a outra.
 */
@Composable
fun ChoiceChips(
    options: List<ChipOption>,
    selected: String?,
    onSelect: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.small
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        options.forEach { option ->
            val source = remember { MutableInteractionSource() }
            val focused by source.collectIsFocusedAsState()
            val chosen = option.key == selected
            Row(
                Modifier
                    .height(36.dp)
                    .clip(shape)
                    .background(if (chosen) colors.primary else colors.surface)
                    .border(if (focused) 3.dp else 1.dp, if (focused) Tones.Focus else colors.outline, shape)
                    .selectable(chosen, interactionSource = source, indication = ripple(), role = Role.Tab) { onSelect(option.key) }
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                option.color?.let { Box(Modifier.size(9.dp).clip(CircleShape).background(it)) }
                Text(
                    option.label,
                    style = MaterialTheme.typography.labelLarge.copy(fontSize = 13.sp),
                    color = if (chosen) colors.onPrimary else colors.onSurface,
                    maxLines = 1,
                )
                option.count?.let {
                    Text(
                        it.toString(),
                        style = MaterialTheme.typography.labelMedium,
                        color = if (chosen) colors.onPrimary.copy(alpha = 0.85f) else colors.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
