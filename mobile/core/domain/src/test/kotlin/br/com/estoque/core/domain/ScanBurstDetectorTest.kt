package br.com.estoque.core.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanBurstDetectorTest {
    private fun ScanBurstDetector.type(
        text: String,
        startAt: Long,
        intervalMillis: Long,
    ): Long {
        var at = startAt
        text.forEach {
            onCharacter(it, at)
            at += intervalMillis
        }
        return at - intervalMillis
    }

    @Test fun `scanner speed burst ending in Enter is a scan`() {
        val detector = ScanBurstDetector()
        val last = detector.type("7891234567895", 1_000, 8)
        assertEquals("7891234567895", detector.onEnter(last + 10))
    }

    @Test fun `human typing is not a scan`() {
        val detector = ScanBurstDetector()
        val last = detector.type("12", 1_000, 180)
        assertNull(detector.onEnter(last + 200))
    }

    @Test fun `a burst after human typing starts a new sequence`() {
        val detector = ScanBurstDetector()
        assertTrue(detector.onCharacter('1', 1_000))
        assertFalse(detector.onCharacter('2', 1_020))
        assertTrue(detector.onCharacter('7', 2_000))
        val last = detector.type("891234567895", 2_008, 8)
        assertEquals("7891234567895", detector.onEnter(last + 5))
    }

    @Test fun `short bursts are not scans`() {
        val detector = ScanBurstDetector()
        val last = detector.type("12", 1_000, 5)
        assertNull(detector.onEnter(last + 5))
    }
}
