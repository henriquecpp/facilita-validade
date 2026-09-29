package br.com.estoque.core.ui

import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** O campo de leitura aceita o código ou, onde há pesquisa, o nome do produto. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ScanFieldTest {
    @get:Rule val compose = createComposeRule()

    private val scans = mutableListOf<String>()
    private val searches = mutableListOf<String>()

    private fun show(search: Boolean) {
        compose.setContent {
            ScanField(
                state = rememberTextFieldState(),
                onScan = { scans += it },
                focusRequester = remember { FocusRequester() },
                modifier = Modifier.testTag("scan"),
                onSearch = if (search) ({ searches += it }) else null,
            )
        }
    }

    private fun submit(text: String) {
        compose.onNodeWithTag("scan").performTextInput(text)
        compose.onNodeWithTag("scan").performImeAction()
        compose.waitForIdle()
    }

    @Test fun `a name opens the search and digits are a code, spaces ignored`() {
        show(search = true)
        submit("iogurte morango")
        submit("7 894900 011609")
        assertEquals(listOf("iogurte morango"), searches)
        assertEquals(listOf("7894900011609"), scans)
    }

    @Test fun `without a search, any text is a code`() {
        show(search = false)
        submit("ABC-123")
        assertEquals(listOf("ABC-123"), scans)
        assertEquals(emptyList<String>(), searches)
    }
}
