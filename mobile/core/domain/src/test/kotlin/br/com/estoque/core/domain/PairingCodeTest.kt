package br.com.estoque.core.domain

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingCodeTest {
    private val code = "estoque-pair:1:" + "a".repeat(43)

    @Test fun `reconhece o codigo de acesso, inclusive com espaco e quebra de linha do leitor`() {
        assertTrue(PairingCode.recognizes(code))
        assertTrue(PairingCode.recognizes("  $code\r\n"))
    }

    @Test fun `aceita versao futura porque quem valida o formato e o servidor`() {
        assertTrue(PairingCode.recognizes("estoque-pair:2:qualquer-coisa"))
    }

    @Test fun `nao confunde com codigo de produto nem com QR de outro sistema`() {
        assertFalse(PairingCode.recognizes("7890000000017"))
        assertFalse(PairingCode.recognizes("https://exemplo.com"))
        assertFalse(PairingCode.recognizes(""))
    }

    @Test fun `pareamento envia o codigo sem espacos`() =
        runTest {
            val session = FakeSession()
            PairDevice(session)("  $code\n")
            assertEquals(listOf(code), session.pairedCodes)
        }

    @Test fun `pareamento recusa o que nao e codigo de acesso antes de ir a rede`() =
        runTest {
            val session = FakeSession()
            assertThrows(IllegalArgumentException::class.java) {
                kotlinx.coroutines.runBlocking { PairDevice(session)("7890000000017") }
            }
            assertTrue(session.pairedCodes.isEmpty())
        }
}
