package br.com.estoque.core.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Mesmos textos do painel web (`shared/lib/risk.ts`, `forecastText`). */
class ForecastTest {
    private fun lot(
        quantity: Long,
        leftover: Long?,
    ) = ExpiryItem("r", "p", "Iogurte", null, "2026-12-01", null, quantity, 10, forecastLeftover = leftover)

    @Test
    fun `diz se o lote deve vender antes de vencer ou quanto deve sobrar`() {
        assertNull(lot(10, null).forecast())
        assertEquals("Deve vender antes de vencer" to true, lot(10, 0).forecast())
        assertEquals("Deve sobrar 1 unidade" to false, lot(10, 1).forecast())
        assertEquals("Deve sobrar 4 unidades" to false, lot(10, 4).forecast())
        assertEquals("Não deve vender até a validade" to false, lot(10, 10).forecast())
    }
}
