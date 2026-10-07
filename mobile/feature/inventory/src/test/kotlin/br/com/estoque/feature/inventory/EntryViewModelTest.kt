package br.com.estoque.feature.inventory

import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.Entry
import br.com.estoque.core.domain.ExpiryWarning
import br.com.estoque.core.domain.FakeInventory
import br.com.estoque.core.domain.PendingCommand
import br.com.estoque.core.domain.Product
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
class EntryViewModelTest {
    private val product = Product("yogurt", "Iogurte natural 170g", true)
    private lateinit var repository: FakeInventory
    private lateinit var model: EntryViewModel

    @Before fun setup() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        repository = FakeInventory().apply { addProduct("789", product) }
        model = EntryViewModel(repository, product) { "2026-09-28" }
    }

    @After fun teardown() {
        Dispatchers.resetMain()
    }

    private fun fill(
        quantity: String = "6",
        expiry: String = "12/04/2027",
    ) = model.update(EntryViewModel.Form(quantity = quantity, expiry = expiry))

    @Test fun `zero quantity and incomplete date point to the field with the problem`() {
        fill(quantity = "0")
        model.submit()
        assertEquals(EntryViewModel.Field.QUANTITY, model.state.value.errorField)
        fill(expiry = "12/04")
        model.submit()
        assertEquals(EntryViewModel.Field.EXPIRY, model.state.value.errorField)
        assertTrue(repository.receipts.isEmpty())
    }

    @Test fun `past date needs a second Enter before registering`() {
        fill(expiry = "01/09/2026")
        assertFalse(model.checkExpiry())
        assertEquals(ExpiryWarning.PAST, model.state.value.warning)
        assertTrue(model.checkExpiry())
        fill(expiry = "02/09/2026")
        assertFalse("a data alterada volta a pedir confirmação", model.checkExpiry())
    }

    @Test fun `confirmed entry sends ISO date, clears the form and returns focus to quantity`() {
        fill(quantity = "6", expiry = "120427")
        model.update(
            model.state.value.form
                .copy(lot = " L-7 ", note = " caixa amassada "),
        )
        model.submit()
        assertEquals(listOf(Entry("yogurt", 6, "2027-04-12", "L-7", "caixa amassada")), repository.receipts)
        val state = model.state.value
        assertTrue(state.form.isEmpty)
        assertEquals(1, state.saved)
        assertEquals("Entrada registrada: 6 un., validade 12/04/2027.", state.notice)
    }

    @Test fun `uncertain send keeps the form locked and resends the same command`() {
        repository.failure = AppFailure("sem resposta", uncertain = true)
        repository.pending = PendingCommand("key", "inventory.receipt", "Entrada de 6 unidade(s)")
        fill()
        model.submit()
        assertTrue(model.state.value.uncertain)
        fill(quantity = "99")
        assertEquals("formulário travado até confirmar", "6", model.state.value.form.quantity)
        repository.failure = null
        model.submit()
        assertEquals(1, repository.retried)
        assertFalse(model.state.value.uncertain)
        assertTrue(model.state.value.form.isEmpty)
        assertNull(repository.pending)
    }

    @Test fun `definitive server refusal unlocks the form with its message`() {
        repository.failure = AppFailure("Há uma contagem ativa para este produto.", statusCode = 409)
        fill()
        model.submit()
        assertFalse(model.state.value.uncertain)
        assertEquals("Há uma contagem ativa para este produto.", model.state.value.error)
        assertEquals("6", model.state.value.form.quantity)
    }
}
