package br.com.estoque.feature.inventory

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import br.com.estoque.core.domain.ExpiryItem
import br.com.estoque.core.domain.FakeInventory
import br.com.estoque.core.domain.LevelSummary
import br.com.estoque.core.domain.Page
import br.com.estoque.core.domain.UrgencyLevel
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A tela inicial do coletor mostra o trabalho da loja; situação da integração e alertas são do painel. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ExpiriesScreenTest {
    @get:Rule val compose = createComposeRule()

    private val urgent = UrgencyLevel("urgente", "Urgente", "#ef6c00", 0, 5, true)
    private val attention = UrgencyLevel("atencao", "Atenção", "#f9a825", 6, 15, true)

    @Test fun `home shows the store levels as tabs and opens quick entry, without a scan field`() {
        val repository =
            FakeInventory().apply {
                levelSummaries = mutableListOf(LevelSummary(urgent, 1, 3), LevelSummary(attention, 0, 0))
                expiryPages =
                    mutableListOf(
                        Page(listOf(ExpiryItem("r", "p", "Iogurte natural 170g", null, "2026-10-14", "L1", 3, 1, urgent)), null),
                    )
            }
        val model = ExpiriesViewModel(repository)
        var quick = 0
        compose.setContent {
            ExpiriesScreen(
                model,
                "Loja piloto",
                onOpenBarcode = {},
                onOpenProduct = {},
                onQuickEntry = { quick++ },
                onSearch = {},
                onDevice = {},
            )
        }
        compose.waitForIdle()

        compose.onNodeWithText("Iogurte natural 170g").assertIsDisplayed()
        // "Todas" e os níveis da loja com lote; Atenção, vazio, não ocupa espaço.
        compose.onNodeWithText("Todas").assertIsDisplayed()
        compose.onNodeWithText("Urgente").assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithText("Atenção").fetchSemanticsNodes().size)
        // O campo de leitura saiu da tela inicial (AV19).
        assertEquals(0, compose.onAllNodesWithTag("scan").fetchSemanticsNodes().size)
        compose.onNodeWithTag("quick-entry").performClick()
        assertEquals(1, quick)
        for (text in listOf("Vendas", "importa", "Saldos estimados")) {
            assertEquals(text, 0, compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size)
        }
        assertEquals(0, compose.onAllNodesWithContentDescription("Alertas", substring = true).fetchSemanticsNodes().size)
    }
}
