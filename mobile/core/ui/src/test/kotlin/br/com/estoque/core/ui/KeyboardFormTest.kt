package br.com.estoque.core.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.KeyInjectionScope
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private val digitKeys =
    mapOf(
        '0' to Key.Zero,
        '1' to Key.One,
        '2' to Key.Two,
        '3' to Key.Three,
        '4' to Key.Four,
        '5' to Key.Five,
        '6' to Key.Six,
        '7' to Key.Seven,
        '8' to Key.Eight,
        '9' to Key.Nine,
    )

/** Digita como uma pessoa no teclado físico: cerca de 150 ms entre as teclas. */
@OptIn(ExperimentalTestApi::class)
fun KeyInjectionScope.typeSlowly(text: String) =
    text.forEach {
        pressKey(digitKeys.getValue(it), 20)
        advanceEventTime(150)
    }

/** Digita como um leitor em modo teclado: alguns milissegundos por tecla, com Enter no fim. */
@OptIn(ExperimentalTestApi::class)
fun KeyInjectionScope.scan(code: String) {
    code.forEach {
        keyDown(digitKeys.getValue(it))
        advanceEventTime(2)
        keyUp(digitKeys.getValue(it))
        advanceEventTime(2)
    }
    keyDown(Key.Enter)
    advanceEventTime(2)
    keyUp(Key.Enter)
}

@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KeyboardFormTest {
    @get:Rule val compose = createComposeRule()

    @Test fun `Enter moves to the next field and submits on the last one`() {
        var submitted = 0
        compose.setContent {
            val focus = LocalFocusManager.current
            var quantity by remember { mutableStateOf("") }
            var lot by remember { mutableStateOf("") }
            Column {
                OutlinedTextField(quantity, { quantity = it }, Modifier.testTag("quantity").formStep(focus))
                OutlinedTextField(lot, { lot = it }, Modifier.testTag("lot").formStep(focus, onSubmit = { submitted++ }))
            }
        }
        compose.onNodeWithTag("quantity").performClick()
        compose.onNodeWithTag("quantity").performKeyInput {
            typeSlowly("12")
            pressKey(Key.Enter)
        }
        compose.onNodeWithTag("lot").assertIsFocused()
        compose.onNodeWithTag("lot").performKeyInput { pressKey(Key.Enter) }
        assertEquals(1, submitted)
    }

    @Test fun `expiry field turns digits typed on the hardware keyboard into a date`() {
        var date by mutableStateOf("")
        compose.setContent { ExpiryDateField(date, { date = it }, Modifier.testTag("date")) }
        compose.onNodeWithTag("date").performClick()
        compose.onNodeWithTag("date").performKeyInput { typeSlowly("12042026") }
        assertEquals("12/04/2026", date)
        compose.onNodeWithTag("date").assert(hasText("12/04/2026"))
    }

    @Test fun `scanner burst in the quantity field is undone and delivered as a scan`() {
        val scans = mutableListOf<String>()
        var submitted = 0
        var quantity by mutableStateOf("")
        compose.setContent {
            val focus = LocalFocusManager.current
            val guard = rememberScanGuard { scans += it }
            OutlinedTextField(
                quantity,
                { quantity = it },
                Modifier.testTag("quantity").formStep(
                    focus,
                    onSubmit = { submitted++ },
                    scanGuard = guard,
                    value = quantity,
                    restore = { quantity = it },
                ),
            )
        }
        compose.onNodeWithTag("quantity").performClick()
        compose.onNodeWithTag("quantity").performKeyInput {
            typeSlowly("6")
            advanceEventTime(500)
            scan("7891234567895")
        }
        compose.waitForIdle()
        assertEquals(listOf("7891234567895"), scans)
        assertEquals("6", quantity)
        assertEquals(0, submitted)
    }
}
