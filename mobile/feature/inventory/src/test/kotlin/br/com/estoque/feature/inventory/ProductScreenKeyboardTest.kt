package br.com.estoque.feature.inventory

import android.view.KeyEvent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import br.com.estoque.core.domain.FakeInventory
import br.com.estoque.core.domain.Inventory
import br.com.estoque.core.domain.Product
import br.com.estoque.core.domain.StockRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Ler o produto e teclar Enter: o caminho mais curto até lançar a mercadoria que chegou. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ProductScreenKeyboardTest {
    @get:Rule val compose = createComposeRule()

    private val product = Product("yogurt", "Iogurte natural 170g", true)

    private fun show(
        inventory: Inventory,
        onEntry: (Product) -> Unit = {},
        onCount: (Product) -> Unit = {},
    ) {
        val repository = FakeInventory().apply { addProduct("789", product, inventory) }
        val model = ProductViewModel(repository, ProductKey.Barcode("789"))
        compose.setContent { ProductScreen(model, onOpenBarcode = {}, onEntry = onEntry, onCount = onCount) }
        compose.waitForIdle()
    }

    @Test fun `tracked product opens with the entry focused, even before any key press`() {
        val opened = mutableListOf<Product>()
        show(Inventory(product, "TRACKED", listOf(StockRecord("r", "2027-04-12", null, 6)), 6, false), onEntry = { opened += it })

        compose.onNodeWithText("Nova entrada").assertIsFocused()
        compose.onNodeWithText("Nova entrada").performKeyInput { pressKey(Key.Enter) }
        compose.waitForIdle()
        assertEquals(listOf(product), opened)
        // O campo de código e a pesquisa ficam só no lançamento rápido.
        assertEquals(0, compose.onAllNodesWithText("Ler outro produto").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithContentDescription("Pesquisar pela descrição").fetchSemanticsNodes().size)
        // Recontar um produto controlado ficou só no painel (AV09, AV20).
        assertEquals(0, compose.onAllNodesWithText("Recontar produto").fetchSemanticsNodes().size)
    }

    @Test fun `tapping a lot shows who launched it and offers write-off and deletion`() {
        val lot =
            StockRecord(
                "r",
                "2027-04-12",
                "L-7",
                6,
                launchedQuantity = 10,
                soldQuantity = 4,
                launchedAt = "2026-10-17T13:05:00.000000Z",
                launchedBy = "repositor",
                origin = "APP_RECEIPT",
            )
        show(Inventory(product, "TRACKED", listOf(lot), 6, false))
        compose.onNodeWithText("12/04/2027").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Lote 12/04/2027").assertIsDisplayed()
        compose.onNodeWithText("Dar baixa").assertIsDisplayed()
        compose.onNodeWithText("Excluir lote").assertIsDisplayed()
        // Sem edição no coletor (AV08).
        assertEquals(0, compose.onAllNodesWithText("Editar", substring = true).fetchSemanticsNodes().size)
        // Quem lançou e quando, na linha e nos dados do lote (AV22).
        assertTrue(compose.onAllNodesWithText("por repositor", substring = true).fetchSemanticsNodes().isNotEmpty())
    }

    @Test fun `untracked product offers the initial count as the Enter action`() {
        val counted = mutableListOf<Product>()
        show(Inventory(product, "UNTRACKED", emptyList(), 0, false), onCount = { counted += it })

        compose.onNodeWithText("Fazer contagem inicial").assertIsFocused()
        compose.onNodeWithText("Fazer contagem inicial").performKeyInput { pressKey(Key.Enter) }
        compose.waitForIdle()
        assertEquals(listOf(product), counted)
    }

    @Test fun `another product read in place of this one loads the new product`() {
        val other = Product("greek", "Iogurte grego 90g", true)
        val repository =
            FakeInventory().apply {
                addProduct("789", product, Inventory(product, "TRACKED", listOf(StockRecord("r", "2027-04-12", null, 6)), 6, false))
                addProduct("790", other, Inventory(other, "UNTRACKED", emptyList(), 0, false))
            }
        // O leitor no produto abre outro produto no mesmo lugar da tela, com outro modelo.
        var model by mutableStateOf(ProductViewModel(repository, ProductKey.Barcode("789")))
        compose.setContent { ProductScreen(model, onOpenBarcode = {}, onEntry = {}, onCount = {}) }
        compose.onNodeWithText("Iogurte natural 170g").assertIsDisplayed()

        model = ProductViewModel(repository, ProductKey.Barcode("790"))
        compose.waitForIdle()
        compose.onNodeWithText("Iogurte grego 90g").assertIsDisplayed()
        compose.onNodeWithText("Fazer contagem inicial").assertIsFocused()
    }

    @Test fun `keyboard-mode scanner reads another product whole, even with the entry focused`() {
        val read = mutableListOf<String>()
        val repository =
            FakeInventory().apply {
                addProduct("789", product, Inventory(product, "TRACKED", listOf(StockRecord("r", "2027-04-12", null, 6)), 6, false))
            }
        val model = ProductViewModel(repository, ProductKey.Barcode("789"))
        compose.setContent { ProductScreen(model, onOpenBarcode = { read += it }, onEntry = {}, onCount = {}) }
        compose.waitForIdle()
        compose.onNodeWithText("Nova entrada").assertIsFocused()

        // O leitor digita em rajada: a tela junta as teclas e o Enter do fim entrega o código, sem
        // acionar o botão em foco.
        compose.onNodeWithText("Nova entrada").performKeyInput {
            "7891025103233".forEach { digit ->
                val key = Key(KeyEvent.KEYCODE_0 + (digit - '0'))
                keyDown(key)
                advanceEventTime(2)
                keyUp(key)
                advanceEventTime(2)
            }
            pressKey(Key.Enter, 2)
        }
        compose.waitForIdle()
        assertEquals(listOf("7891025103233"), read)
    }
}
