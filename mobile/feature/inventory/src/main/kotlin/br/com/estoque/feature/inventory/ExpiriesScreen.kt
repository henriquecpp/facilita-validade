package br.com.estoque.feature.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import br.com.estoque.core.domain.ExpiryDate
import br.com.estoque.core.domain.ExpiryItem
import br.com.estoque.core.domain.forecast
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.ChipOption
import br.com.estoque.core.ui.ChoiceChips
import br.com.estoque.core.ui.EmptyState
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.IconAction
import br.com.estoque.core.ui.KeyHint
import br.com.estoque.core.ui.ListRow
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import br.com.estoque.core.ui.Tones
import br.com.estoque.core.ui.deadlineText
import br.com.estoque.core.ui.defaultAction
import br.com.estoque.core.ui.hasPhysicalKeyboard
import br.com.estoque.core.ui.levelColor
import br.com.estoque.core.ui.levelTextColor
import br.com.estoque.core.ui.rememberKeyboardScans

/**
 * Tela inicial: as validades da loja, da mais próxima de vencer para a mais distante, com uma aba
 * por nível de urgência da loja. O campo de leitura saiu daqui (AV19): o botão abre o lançamento
 * rápido, e a lupa, a pesquisa por descrição. Um código lido nesta tela, pelo leitor em qualquer
 * modo, abre o produto.
 */
@Composable
fun ExpiriesScreen(
    viewModel: ExpiriesViewModel,
    storeName: String,
    onOpenBarcode: (String) -> Unit,
    onOpenProduct: (String) -> Unit,
    onQuickEntry: () -> Unit,
    onSearch: () -> Unit,
    onDevice: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val quickFocus = remember { FocusRequester() }
    val keyboard = hasPhysicalKeyboard()
    HandleScans(onOpenBarcode)
    // No coletor, o foco fica no lançamento rápido: o Enter o abre, e a leitura do leitor em modo
    // teclado chega à tela (sem nada em foco, as teclas não chegariam a lugar nenhum).
    LaunchedEffect(Unit) { if (keyboard) runCatching { quickFocus.requestFocus() } }
    // Recarrega ao voltar para a tela e quando o app volta ao primeiro plano: o coletor fica
    // horas parado no início, e os saldos mudam com as vendas.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.refresh() }
    AppScreen(
        title = "Validades",
        subtitle = storeName,
        busy = state.busy,
        modifier = rememberKeyboardScans(onOpenBarcode),
        actions = {
            IconAction(Glyph.Search, "Pesquisar produto", onSearch)
            IconAction(Glyph.Refresh, "Atualizar", { viewModel.refresh() })
            IconAction(Glyph.Settings, "Aparelho e sessão", onDevice)
        },
    ) {
        Column(
            Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ActionButton(
                "Lançamento rápido",
                onQuickEntry,
                Modifier
                    .fillMaxWidth()
                    .focusRequester(quickFocus)
                    .defaultAction()
                    .testTag("quick-entry"),
                glyph = Glyph.Quick,
            )
            KeyHint("Leia um código para abrir o produto.")
            state.pending?.let { pending ->
                StatusBanner("Sem confirmação do servidor: ${pending.description}. Reenviar não duplica o lançamento.", Tone.Warning) {
                    ActionButton(
                        "Enviar de novo",
                        { viewModel.resendPending() },
                        Modifier.fillMaxWidth(),
                        style = ActionStyle.Secondary,
                        glyph = Glyph.Refresh,
                    )
                }
            }
            state.error?.let { StatusBanner(it, Tone.Error) }
            state.notice?.let { StatusBanner(it, Tone.Success) }
            ChoiceChips(
                options =
                    listOf(ChipOption(null, "Todas", state.levels.sumOf { it.lots })) +
                        state.tabs.map {
                            ChipOption(ExpiriesViewModel.keyOf(it), it.level.name, it.lots, levelColor(it.level))
                        },
                selected = state.selected,
                onSelect = viewModel::select,
            )
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            items(state.items, key = { it.recordId }) { item ->
                ExpiryRow(item) { onOpenProduct(item.productId) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            if (state.loaded && state.items.isEmpty()) {
                item {
                    if (state.selected == null) {
                        EmptyState(
                            "Nenhuma validade com saldo.\nUse o lançamento rápido para registrar as entradas.",
                            glyph = Glyph.Barcode,
                        )
                    } else {
                        EmptyState("Nenhuma validade neste nível.", glyph = Glyph.Done)
                    }
                }
            }
            if (state.hasMore) {
                item {
                    ActionButton(
                        "Carregar mais",
                        { viewModel.loadMore() },
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                        style = ActionStyle.Quiet,
                    )
                }
            }
        }
    }
}

@Composable
private fun ExpiryRow(
    item: ExpiryItem,
    onOpen: () -> Unit,
) {
    val urgent = item.level?.notify == true || item.daysToExpiry < 0
    ListRow(onClick = onOpen, accent = levelColor(item.level)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(item.productName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                buildAnnotatedString {
                    append(ExpiryDate.format(item.expiresOn))
                    append(" · ")
                    withStyle(
                        SpanStyle(color = levelTextColor(item.level), fontWeight = if (urgent) FontWeight.Bold else FontWeight.SemiBold),
                    ) { append(deadlineText(item.daysToExpiry)) }
                    item.lotCode?.let { append(" · lote $it") }
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // Previsão pela média de vendas: o repositor sabe o que deve sair sozinho.
            item.forecast()?.let { (text, ok) ->
                Text(
                    text,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                    color = if (ok) Tones.Success else Tones.Warning,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text("${item.quantity} un.", style = MaterialTheme.typography.titleSmall)
    }
}
