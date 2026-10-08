package br.com.estoque.feature.inventory

import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.CountSession
import br.com.estoque.core.domain.ExpiryItem
import br.com.estoque.core.domain.FakeInventory
import br.com.estoque.core.domain.Inventory
import br.com.estoque.core.domain.LevelSummary
import br.com.estoque.core.domain.Page
import br.com.estoque.core.domain.PendingCommand
import br.com.estoque.core.domain.Product
import br.com.estoque.core.domain.ProductHit
import br.com.estoque.core.domain.StockRecord
import br.com.estoque.core.domain.UrgencyLevel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ListsViewModelTest {
    @Before fun setup() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun teardown() {
        Dispatchers.resetMain()
    }

    private val urgent = UrgencyLevel("urgente", "Urgente", "#ef6c00", 0, 5, true)
    private val expired = UrgencyLevel("vencido", "Vencido", "#c62828", null, -1, true)

    private fun item(
        id: String,
        level: UrgencyLevel? = urgent,
    ) = ExpiryItem(id, "p-$id", "Produto $id", null, "2026-10-01", null, 3, 3, level)

    @Test fun `expiry list pages without repeating records`() {
        val repository =
            FakeInventory().apply {
                expiryPages = mutableListOf(Page(listOf(item("a"), item("b")), "1"), Page(listOf(item("b"), item("c")), null))
            }
        val model = ExpiriesViewModel(repository)
        model.refresh()
        model.loadMore()
        assertEquals(
            listOf("a", "b", "c"),
            model.state.value.items
                .map { it.recordId },
        )
        assertNull(model.state.value.nextCursor)
    }

    @Test fun `pending command is shown and resent with the same key`() {
        val repository =
            FakeInventory().apply { pending = PendingCommand("key", "inventory.receipt", "Entrada de 6 unidade(s)") }
        val model = ExpiriesViewModel(repository)
        model.refresh()
        assertEquals(
            "Entrada de 6 unidade(s)",
            model.state.value.pending
                ?.description,
        )
        model.resendPending()
        assertEquals(1, repository.retried)
        assertNull(model.state.value.pending)
    }

    @Test fun `unknown barcode explains that the product is not registered`() {
        val model = ProductViewModel(FakeInventory(), ProductKey.Barcode("000123"))
        model.load()
        assertTrue(
            model.state.value.error!!
                .contains("000123 não está no catálogo da loja"),
        )
    }

    @Test fun `open count is detected so entries are not offered`() {
        val product = Product("yogurt", "Iogurte", true)
        val repository =
            FakeInventory().apply {
                addProduct("789", product)
                countSessions = mutableListOf(CountSession("count", "yogurt", "COUNTING", 3, emptyList()))
            }
        val model = ProductViewModel(repository, ProductKey.Barcode("789"))
        model.load()
        assertEquals(
            "count",
            model.state.value.openCount
                ?.id,
        )
        assertEquals(
            "yogurt",
            model.state.value.inventory
                ?.product
                ?.id,
        )
    }

    @Test fun `server failure keeps its message`() {
        val repository = FakeInventory().apply { failure = AppFailure("Sem conexão com o servidor.") }
        val model = ExpiriesViewModel(repository)
        model.refresh()
        assertEquals("Sem conexão com o servidor.", model.state.value.error)
    }

    @Test fun `each level tab asks the server only for its own lots`() {
        val repository =
            FakeInventory().apply {
                levelSummaries = mutableListOf(LevelSummary(expired, 1, 3), LevelSummary(urgent, 2, 6))
                expiryPages = mutableListOf(Page(listOf(item("a", expired), item("b"), item("c")), null))
                levelPages["urgente"] = mutableListOf(Page(listOf(item("b"), item("c")), null))
            }
        val model = ExpiriesViewModel(repository)
        model.refresh()
        assertEquals(
            listOf("Vencido", "Urgente"),
            model.state.value.tabs
                .map { it.level.name },
        )
        model.select("urgente")
        assertEquals(
            listOf("b", "c"),
            model.state.value.items
                .map { it.recordId },
        )
        assertEquals(null to "urgente", repository.expiryRequests.last())
        assertFalse(model.state.value.hasMore)
        // Nível que a loja apagou no painel: a tela volta para "Todas".
        repository.levelSummaries = mutableListOf(LevelSummary(expired, 1, 3))
        model.refresh()
        assertNull(model.state.value.selected)
        assertEquals(3, model.state.value.items.size)
    }

    @Test fun `notification opens only the chosen level even when it currently has no lots`() {
        val repository =
            FakeInventory().apply {
                levelSummaries = mutableListOf(LevelSummary(expired, 1, 3), LevelSummary(urgent, 0, 0))
                levelPages["urgente"] = mutableListOf(Page(emptyList(), null))
            }
        val model = ExpiriesViewModel(repository, initialLevelId = "urgente")
        model.refresh()
        assertEquals(listOf(null to "urgente"), repository.expiryRequests)
        assertEquals("urgente", model.state.value.selected)
        assertEquals(
            listOf("vencido", "urgente"),
            model.state.value.tabs
                .map { it.level.id },
        )
        assertTrue(model.state.value.loaded)
        assertTrue(
            model.state.value.items
                .isEmpty(),
        )
    }

    @Test fun `old notification of a deleted level falls back to all lots`() {
        val repository =
            FakeInventory().apply {
                levelSummaries = mutableListOf(LevelSummary(expired, 1, 3))
                expiryPages = mutableListOf(Page(listOf(item("a", expired)), null))
            }
        val model = ExpiriesViewModel(repository, initialLevelId = "removed")
        model.refresh()
        assertNull(model.state.value.selected)
        assertEquals(listOf(null to null), repository.expiryRequests)
        assertEquals(
            listOf("a"),
            model.state.value.items
                .map { it.recordId },
        )
    }

    @Test fun `quick entry opens the form of a tracked product and the initial count of an untracked one`() {
        val tracked = Product("yogurt", "Iogurte", true)
        val fresh = Product("greek", "Iogurte grego", true)
        val repository =
            FakeInventory().apply {
                addProduct("789", tracked)
                addProduct("790", fresh, Inventory(fresh, "UNTRACKED", emptyList(), 0, false))
            }
        val model = QuickEntryViewModel(repository)
        model.scan("789")
        assertEquals(
            "yogurt",
            model.state.value.product
                ?.id,
        )
        model.saved("Iogurte: 6 un.")
        assertNull(model.state.value.product)
        assertEquals(listOf("Iogurte: 6 un."), model.state.value.recent)
        // Sem contagem inicial, o lançamento rápido abre a contagem do produto (AV19).
        model.scan("790")
        assertNull(model.state.value.product)
        assertEquals(
            "greek",
            model.state.value.initialCount
                ?.id,
        )
        model.initialCountOpened()
        assertNull(model.state.value.initialCount)
        model.scan("000")
        assertTrue(
            model.state.value.error!!
                .contains("pesquise pela descrição"),
        )
    }

    @Test fun `lot write-off and deletion go to the server and reload the product`() {
        val product = Product("yogurt", "Iogurte", true)
        val lot = StockRecord("lot-a", "2027-04-12", null, 10, launchedQuantity = 12, soldQuantity = 2)
        val other = StockRecord("lot-b", "2027-05-12", null, 4)
        val repository = FakeInventory().apply { addProduct("789", product, Inventory(product, "TRACKED", listOf(lot, other), 14, false)) }
        val model = ProductViewModel(repository, ProductKey.Barcode("789"))
        model.load()
        model.writeOff(lot, 3, " vencido na gôndola ")
        assertEquals(listOf(Triple("lot-a", 3, "vencido na gôndola")), repository.writeOffs)
        assertEquals(
            7,
            model.state.value.inventory!!
                .records
                .first { it.id == "lot-a" }
                .quantity,
        )
        assertEquals("Baixa de 3 un. do lote 12/04/2027 registrada.", model.state.value.notice)
        model.writeOff(
            model.state.value.inventory!!
                .records
                .first(),
            99,
            null,
        )
        assertTrue(
            model.state.value.error!!
                .contains("de 1 a 7"),
        )
        model.delete(other)
        assertEquals(listOf("lot-b"), repository.deleted)
        assertEquals(
            listOf("lot-a"),
            model.state.value.inventory!!
                .records
                .map { it.id },
        )
    }

    @Test fun `EAN-13 with a wrong check digit is never looked up`() {
        val repository = FakeInventory().apply { addProduct("7894900011609", Product("coca", "Coca-Cola 600ml", true)) }
        val quick = QuickEntryViewModel(repository)
        quick.scan("7894900011608")
        assertTrue(
            quick.state.value.error!!
                .contains("não é um EAN-13 válido"),
        )
        val product = ProductViewModel(repository, ProductKey.Barcode("7894900011608"))
        product.load()
        assertTrue(
            product.state.value.error!!
                .contains("não é um EAN-13 válido"),
        )
        assertTrue(repository.lookups.isEmpty())
        // O código que confere é consultado.
        quick.scan("7894900011609")
        assertEquals(listOf("7894900011609"), repository.lookups)
    }

    @Test fun `search opened with a name shows its results right away and does not repeat it`() =
        runTest {
            Dispatchers.setMain(StandardTestDispatcher(testScheduler))
            val repository =
                FakeInventory().apply {
                    searchResults = mutableListOf(ProductHit("p1", "Coca-Cola 600ml", "7894900011609", false, 0, null))
                }
            val model = SearchViewModel(repository, "coca")
            runCurrent()
            assertEquals(listOf("coca"), repository.searches)
            assertEquals("coca", model.state.value.text)
            // Um espaço a mais não muda a busca.
            model.type("coca ")
            advanceUntilIdle()
            assertEquals(listOf("coca"), repository.searches)
            // EAN-13 com o último dígito errado não vai ao servidor.
            model.type("7894900011608")
            advanceUntilIdle()
            assertEquals(listOf("coca"), repository.searches)
            assertTrue(
                model.state.value.error!!
                    .contains("não é um EAN-13 válido"),
            )
        }

    @Test fun `search waits for two letters and asks only for the last text typed`() =
        runTest {
            Dispatchers.setMain(StandardTestDispatcher(testScheduler))
            val repository =
                FakeInventory().apply {
                    searchResults = mutableListOf(ProductHit("p1", "Iogurte morango", "789", true, 6, "2027-04-12"))
                }
            val model = SearchViewModel(repository)
            model.type("i")
            advanceUntilIdle()
            assertTrue(repository.searches.isEmpty())
            model.type("io")
            model.type("iog")
            advanceUntilIdle()
            assertEquals(listOf("iog"), repository.searches)
            assertEquals(
                listOf("p1"),
                model.state.value.items
                    .map { it.productId },
            )
        }
}
