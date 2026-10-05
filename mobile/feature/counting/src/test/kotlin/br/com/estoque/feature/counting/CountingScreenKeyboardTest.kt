package br.com.estoque.feature.counting

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.KeyInjectionScope
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import br.com.estoque.core.domain.CountLine
import br.com.estoque.core.domain.CountSession
import br.com.estoque.core.domain.FakeInventory
import br.com.estoque.core.domain.Product
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private val digits =
    mapOf('0' to Key.Zero, '1' to Key.One, '2' to Key.Two, '4' to Key.Four, '7' to Key.Seven)

@OptIn(ExperimentalTestApi::class)
private fun KeyInjectionScope.type(text: String) =
    text.forEach {
        pressKey(digits.getValue(it), 20)
        advanceEventTime(150)
    }

/** Contagem inteira pelo teclado do coletor: linha com Enter, seta até concluir, Enter confirma. */
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CountingScreenKeyboardTest {
    @get:Rule val compose = createComposeRule()

    @Test fun `line saved with Enter, arrow down reaches finish and Enter confirms`() {
        val product = Product("yogurt", "Iogurte natural 170g", true)
        val repository = FakeInventory().apply { addProduct("789", product) }
        val model = CountingViewModel(repository, product, { "2026-09-28" }) { "line-1" }
        compose.setContent { CountingScreen(model, onFinished = {}, onBack = {}) }

        compose.onNodeWithTag("quantity").assertIsFocused()
        compose.onNodeWithTag("quantity").performKeyInput {
            type("12")
            pressKey(Key.Enter)
        }
        compose.onNodeWithTag("expiry").performKeyInput {
            type("12042027")
            pressKey(Key.Enter)
        }
        compose.onNodeWithTag("lot").performKeyInput { pressKey(Key.Enter) }
        compose.waitForIdle()
        assertEquals(listOf(listOf(CountLine("line-1", "2027-04-12", null, 12))), repository.savedLines)
        compose.onNodeWithTag("quantity").assertIsFocused()

        // Sem Tab no coletor: as setas percorrem o formulário e chegam ao botão de concluir.
        compose.onNodeWithTag("quantity").performKeyInput { pressKey(Key.DirectionDown) }
        compose.onNodeWithTag("expiry").assertIsFocused()
        compose.onNodeWithTag("expiry").performKeyInput { pressKey(Key.DirectionDown) }
        compose.onNodeWithTag("lot").assertIsFocused()
        compose.onNodeWithTag("lot").performKeyInput { pressKey(Key.DirectionDown) }
        compose.onNodeWithTag("finish").assertIsFocused()
        compose.onNodeWithTag("finish").performKeyInput { pressKey(Key.Enter) }
        compose.waitForIdle()

        compose.onNodeWithTag("confirm").assertIsFocused()
        compose.onNodeWithTag("confirm").performKeyInput { pressKey(Key.Enter) }
        compose.waitForIdle()
        assertEquals("CONFIRMED", repository.confirmed?.status)
    }

    @Test fun `digits typed while the count is still opening are kept`() {
        val product = Product("yogurt", "Iogurte natural 170g", true)
        val opened = CompletableDeferred<Unit>()
        val repository =
            object : FakeInventory() {
                override suspend fun createCount(productId: String): CountSession {
                    opened.await()
                    return super.createCount(productId)
                }
            }.apply { addProduct("789", product) }
        val model = CountingViewModel(repository, product, { "2026-09-28" }) { "line-1" }
        compose.setContent { CountingScreen(model, onFinished = {}, onBack = {}) }

        // A contagem ainda está abrindo no servidor e o operador já digita a quantidade.
        compose.onNodeWithTag("quantity").assertIsFocused()
        compose.onNodeWithTag("quantity").performKeyInput { type("12") }
        compose.onNodeWithTag("quantity").assert(hasText("12"))
        opened.complete(Unit)
        compose.waitForIdle()

        // A contagem chegou: o foco ficou onde estava e a linha segue o caminho de sempre.
        compose.onNodeWithTag("quantity").assertIsFocused()
        compose.onNodeWithTag("quantity").performKeyInput { pressKey(Key.Enter) }
        compose.onNodeWithTag("expiry").performKeyInput {
            type("12042027")
            pressKey(Key.Enter)
        }
        compose.onNodeWithTag("lot").performKeyInput { pressKey(Key.Enter) }
        compose.waitForIdle()
        assertEquals(listOf(listOf(CountLine("line-1", "2027-04-12", null, 12))), repository.savedLines)
    }
}
