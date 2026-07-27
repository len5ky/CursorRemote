package com.cursorremote.dicktator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RealtimeCallClientTest {
  @Test
  fun `extracts call id from OpenAI location header`() {
    assertEquals("call_123", callIdFromLocation("https://api.openai.com/v1/realtime/calls/call_123"))
  }

  @Test
  fun `returns null when the location header has no call id`() {
    assertNull(callIdFromLocation(null))
    assertNull(callIdFromLocation("https://api.openai.com/v1/realtime/calls/"))
  }
}
