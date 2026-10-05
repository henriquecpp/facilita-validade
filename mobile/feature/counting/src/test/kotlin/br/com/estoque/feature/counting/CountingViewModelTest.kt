package br.com.estoque.feature.counting

import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.CountLine
import br.com.estoque.core.domain.CountSession
import br.com.estoque.core.domain.FakeInventory
import br.com.estoque.core.domain.PendingCommand
import br.com.estoque.core.domain.Product
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CountingViewModelTest {
    private val product = Product("yogurt", "Iogurte natural 170g", true)
    private lateinit var repository: FakeInventory
    private var ids = 0

    @Before fun setup() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        repository = FakeInventory().apply { addProduct("789", product) }
    }

    @After fun teardown() {
        Dispatchers.resetMain()
    }

    private fun model() = CountingViewModel(repository, product, { "2026-09-28" }) { "line-${++ids}" }

    private fun CountingViewModel.line(
        quantity: String,
        expiry: String,
        lot: String = "",
    ) {
        update(CountingViewModel.Form(quantity, expiry, lot))
        addLine()
    }

    @Test fun `opening starts a count immediately, without a preparation step`() {
        val model = model()
        assertEquals(
            "COUNTING",
            model.state.value.count
                ?.status,
        )
        assertEquals(1, repository.countSessions.size)
    }

    @Test fun `typing while the count is still opening is kept`() {
        val opened = CompletableDeferred<Unit>()
        repository =
            object : FakeInventory() {
                override suspend fun createCount(productId: String): CountSession {
                    opened.await()
                    return super.createCount(productId)
                }
            }.apply { addProduct("789", product) }
        val model = model()
        assertTrue(model.state.value.busy)
        assertNull(model.state.value.count)
        model.update(CountingViewModel.Form("12", "12042027", ""))
        assertEquals("12", model.state.value.form.quantity)

        opened.complete(Unit)
        assertEquals(
            "COUNTING",
            model.state.value.count
                ?.status,
        )
        assertEquals("12", model.state.value.form.quantity)
        model.addLine()
        assertEquals(listOf(listOf(CountLine("line-1", "2027-04-12", null, 12))), repository.savedLines)
    }

    @Test fun `an open count is resumed instead of creating another`() {
        repository.countSessions =
            mutableListOf(CountSession("open", "yogurt", "COUNTING", 4, listOf(CountLine("a", "2027-04-12", null, 2))))
        val model = model()
        assertEquals(
            "open",
            model.state.value.count
                ?.id,
        )
        assertEquals(2L, model.state.value.total)
    }

    @Test fun `each line is saved on Enter, and the same date in another place is a new line`() {
        val model = model()
        model.line("5", "12042027")
        model.line("10", "12.04.2027", "L-1")
        val lines =
            model.state.value.count!!
                .lines
        assertEquals(listOf(CountLine("line-1", "2027-04-12", null, 5), CountLine("line-2", "2027-04-12", "L-1", 10)), lines)
        assertEquals(15L, model.state.value.total)
        assertTrue(model.state.value.form.isEmpty)
        assertEquals(2, model.state.value.saved)
    }

    @Test fun `concluding with typed but unsaved input asks to save the line first`() {
        val model = model()
        model.update(CountingViewModel.Form(quantity = "3"))
        model.requestConfirm()
        assertFalse(model.state.value.confirming)
        assertTrue(
            model.state.value.error!!
                .contains("salvar a linha"),
        )
    }

    @Test fun `confirming replaces the balance and an empty count declares no units`() {
        val model = model()
        model.requestConfirm()
        assertTrue(model.state.value.confirming)
        model.confirm()
        assertEquals("CONFIRMED", repository.confirmed?.status)
        assertEquals(
            "CONFIRMED",
            model.state.value.finished
                ?.status,
        )
    }

    @Test fun `leaving an empty count cancels it so the product is not blocked`() {
        val model = model()
        assertFalse("sai depois de cancelar", model.leave())
        assertEquals(
            "CANCELLED",
            model.state.value.finished
                ?.status,
        )
        assertTrue(repository.cancelledReason!!.contains("abandonada"))
    }

    @Test fun `leaving a count with lines keeps it open to resume later`() {
        val model = model()
        model.line("5", "12042027")
        assertTrue(model.leave())
        assertNull(repository.cancelledReason)
    }

    @Test fun `a line saved meanwhile on the panel reloads the count and keeps the typed line`() {
        var conflicts = 1
        repository =
            object : FakeInventory() {
                override suspend fun replaceLines(
                    count: CountSession,
                    lines: List<CountLine>,
                ): CountSession {
                    if (conflicts-- > 0) {
                        // O painel salvou a contagem antes: a versão do coletor ficou velha.
                        countSessions =
                            mutableListOf(
                                count.copy(
                                    version = count.version + 1,
                                    lines = listOf(CountLine("web", "2027-05-01", null, 7, "caixa no depósito")),
                                ),
                            )
                        throw AppFailure("A contagem foi alterada. Atualize antes de continuar.", statusCode = 409)
                    }
                    return super.replaceLines(count, lines)
                }
            }.apply { addProduct("789", product) }
        val model = model()
        model.line("5", "12042027")
        val state = model.state.value
        assertEquals(2, state.count!!.version)
        assertEquals(listOf("web"), state.count!!.lines.map { it.id })
        assertEquals("5", state.form.quantity)
        assertFalse(state.uncertain)
        assertTrue(state.error!!.contains("outro aparelho"))
        // Enter de novo: salva sobre a versão nova, sem perder a linha (nem a nota) do painel.
        model.addLine()
        assertEquals(
            listOf(CountLine("web", "2027-05-01", null, 7, "caixa no depósito"), CountLine("line-2", "2027-04-12", null, 5)),
            repository.savedLines.last(),
        )
    }

    @Test fun `a count closed on another device closes the screen on the next save`() {
        repository =
            object : FakeInventory() {
                override suspend fun replaceLines(
                    count: CountSession,
                    lines: List<CountLine>,
                ): CountSession {
                    countSessions = mutableListOf(count.copy(status = "CONFIRMED", version = count.version + 1))
                    throw AppFailure("Contagem já encerrada.", statusCode = 409)
                }
            }.apply { addProduct("789", product) }
        val model = model()
        model.line("5", "12042027")
        assertEquals(
            "CONFIRMED",
            model.state.value.finished
                ?.status,
        )
    }

    @Test fun `a count opened elsewhere at the same moment is resumed`() {
        repository =
            object : FakeInventory() {
                override suspend fun createCount(productId: String): CountSession {
                    countSessions += CountSession("other", productId, "COUNTING", 3, emptyList())
                    throw AppFailure("Já existe contagem em andamento.", statusCode = 409)
                }
            }.apply { addProduct("789", product) }
        val model = model()
        assertEquals(
            "other",
            model.state.value.count
                ?.id,
        )
        assertNull(model.state.value.error)
    }

    @Test fun `uncertain line save is resent and the session reloaded`() {
        val model = model()
        repository.failure = AppFailure("sem resposta", uncertain = true)
        repository.pending = PendingCommand("key", "count.lines", "Salvar linhas da contagem")
        model.line("5", "12042027")
        assertTrue(model.state.value.uncertain)
        repository.failure = null
        model.addLine()
        assertEquals(1, repository.retried)
        assertFalse(model.state.value.uncertain)
        assertTrue(model.state.value.form.isEmpty)
    }
}
