package br.com.estoque.feature.auth

import android.view.KeyEvent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.KeyInjectionScope
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import br.com.estoque.core.domain.FakePreferences
import br.com.estoque.core.domain.FakeSession
import br.com.estoque.core.domain.LastLogin
import br.com.estoque.core.domain.Login
import br.com.estoque.core.domain.PairDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Maiúsculas, hífen e sublinhado cobrem o alfabeto base64url do segredo.
private const val CODE = "estoque-pair:1:AbCd_ef-9876543210aBcDeFgHiJkLmNoPqRsTuVwXy"

/** Tecla e Shift para cada caractere que um código de acesso pode ter. */
private fun keyOf(char: Char): Pair<Key, Boolean> =
    when (char) {
        in 'a'..'z' -> Key(KeyEvent.KEYCODE_A + (char - 'a')) to false
        in 'A'..'Z' -> Key(KeyEvent.KEYCODE_A + (char - 'A')) to true
        in '0'..'9' -> Key(KeyEvent.KEYCODE_0 + (char - '0')) to false
        '-' -> Key(KeyEvent.KEYCODE_MINUS) to false
        '_' -> Key(KeyEvent.KEYCODE_MINUS) to true
        ':' -> Key(KeyEvent.KEYCODE_SEMICOLON) to true
        else -> error("Sem tecla para '$char'")
    }

/** Como o leitor do coletor em modo teclado: milissegundos por tecla e Enter no fim. */
@OptIn(ExperimentalTestApi::class)
private fun KeyInjectionScope.scanAsKeyboard(code: String) {
    code.forEach { char ->
        val (key, shift) = keyOf(char)
        if (shift) keyDown(Key.ShiftLeft)
        keyDown(key)
        advanceEventTime(2)
        keyUp(key)
        if (shift) keyUp(Key.ShiftLeft)
        advanceEventTime(2)
    }
    keyDown(Key.Enter)
    advanceEventTime(2)
    keyUp(Key.Enter)
}

/** Como uma pessoa no teclado numérico: cerca de 150 ms entre as teclas. */
@OptIn(ExperimentalTestApi::class)
private fun KeyInjectionScope.typeSlowly(text: String) =
    text.forEach { char ->
        val (key, _) = keyOf(char)
        keyDown(key)
        advanceEventTime(20)
        keyUp(key)
        advanceEventTime(150)
    }

@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LoginScreenKeyboardTest {
    @get:Rule val compose = createComposeRule()

    private val session = FakeSession()
    private val preferences = FakePreferences()

    private fun show() {
        val model = LoginViewModel(Login(session, preferences), preferences, PairDevice(session, preferences))
        compose.setContent { LoginScreen(model) }
    }

    @Test fun `QR lido pelo leitor em modo teclado entra sem deixar o codigo no campo`() {
        show()
        val cnpj = compose.onNodeWithText("CNPJ da loja")
        cnpj.performClick()
        cnpj.performKeyInput { scanAsKeyboard(CODE) }
        compose.waitForIdle()

        assertEquals(listOf(CODE), session.pairedCodes)
        // O ScanGuard devolveu o campo ao valor anterior: o código não virou CNPJ.
        cnpj.assert(hasText(""))
    }

    @Test fun `CNPJ digitado por uma pessoa continua sendo CNPJ`() {
        show()
        val cnpj = compose.onNodeWithText("CNPJ da loja")
        cnpj.performClick()
        cnpj.performKeyInput { typeSlowly("11222333000181") }
        compose.waitForIdle()

        assertTrue(session.pairedCodes.isEmpty())
        cnpj.assert(hasText("11222333000181"))
    }

    @Test fun `de volta ao login no mesmo processo, CNPJ e usuario vem preenchidos`() {
        val model = LoginViewModel(Login(session, preferences), preferences, PairDevice(session, preferences))
        var visible by mutableStateOf(true)
        compose.setContent { if (visible) LoginScreen(model) }
        compose.onNodeWithText("CNPJ da loja").assert(hasText(""))

        // Entrou (o acesso fica lembrado), trocou a senha ou saiu, e o login voltou.
        preferences.rememberLogin(LastLogin("37466214000168", "operador"))
        visible = false
        compose.waitForIdle()
        visible = true
        compose.waitForIdle()

        compose.onNodeWithText("CNPJ da loja").assert(hasText("37466214000168"))
        compose.onNodeWithText("Usuário").assert(hasText("operador"))
        compose.onNodeWithText("Senha").assertIsFocused()
    }
}
