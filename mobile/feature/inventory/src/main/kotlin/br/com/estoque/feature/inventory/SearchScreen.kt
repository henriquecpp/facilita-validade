package br.com.estoque.feature.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import br.com.estoque.core.domain.Ean13
import br.com.estoque.core.domain.ExpiryDate
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.ProductHit
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.AppTextField
import br.com.estoque.core.ui.EmptyState
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.ListRow
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Pesquisa pela descrição (AV24), para o código manchado ou o produto sem código: busca enquanto
 * digita, os mais parecidos primeiro, e o toque abre a tela do produto. Vinda do lançamento rápido
 * com um nome digitado, já abre com o resultado dele.
 *
 * Só pesquisa o que pode achar algo novo: espera uma pausa na digitação, cancela a busca do texto
 * que mudou, não repete a busca do texto que já está na tela e não procura EAN-13 com o último
 * dígito errado.
 */
class SearchViewModel(
    private val repository: InventoryPort,
    initial: String = "",
) : ViewModel() {
    data class State(
        val text: String = "",
        val items: List<ProductHit> = emptyList(),
        val nextCursor: String? = null,
        val busy: Boolean = false,
        val searched: Boolean = false,
        val error: String? = null,
    )

    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()
    private var job: Job? = null

    /** Texto cujo resultado está na tela. */
    private var shown: String? = null

    init {
        if (initial.isNotBlank()) search(initial, wait = false)
    }

    fun type(text: String) = search(text, wait = true)

    private fun search(
        text: String,
        wait: Boolean,
    ) {
        mutable.update { it.copy(text = text) }
        job?.cancel()
        val term = text.trim()
        if (term == shown) {
            mutable.update { it.copy(busy = false) }
            return
        }
        val digits = term.filterNot(Char::isWhitespace)
        val problem = if (Ean13.invalid(digits)) Ean13.message(digits) else null
        if (term.length < MIN_LENGTH || problem != null) {
            shown = null
            mutable.update { it.copy(items = emptyList(), nextCursor = null, searched = false, error = problem, busy = false) }
            return
        }
        job =
            viewModelScope.launch {
                if (wait) delay(DEBOUNCE_MILLIS)
                load(term, null)
            }
    }

    fun loadMore() {
        val cursor = mutable.value.nextCursor ?: return
        if (mutable.value.busy) return
        job = viewModelScope.launch { load(mutable.value.text.trim(), cursor) }
    }

    private suspend fun load(
        term: String,
        cursor: String?,
    ) {
        mutable.update { it.copy(busy = true, error = null) }
        try {
            val page = repository.search(term, cursor)
            if (cursor == null) shown = term
            mutable.update {
                it.copy(
                    items = if (cursor == null) page.items else (it.items + page.items).distinctBy { hit -> hit.productId },
                    nextCursor = page.nextCursor,
                    searched = true,
                )
            }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: Exception) {
            mutable.update { it.copy(error = error.message ?: "Não foi possível pesquisar.") }
        } finally {
            mutable.update { it.copy(busy = false) }
        }
    }

    private companion object {
        const val MIN_LENGTH = 2
        const val DEBOUNCE_MILLIS = 350L
    }
}

@Composable
fun SearchScreen(
    viewModel: SearchViewModel,
    onOpenProduct: (String) -> Unit,
    onOpenBarcode: (String) -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val field = remember { FocusRequester() }
    // O leitor continua valendo aqui: um código lido abre o produto.
    HandleScans(onOpenBarcode)
    LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
    AppScreen(title = "Pesquisar produto", onBack = onBack, busy = state.busy) {
        Column(
            Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 6.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AppTextField(
                value = state.text,
                onValueChange = viewModel::type,
                label = "Descrição ou código",
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth().focusRequester(field).testTag("search"),
            )
            state.error?.let { StatusBanner(it, Tone.Error) }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
            items(state.items, key = { it.productId }) { hit ->
                HitRow(hit) { onOpenProduct(hit.productId) }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            if (state.searched && state.items.isEmpty()) {
                item { EmptyState("Nenhum produto com \"${state.text.trim()}\".", glyph = Glyph.Search) }
            }
            if (!state.searched && state.items.isEmpty()) {
                item { EmptyState("Digite parte da descrição, como \"iogurte morango\".", glyph = Glyph.Search) }
            }
            if (state.nextCursor != null) {
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
private fun HitRow(
    hit: ProductHit,
    onOpen: () -> Unit,
) {
    ListRow(onClick = onOpen) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(hit.name, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(
                    hit.barcode ?: "Sem código de barras",
                    if (hit.tracked) hit.nearestExpiry?.let { "próxima validade ${ExpiryDate.format(it)}" } else "sem contagem inicial",
                ).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (hit.tracked) Text("${hit.quantity} un.", style = MaterialTheme.typography.titleSmall)
    }
}
