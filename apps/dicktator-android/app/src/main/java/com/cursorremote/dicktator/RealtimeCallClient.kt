package com.cursorremote.dicktator

import com.cursorremote.dicktator.api.VoiceApiException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

data class RealtimeCall(val callId: String, val answerSdp: String)

/** Posts the WebRTC offer directly to OpenAI. Audio stays off the relay. */
class RealtimeCallClient {
  fun createCall(ephemeralKey: String, offerSdp: String): RealtimeCall {
    val connection = (URL(CALLS_URL).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = REQUEST_TIMEOUT_MS
      readTimeout = REQUEST_TIMEOUT_MS
      doOutput = true
      setRequestProperty("Authorization", "Bearer $ephemeralKey")
      setRequestProperty("Content-Type", "application/sdp")
      setRequestProperty("Accept", "application/sdp")
    }
    try {
      connection.outputStream.use { it.write(offerSdp.toByteArray(Charsets.UTF_8)) }
      val statusCode = connection.responseCode
      val body = (if (statusCode in 200..299) connection.inputStream else connection.errorStream)
        ?.bufferedReader()
        ?.use { it.readText() }
        .orEmpty()
      if (statusCode !in 200..299) throw VoiceApiException(statusCode, "OpenAI Realtime call failed (HTTP $statusCode): ${body.take(200)}")
      val callId = callIdFromLocation(connection.getHeaderField("Location"))
        ?: throw VoiceApiException(statusCode, "OpenAI Realtime response did not include a call ID")
      if (body.isBlank()) throw VoiceApiException(statusCode, "OpenAI Realtime response did not include answer SDP")
      return RealtimeCall(callId, body)
    } finally {
      connection.disconnect()
    }
  }

  private companion object {
    const val CALLS_URL = "https://api.openai.com/v1/realtime/calls"
    const val REQUEST_TIMEOUT_MS = 15_000
  }
}

internal fun callIdFromLocation(location: String?): String? {
  val value = location?.trim().orEmpty()
  if (value.isBlank()) return null
  val path = runCatching { URI(value).path }.getOrNull() ?: value.substringBefore('?')
  return path.substringAfterLast('/').takeIf(String::isNotBlank)
}
