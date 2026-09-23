package br.com.estoque.core.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** Mesmos casos do painel web (`contracts/fixtures/expiry-input.json`). */
class ExpiryInputTest {
    private val fixtures: JsonObject =
        Json
            .parseToJsonElement(File(System.getProperty("fixtures.dir"), "expiry-input.json").readText())
            .jsonObject

    private fun cases(name: String): List<Pair<String, String?>> =
        fixtures.getValue(name).jsonArray.map {
            val pair = it as JsonArray
            val expected = pair[1]
            pair[0].jsonPrimitive.content to if (expected is JsonNull) null else expected.jsonPrimitive.content
        }

    @Test fun `mask matches the shared cases`() {
        cases("mask").forEach { (typed, shown) -> assertEquals("máscara de '$typed'", shown, ExpiryInput.mask(typed)) }
    }

    @Test fun `parse matches the shared cases`() {
        cases("parse").forEach { (typed, iso) -> assertEquals("leitura de '$typed'", iso, ExpiryInput.parse(typed)) }
    }

    @Test fun `warning matches the shared cases`() {
        val today = fixtures.getValue("today").jsonPrimitive.content
        cases("warning").forEach { (iso, warning) ->
            assertEquals("aviso de '$iso'", warning, ExpiryInput.warning(iso, today)?.name)
        }
    }

    @Test fun `typing key by key reaches the same value as pasting`() {
        var shown = ""
        "1.4.2026".forEach { shown = ExpiryInput.mask(shown + it) }
        assertEquals("01/04/2026", shown)
        assertEquals("2026-04-01", ExpiryInput.parse(shown))
    }
}
