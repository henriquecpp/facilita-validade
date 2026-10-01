package br.com.estoque.app

import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import br.com.estoque.core.domain.Product
import br.com.estoque.feature.inventory.ProductKey

sealed interface Screen {
    data class Expiries(
        val levelId: String? = null,
    ) : Screen

    data class ProductView(
        val key: ProductKey,
    ) : Screen

    data class EntryForm(
        val product: Product,
    ) : Screen

    data class Counting(
        val product: Product,
    ) : Screen

    /** Lançamento rápido: bipa, quantidade, validade, salva e o próximo (AV19). */
    data object QuickEntry : Screen

    /**
     * Pesquisa pela descrição, para o código manchado ou o produto sem código (AV24); [text] é o
     * nome digitado no campo do lançamento rápido, que já abre pesquisado.
     */
    data class Search(
        val text: String = "",
    ) : Screen

    data object Device : Screen

    data object ChangePassword : Screen

    data object Camera : Screen
}

/** Uma tela na pilha, com seus próprios ViewModels: saem da memória quando a tela é removida. */
class BackStackEntry(
    val screen: Screen,
) : ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()
}

/** Pilha de telas do app. A tela inicial (validades) fica sempre na base. */
class Navigator {
    private val entries = mutableStateListOf(BackStackEntry(Screen.Expiries()))
    val top: BackStackEntry by derivedStateOf { entries.last() }
    val canGoBack: Boolean by derivedStateOf { entries.size > 1 }

    fun push(screen: Screen) {
        entries.add(BackStackEntry(screen))
    }

    fun pop() {
        if (entries.size > 1) entries.removeAt(entries.lastIndex).viewModelStore.clear()
    }

    /** Um produto lido vira o novo foco: a pilha volta a ser validades → produto. */
    fun openProduct(key: ProductKey) {
        while (entries.size > 1) entries.removeAt(entries.lastIndex).viewModelStore.clear()
        entries.add(BackStackEntry(Screen.ProductView(key)))
    }

    /** Um aviso abre uma consulta nova, já filtrada; não herda a aba anterior do coletor. */
    fun openExpiries(levelId: String? = null) {
        clear()
        entries.clear()
        entries.add(BackStackEntry(Screen.Expiries(levelId)))
    }

    fun clear() {
        entries.forEach { it.viewModelStore.clear() }
    }
}
