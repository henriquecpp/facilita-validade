package br.com.estoque.core.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Quadro de referência: 1000 x 800, janela de 88% x 26% no centro. */
class ScanWindowTest {
    private val width = 1000
    private val height = 800

    private fun accepts(
        x: Int,
        y: Int,
    ) = ScanWindow.accepts(x, y, width, height)

    @Test fun `codigo mirado no centro e aceito`() {
        assertTrue(accepts(500, 400))
    }

    @Test fun `codigo do produto vizinho, acima ou abaixo da janela, e recusado`() {
        // A janela tem 26% de 800 = 208px, de y=296 a y=504.
        assertFalse(accepts(500, 290))
        assertFalse(accepts(500, 510))
    }

    @Test fun `codigo deslocado para a lateral e recusado`() {
        // A janela tem 88% de 1000 = 880px, de x=60 a x=940.
        assertFalse(accepts(50, 400))
        assertFalse(accepts(950, 400))
    }

    @Test fun `borda da janela conta como dentro`() {
        assertTrue(accepts(60, 296))
        assertTrue(accepts(940, 504))
    }

    @Test fun `quadro invalido nao aceita nada`() {
        assertFalse(ScanWindow.accepts(0, 0, 0, 0))
        assertFalse(ScanWindow.accepts(10, 10, -5, 100))
    }

    @Test fun `rotacao de noventa graus troca largura e altura`() {
        assertEquals(800 to 1000, ScanWindow.frameSize(1000, 800, 90))
        assertEquals(800 to 1000, ScanWindow.frameSize(1000, 800, 270))
        assertEquals(1000 to 800, ScanWindow.frameSize(1000, 800, 0))
        assertEquals(1000 to 800, ScanWindow.frameSize(1000, 800, 180))
    }

    @Test fun `com o quadro girado a janela acompanha a nova orientacao`() {
        val (w, h) = ScanWindow.frameSize(1000, 800, 90)
        // No quadro girado (800x1000) o centro é 400,500.
        assertTrue(ScanWindow.accepts(400, 500, w, h))
        // 26% de 1000 = 260px de altura: y=370 a y=630. Fora disso, recusa.
        assertFalse(ScanWindow.accepts(400, 360, w, h))
    }
}
