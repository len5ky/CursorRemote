package com.cursorremote.dicktator.api

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class VoiceAdmission(
  val ephemeralValue: String,
  val expiresAt: Long?,
  val sessionId: String,
  val epoch: Int,
)

data class VoiceSession(
  val sessionId: String,
  val epoch: Int,
)

data class VoiceTermination(
  val state: String,
  val providerConfirmed: Boolean,
  val reason: String,
)

data class VoiceStatus(
  val enabled: Boolean,
  val connected: Boolean,
  val state: String,
  val targetLabel: String,
)

class VoiceApiException(val statusCode: Int, message: String) : Exception(message)

/** Direct Kotlin client for the relay's server-authoritative V1 voice HTTP contract. */
class VoiceApiClient(context: Context) {
  private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun baseUrl(): String = preferences.getString(BASE_URL, "") ?: ""

  fun bearerToken(): String = preferences.getString(BEARER_TOKEN, "") ?: ""

  fun configure(baseUrl: String, bearerToken: String) {
    val normalizedUrl = normalizeBaseUrl(baseUrl)
    require(!bearerToken.contains('\n') && !bearerToken.contains('\r')) { "Bearer token is malformed" }
    preferences.edit()
      .putString(BASE_URL, normalizedUrl)
      .putString(BEARER_TOKEN, bearerToken.trim())
      .apply()
  }

  fun login(password: String): String {
    require(password.isNotEmpty()) { "Password is required when no bearer token is supplied" }
    val response = post("/api/login", JSONObject().put("password", password))
    val token = response.optString("token")
    if (token.isBlank()) throw VoiceApiException(200, "Login response did not contain a token")
    preferences.edit().putString(BEARER_TOKEN, token).apply()
    return token
  }

  fun mintClientSecret(): VoiceAdmission {
    val response = post("/api/voice/token", JSONObject())
    val value = response.optString("value")
    val sessionId = response.optString("sessionId")
    if (value.isBlank() || sessionId.isBlank() || !response.has("epoch")) {
      throw VoiceApiException(200, "Voice admission response is missing session data")
    }
    return VoiceAdmission(
      ephemeralValue = value,
      expiresAt = response.optLongOrNull("expiresAt"),
      sessionId = sessionId,
      epoch = response.getInt("epoch"),
    )
  }

  fun attachCall(callId: String, ephemeralKey: String, sessionId: String, epoch: Int) {
    post(
      "/api/voice/call",
      JSONObject()
        .put("callId", callId)
        .put("ephemeralKey", ephemeralKey)
        .put("sessionId", sessionId)
        .put("epoch", epoch),
    )
  }

  fun terminate(sessionId: String, epoch: Int, reason: String): VoiceTermination =
    parseTermination(post("/api/voice/terminate", terminationPayload(sessionId, epoch, reason)))

  fun disconnect(sessionId: String, epoch: Int, reason: String): VoiceTermination =
    parseTermination(post("/api/voice/disconnect", terminationPayload(sessionId, epoch, reason)))

  fun heartbeat(sessionId: String, epoch: Int) {
    post("/api/voice/heartbeat", JSONObject().put("sessionId", sessionId).put("epoch", epoch))
  }

  fun status(): VoiceStatus {
    val response = request("GET", "/api/voice/status")
    val target = response.optJSONObject("target")
    val targetLabel = target?.let {
      listOf(it.optString("windowId"), it.optString("composerId"))
        .filter(String::isNotBlank)
        .joinToString(" / ")
    }.orEmpty().ifBlank { "no target" }
    return VoiceStatus(
      enabled = response.optBoolean("enabled"),
      connected = response.optBoolean("connected"),
      state = response.optString("state", "idle"),
      targetLabel = targetLabel,
    )
  }

  fun saveSession(session: VoiceSession) {
    preferences.edit()
      .putString(SESSION_ID, session.sessionId)
      .putInt(EPOCH, session.epoch)
      .apply()
  }

  fun currentSession(): VoiceSession? {
    val sessionId = preferences.getString(SESSION_ID, "") ?: ""
    val epoch = preferences.getInt(EPOCH, -1)
    return if (sessionId.isNotBlank() && epoch > 0) VoiceSession(sessionId, epoch) else null
  }

  fun terminateStoredSession(reason: String): VoiceTermination? {
    val session = currentSession() ?: return null
    return terminate(session.sessionId, session.epoch, reason)
  }

  fun clearSession() {
    preferences.edit().remove(SESSION_ID).remove(EPOCH).apply()
  }

  private fun terminationPayload(sessionId: String, epoch: Int, reason: String): JSONObject =
    JSONObject().put("sessionId", sessionId).put("epoch", epoch).put("reason", reason)

  private fun parseTermination(response: JSONObject): VoiceTermination = VoiceTermination(
    state = response.optString("state", "failed"),
    providerConfirmed = response.optBoolean("providerConfirmed"),
    reason = response.optString("reason"),
  )

  private fun post(path: String, body: JSONObject): JSONObject = request("POST", path, body.toString())

  private fun request(method: String, path: String, body: String? = null): JSONObject {
    val connection = (URL("${requireBaseUrl()}$path").openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = REQUEST_TIMEOUT_MS
      readTimeout = REQUEST_TIMEOUT_MS
      instanceFollowRedirects = false
      setRequestProperty("Accept", "application/json")
      if (body != null) {
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
      }
      bearerToken().takeIf(String::isNotBlank)?.let { setRequestProperty("Authorization", "Bearer $it") }
    }
    try {
      if (body != null) connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val statusCode = connection.responseCode
      val responseBody = (if (statusCode in 200..299) connection.inputStream else connection.errorStream)
        ?.bufferedReader()
        ?.use { it.readText() }
        .orEmpty()
      if (statusCode !in 200..299) throw VoiceApiException(statusCode, errorMessage(responseBody, statusCode))
      return if (responseBody.isBlank()) JSONObject() else JSONObject(responseBody)
    } finally {
      connection.disconnect()
    }
  }

  private fun requireBaseUrl(): String = baseUrl().ifBlank {
    throw IllegalStateException("Relay base URL has not been configured")
  }

  private fun normalizeBaseUrl(input: String): String {
    val trimmed = input.trim().removeSuffix("/")
    val url = try {
      URL(trimmed)
    } catch (error: Exception) {
      throw IllegalArgumentException("Relay URL must be a valid http(s) URL", error)
    }
    require(url.protocol == "http" || url.protocol == "https") { "Relay URL must use http or https" }
    require(!url.host.isNullOrBlank()) { "Relay URL must include a host" }
    return trimmed
  }

  private fun errorMessage(body: String, statusCode: Int): String {
    val message = runCatching { JSONObject(body).optString("error") }.getOrDefault("")
    return message.ifBlank { "Relay request failed (HTTP $statusCode)" }
  }

  private fun JSONObject.optLongOrNull(name: String): Long? =
    if (isNull(name) || !has(name)) null else optLong(name)

  private companion object {
    const val PREFERENCES = "dicktator_voice"
    const val BASE_URL = "base_url"
    const val BEARER_TOKEN = "bearer_token"
    const val SESSION_ID = "session_id"
    const val EPOCH = "epoch"
    const val REQUEST_TIMEOUT_MS = 5_000
  }
}
