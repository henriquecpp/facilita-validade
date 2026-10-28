package br.com.estoque.core.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushDestinationTest {
    private val id = "8d451d88-11d9-4529-8aa1-d96c9857701c"

    @Test fun `level notification keeps its filter and general summary opens all lots`() {
        assertEquals(PushDestination.Expiries(id), PushDestination.parse("/expiries?levelId=$id"))
        assertEquals(PushDestination.Expiries(id), PushDestination.parse("/expiries?nivel=$id"))
        assertEquals(PushDestination.Expiries(), PushDestination.parse("/alerts"))
        assertEquals(PushDestination.Expiries(), PushDestination.parse("/expiries"))
        assertEquals(PushDestination.Product(id), PushDestination.parse("/products/$id"))
    }

    @Test fun `ignores external URLs and malformed or unsupported destinations`() {
        listOf(
            "https://example.com/expiries?levelId=$id",
            "//example.com/alerts",
            "/expiries?levelId=invalid",
            "/products/------------------------------------",
            "/products/$id/extra",
            "/settings",
            "",
        ).forEach { assertNull(it, PushDestination.parse(it)) }
    }
}
