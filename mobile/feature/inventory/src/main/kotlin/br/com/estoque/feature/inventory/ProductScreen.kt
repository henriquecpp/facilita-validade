package br.com.estoque.feature.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.estoque.core.domain.ExpiryDate
import br.com.estoque.core.domain.Inventory
import br.com.estoque.core.domain.Product
import br.com.estoque.core.domain.StockRecord
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.AppTextField
import br.com.estoque.core.ui.ConfirmDialog
import br.com.estoque.core.ui.FocusOnOpen
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.GlyphIcon
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.LevelBadge
import br.com.estoque.core.ui.ListRow
import br.com.estoque.core.ui.SectionLabel
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import br.com.estoque.core.ui.daysUntil
import br.com.estoque.core.ui.deadlineText
import br.com.estoque.core.ui.defaultAction
import br.com.estoque.core.ui.formatInstant
import br.com.estoque.core.ui.hasPhysicalKeyboard
import br.com.estoque.core.ui.levelColor
import br.com.estoque.core.ui.levelTextColor
import br.com.estoque.core.ui.rememberKeyboardScans
import coil3.compose.SubcomposeAsyncImage
import java.net.URI

/** O que o Enter faz ao abrir o produto: a ação mais provável para o estado dele. */
private enum class MainAction { CONTINUE_COUNT, ENTRY, INITIAL_COUNT }

private fun mainAction(
    inventory: Inventory,
    openCount: Boolean,
): MainAction? =
    when {
        openCount -> MainAction.CONTINUE_COUNT
        !inventory.product.active -> null
        inventory.tracked -> MainAction.ENTRY
        else -> MainAction.INITIAL_COUNT
    }

@Composable
fun ProductScreen(
    viewModel: ProductViewModel,
    onOpenBarcode: (String) -> Unit,
    onEntry: (Product) -> Unit,
    onCount: (Product) -> Unit,
    onBack: () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // Lote tocado: abre os dados dele com dar baixa e excluir (AV21).
    var opened by remember { mutableStateOf<StockRecord?>(null) }
    val actionFocus = remember { FocusRequester() }
    val screenFocus = remember { FocusRequester() }
    val keyboard = hasPhysicalKeyboard()
    // A tela não tem campo de código: o campo e a pesquisa ficam no lançamento rápido. A leitura
    // do coletor continua abrindo o produto lido, por Intent ou em modo teclado.
    HandleScans(onOpenBarcode)
    // Recarrega sempre que a tela volta a ficar visível (ex.: depois de uma entrada ou contagem)
    // e quando outro produto lido toma o lugar deste, com outro modelo.
    LaunchedEffect(viewModel) { viewModel.load() }
    val inventory = state.inventory
    val action = inventory?.let { mainAction(it, state.openCount != null) }
    // Com o produto carregado, o foco vai para a ação principal: Enter já abre o lançamento.
    LaunchedEffect(inventory?.product?.id, action) {
        if (action != null) {
            runCatching { actionFocus.requestFocus() }
        } else if (keyboard) {
            // Sem ação principal (carregando, produto inativo, erro), o foco fica na própria tela:
            // sem nada em foco, as teclas do leitor em modo teclado não chegariam a lugar nenhum.
            runCatching { screenFocus.requestFocus() }
        }
    }
    AppScreen(
        title = "Produto",
        onBack = onBack,
        busy = state.busy,
        bottomBar =
            if (inventory != null && action != null) {
                { MainActions(inventory.product, action, actionFocus, onEntry, onCount) }
            } else {
                null
            },
        modifier = rememberKeyboardScans(onOpenBarcode),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .focusRequester(screenFocus)
                .focusable(enabled = action == null)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            state.notice?.let { StatusBanner(it, Tone.Success) }
            state.error?.let {
                StatusBanner(it, if (state.uncertain) Tone.Warning else Tone.Error) {
                    ActionButton(
                        if (state.uncertain) "Enviar de novo" else "Tentar de novo",
                        { if (state.uncertain) viewModel.resendPending() else viewModel.load() },
                        Modifier.fillMaxWidth(),
                        style = ActionStyle.Secondary,
                        glyph = Glyph.Refresh,
                    )
                }
            }
            if (inventory != null) ProductDetail(inventory, state, viewModel.scannedCode) { opened = it }
        }
    }
    opened?.let { record ->
        LotDialog(
            record,
            blocked = state.openCount != null,
            onWriteOff = { quantity, reason ->
                opened = null
                viewModel.writeOff(record, quantity, reason)
            },
            onDelete = {
                opened = null
                viewModel.delete(record)
            },
            onDismiss = { opened = null },
        )
    }
}

/** Ações no rodapé; a principal recebe o foco ao abrir, para o Enter já acioná-la. */
@Composable
private fun MainActions(
    product: Product,
    action: MainAction,
    focus: FocusRequester,
    onEntry: (Product) -> Unit,
    onCount: (Product) -> Unit,
) {
    val main = Modifier.fillMaxWidth().focusRequester(focus).defaultAction()
    when (action) {
        MainAction.CONTINUE_COUNT -> ActionButton("Continuar contagem", { onCount(product) }, main, glyph = Glyph.Count)
        MainAction.INITIAL_COUNT -> ActionButton("Fazer contagem inicial", { onCount(product) }, main, glyph = Glyph.Count)
        // Recontar um produto já controlado só pelo painel (AV09): no coletor, a contagem é a inicial.
        MainAction.ENTRY -> ActionButton("Nova entrada", { onEntry(product) }, main, glyph = Glyph.Add)
    }
}

/**
 * O que o operador precisa diante da gôndola: o produto, quanto há e de quais validades. Data da
 * última contagem, movimentações e avisos de processamento ficam no painel.
 */
@Composable
private fun ProductDetail(
    inventory: Inventory,
    state: ProductViewModel.State,
    scannedCode: String?,
    onOpenRecord: (StockRecord) -> Unit,
) {
    val product = inventory.product
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        ProductPhoto(product)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(product.description, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            scannedCode?.let {
                Text("Código $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    if (!product.active) StatusBanner("Produto inativo no cadastro da loja.", Tone.Error)
    BalanceCard(inventory)
    if (state.openCount != null) {
        StatusBanner("Contagem em andamento: conclua antes de registrar entradas.", Tone.Warning)
    }
    val records = inventory.records.filter { it.quantity > 0 }
    if (records.isNotEmpty()) {
        SectionLabel("Lotes", trailing = "toque para dar baixa ou excluir")
        Bordered { records.forEachIndexed { index, record -> Separated(index) { RecordRow(record) { onOpenRecord(record) } } } }
    }
}

@Composable
private fun BalanceCard(inventory: Inventory) {
    val shape = MaterialTheme.shapes.medium
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (inventory.tracked) {
            SectionLabel("Estoque estimado")
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    "${inventory.totalQuantity}",
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(" un.", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 5.dp))
            }
        } else {
            SectionLabel("Sem contagem inicial")
            Text(
                "Conte todas as validades deste produto na loja para começar o controle.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

/** Grupo de linhas com borda arredondada, como um cartão. */
@Composable
private fun Bordered(content: @Composable ColumnScope.() -> Unit) {
    val shape = MaterialTheme.shapes.medium
    Column(
        Modifier.fillMaxWidth().clip(shape).border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape),
        content = content,
    )
}

@Composable
private fun Separated(
    index: Int,
    content: @Composable () -> Unit,
) {
    if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    content()
}

/** Quando e por quem o lote foi lançado (AV01, AV22): as vendas só saem dele depois disso. */
private fun launchText(record: StockRecord): String =
    listOfNotNull(
        when (record.origin) {
            "COUNT" -> "Contagem"
            "RETURN_RECEIPT" -> "Devolução"
            else -> "Entrada"
        } + " em " + formatInstant(record.launchedAt),
        record.launchedBy?.let { "por $it" },
    ).joinToString(" ")

@Composable
private fun RecordRow(
    record: StockRecord,
    onOpen: () -> Unit,
) {
    val days = daysUntil(record.expiresOn)
    ListRow(onClick = onOpen, accent = levelColor(record.level)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(ExpiryDate.format(record.expiresOn), style = MaterialTheme.typography.titleSmall)
            Text(
                listOfNotNull(days?.let(::deadlineText), record.lotCode?.let { "lote $it" }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = levelTextColor(record.level),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                launchText(record),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            Text("${record.quantity} un.", style = MaterialTheme.typography.titleSmall)
            Text(
                "de ${record.launchedQuantity}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * Um lote aberto pelo toque (AV21): lançado, vendido, baixa manual e saldo (AV02), quem lançou e
 * quando, e as duas correções do coletor — dar baixa e excluir. Edição só no painel (AV08).
 */
@Composable
private fun LotDialog(
    record: StockRecord,
    blocked: Boolean,
    onWriteOff: (Int, String?) -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    var mode by remember { mutableStateOf(LotMode.DETAIL) }
    var quantity by remember { mutableStateOf(record.quantity.toString()) }
    var reason by remember { mutableStateOf("") }
    val amount = quantity.toIntOrNull()
    val valid = amount != null && amount in 1..record.quantity
    when (mode) {
        LotMode.DETAIL ->
            ConfirmDialog(
                title = "Lote ${ExpiryDate.format(record.expiresOn)}",
                confirmLabel = "Dar baixa",
                onConfirm = { mode = LotMode.WRITE_OFF },
                onDismiss = onDismiss,
                dismissLabel = "Fechar",
                confirmEnabled = !blocked,
            ) {
                record.level?.let { LevelBadge(it) }
                LotFacts(record)
                record.note?.let { Text("Observação: $it", style = MaterialTheme.typography.bodySmall) }
                if (blocked) {
                    Text(
                        "Há uma contagem em andamento: conclua a contagem antes de corrigir o lote.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                } else {
                    ActionButton(
                        "Excluir lote",
                        { mode = LotMode.DELETE },
                        Modifier.fillMaxWidth(),
                        style = ActionStyle.Danger,
                        glyph = Glyph.Delete,
                    )
                }
            }
        LotMode.WRITE_OFF -> {
            val field = remember { FocusRequester() }
            ConfirmDialog(
                title = "Dar baixa no lote",
                confirmLabel = "Dar baixa",
                onConfirm = { if (valid) onWriteOff(amount!!, reason) },
                onDismiss = { mode = LotMode.DETAIL },
                confirmEnabled = valid,
                focusConfirm = false,
            ) {
                Text(
                    "A baixa tira unidades só deste lote, até o saldo de ${record.quantity} un., e fica registrada separada das vendas.",
                    style = MaterialTheme.typography.bodySmall,
                )
                AppTextField(
                    value = quantity,
                    onValueChange = { value -> quantity = value.filter { it in '0'..'9' } },
                    label = "Quantidade a baixar",
                    suffix = "un.",
                    isError = !valid,
                    supporting = if (valid) null else "De 1 a ${record.quantity} unidades.",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth().focusRequester(field),
                )
                AppTextField(
                    value = reason,
                    onValueChange = { reason = it.take(500) },
                    label = "Motivo (opcional)",
                    modifier = Modifier.fillMaxWidth(),
                )
                FocusOnOpen(field)
            }
        }
        LotMode.DELETE ->
            ConfirmDialog(
                title = "Excluir este lote?",
                confirmLabel = "Excluir",
                onConfirm = onDelete,
                onDismiss = { mode = LotMode.DETAIL },
                style = ActionStyle.Danger,
            ) {
                Text("O lote sai da lista e fica no histórico do produto como excluído.", style = MaterialTheme.typography.bodyMedium)
                if (record.soldQuantity > 0) {
                    Text(
                        "${record.soldQuantity} un. vendidas saíram deste lote: elas passam para os outros lotes, do que vence antes.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
    }
}

private enum class LotMode { DETAIL, WRITE_OFF, DELETE }

@Composable
private fun LotFacts(record: StockRecord) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Fact("Lote", record.lotCode ?: "não informado")
        Fact("Lançado", "${record.launchedQuantity} un.")
        Fact("Vendido", "${record.soldQuantity} un.")
        if (record.writtenOffQuantity > 0) Fact("Baixa manual", "${record.writtenOffQuantity} un.")
        Fact("Saldo", "${record.quantity} un.")
        Text(launchText(record), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Fact(
    label: String,
    value: String,
) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.titleSmall)
    }
}

@Composable
private fun ProductPhoto(product: Product) {
    val url =
        remember(product.photoUrl) {
            product.photoUrl?.takeIf {
                runCatching {
                    val uri = URI(it)
                    uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()
                }.getOrDefault(false)
            }
        }
    if (url == null) return
    val shape = MaterialTheme.shapes.small
    SubcomposeAsyncImage(
        model = url,
        contentDescription = "Foto de ${product.description}",
        contentScale = ContentScale.Fit,
        modifier =
            Modifier
                .size(64.dp)
                .clip(shape)
                .background(MaterialTheme.colorScheme.surface)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape),
        loading = { Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant)) },
        error = {
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                GlyphIcon(Glyph.Barcode, "Foto indisponível", tint = MaterialTheme.colorScheme.outline)
            }
        },
    )
}
