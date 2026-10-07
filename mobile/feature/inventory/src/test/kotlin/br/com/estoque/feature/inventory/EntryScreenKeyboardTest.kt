package br.com.estoque.feature.inventory

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.KeyInjectionScope
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import br.com.estoque.core.domain.Entry
import br.com.estoque.core.domain.FakeInventory
import br.com.estoque.core.domain.Product
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private val digits = mapOf('0' to Key.Zero, '1' to Key.One, '2' to Key.Two, '4' to Key.Four, '6' to Key.Six, '7' to Key.Seven)

@OptIn(ExperimentalTestApi::class)
private fun KeyInjectionScope.type(text: String) =
    text.forEach {
        pressKey(digits.getValue(it), 20)
        advanceEventTime(150)
    }

/** O fluxo que o cliente pediu: registrar uma validade só com o teclado físico do coletor. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class EntryScreenKeyboardTest {
    @get:Rule val compose = createComposeRule()

    @Test fun `quantity, date, lot and note are filled and saved with Enter only`() {
        val product = Product("yogurt", "Iogurte natural 170g", true)
        val repository = FakeInventory().apply { addProduct("789", product) }
        val model = EntryViewModel(repository, product) { "2026-09-28" }
        compose.setContent { EntryScreen(model, onOpenBarcode = {}) }

        compose.onNodeWithTag("quantity").assertIsFocused()
        compose.onNodeWithTag("quantity").performKeyInput {
            type("6")
            pressKey(Key.Enter)
        }
        compose.onNodeWithTag("expiry").assertIsFocused()
        compose.onNodeWithTag("expiry").performKeyInput {
            type("12042027")
            pressKey(Key.Enter)
        }
        compose.onNodeWithTag("lot").assertIsFocused()
        compose.onNodeWithTag("lot").performKeyInput { pressKey(Key.Enter) }
        // A observação é opcional (AV23): Enter nela, mesmo vazia, registra.
        compose.onNodeWithTag("note").assertIsFocused()
        compose.onNodeWithTag("note").performKeyInput { pressKey(Key.Enter) }

        compose.waitForIdle()
        assertEquals(listOf(Entry("yogurt", 6, "2027-04-12", null, null)), repository.receipts)
        compose.onNodeWithTag("quantity").assertIsFocused()
    }
}
