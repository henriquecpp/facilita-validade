package br.com.estoque.core.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ValidationTest {
    @Test fun `numeric CNPJ retains leading zeros and validates digits`() {
        assertTrue(Cnpj.isValid("04.252.011/0001-10"))
        assertEquals("04252011000110", Cnpj.normalize("04.252.011/0001-10"))
        assertFalse(Cnpj.isValid("04.252.011/0001-11"))
        assertFalse(Cnpj.isValid("00000000000000"))
    }

    @Test fun `official alphanumeric example preserves letters`() {
        assertTrue(Cnpj.isValid("12.ABC.345/01DE-35"))
        assertTrue(Cnpj.isValid("12.abc.345/01de-35"))
        assertFalse(Cnpj.isValid("12.ABC.345/01DE-36"))
        assertFalse(Cnpj.isValid("12@ABC34501DE35"))
    }

    @Test fun `ISO dates validate the real calendar and display in Brazilian format`() {
        assertTrue(ExpiryDate.isValidIso("2028-02-29"))
        assertFalse(ExpiryDate.isValidIso("2027-02-29"))
        assertFalse(ExpiryDate.isValidIso("2028-04-31"))
        assertEquals("12/04/2026", ExpiryDate.format("2026-04-12"))
    }

    @Test fun `EAN-13 check digit is verified, and only for 13-digit codes`() {
        for (code in listOf("7894900011609", "7891025121923", "7506306241183", "0000000000000")) {
            assertFalse(code, Ean13.invalid(code))
        }
        assertTrue(Ean13.invalid("7894900011608"))
        assertTrue(Ean13.invalid("7891025121920"))
        // EAN-8, UPC-A, GTIN-14 e códigos internos seguem para a consulta.
        for (code in listOf("78908901", "041333001005", "07891025121923", "0418", "78949000116X")) {
            assertFalse(code, Ean13.invalid(code))
        }
    }

    @Test fun `scanner deduplicates frames and preserves barcode zeros`() {
        val gate = BarcodeGate()
        assertEquals("0012345", gate.accept("0012345\r\n", 1000))
        assertNull(gate.accept("0012345", 1500))
        assertEquals("987", gate.accept("987", 1600))
        assertEquals("0012345", gate.accept("0012345", 1700))
        assertNull(gate.accept("12\u000034", 3000))
    }
}
