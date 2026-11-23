package com.engadapochu.app

import org.junit.Assert.*
import org.junit.Test

class VoiceParserTest {
    @Test fun parsesEnglishSent() {
        val result = VoiceParser.parse("sent 500 to Ravi").getOrThrow()
        assertEquals("SENT", result.type)
        assertEquals(50_000L, result.amountMinor)
        assertTrue(result.person.contains("Ravi", ignoreCase = true))
    }
    @Test fun parsesEnglishReceived() {
        val result = VoiceParser.parse("received 1200 from Kumar").getOrThrow()
        assertEquals("RECEIVED", result.type)
        assertEquals(120_000L, result.amountMinor)
    }
    @Test fun parsesTamilTransliteration() {
        val result = VoiceParser.parse("Ravi ku 500 anuppinen").getOrThrow()
        assertEquals("SENT", result.type)
        assertEquals(50_000L, result.amountMinor)
    }
    @Test fun rejectsInvalidAmountsAndMissingFields() {
        assertTrue(VoiceParser.parse("sent 0 to Ravi").isFailure)
        assertTrue(VoiceParser.parse("sent -10 to Ravi").isFailure)
        assertTrue(VoiceParser.parse("sent to Ravi").isFailure)
        assertTrue(VoiceParser.parse("500 Ravi").isFailure)
    }
    @Test fun handlesDecimalAndRejectsOverlargeMoney() {
        assertEquals(12_345L, VoiceParser.parse("sent 123.45 to Ravi").getOrThrow().amountMinor)
        assertTrue(VoiceParser.parse("sent 999999999999999999999999 to Ravi").isFailure)
    }
}
