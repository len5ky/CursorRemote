package com.cursorremote.dicktator

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.cursorremote.dicktator.api.VoiceApiClient
import com.cursorremote.dicktator.api.VoiceSession
import com.cursorremote.dicktator.api.VoiceStatus

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    setContent {
      MaterialTheme {
        DicktatorScreen(this@MainActivity, onStopNotification = {
          stopService(Intent(this, VoiceSessionService::class.java))
        })
      }
    }
  }
}

@Composable
private fun DicktatorScreen(activity: MainActivity, onStopNotification: () -> Unit) {
  val client = remember { VoiceApiClient(activity) }
  var baseUrl by remember { mutableStateOf(client.baseUrl()) }
  var bearerToken by remember { mutableStateOf(client.bearerToken()) }
  var password by remember { mutableStateOf("") }
  var status by remember { mutableStateOf("idle") }
  var target by remember { mutableStateOf("no target") }
  var busy by remember { mutableStateOf(false) }

  fun refreshStatus() {
    busy = true
    Thread {
      val result = runCatching { client.status() }
      activity.runOnUiThread {
        result.onSuccess { updateStatus(it, { value -> status = value }, { value -> target = value }) }
          .onFailure { status = shortError(it) }
        busy = false
      }
    }.start()
  }

  fun connect() {
    busy = true
    status = "connecting"
    Thread {
      val result = runCatching {
        client.configure(baseUrl, bearerToken)
        val token = if (client.bearerToken().isBlank() && password.isNotBlank()) client.login(password) else client.bearerToken()
        val admission = client.mintClientSecret()
        client.saveSession(VoiceSession(admission.sessionId, admission.epoch))
        VoiceSessionService.show(activity)
        client.status() to token
      }
      activity.runOnUiThread {
        result.onSuccess { (voiceStatus, token) ->
          updateStatus(voiceStatus, { value -> status = value }, { value -> target = value })
          status = if (voiceStatus.connected) "live" else "admitted"
          bearerToken = token
          password = ""
        }.onFailure { status = shortError(it) }
        busy = false
      }
    }.start()
  }

  fun hangUp() {
    busy = true
    status = "hanging up"
    Thread {
      val result = runCatching { client.terminateStoredSession("client_request") }
      activity.runOnUiThread {
        result.onSuccess {
          client.clearSession()
          onStopNotification()
          status = it?.state ?: "off"
        }.onFailure { status = "local off; retry notification" }
        busy = false
      }
    }.start()
  }

  Column(
    modifier = Modifier.fillMaxSize().padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text("DICKTATOR", style = MaterialTheme.typography.headlineMedium)
    Text("V2 relay-contract client", style = MaterialTheme.typography.bodyMedium)
    AssistChip(onClick = {}, label = { Text(status) }, enabled = false)
    Text("Target: $target", style = MaterialTheme.typography.bodyMedium)
    OutlinedTextField(
      value = baseUrl,
      onValueChange = { baseUrl = it },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Relay base URL") },
      placeholder = { Text("https://cursorremote.example") },
      singleLine = true,
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
    )
    OutlinedTextField(
      value = bearerToken,
      onValueChange = { bearerToken = it },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Bearer token (optional with password)") },
      singleLine = true,
      visualTransformation = PasswordVisualTransformation(),
    )
    OutlinedTextField(
      value = password,
      onValueChange = { password = it },
      modifier = Modifier.fillMaxWidth(),
      label = { Text("Relay password (optional with token)") },
      singleLine = true,
      visualTransformation = PasswordVisualTransformation(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
      Button(onClick = ::connect, enabled = !busy) { Text(if (busy) "Working..." else "Connect") }
      OutlinedButton(onClick = ::hangUp, enabled = !busy) { Text("Hang Up") }
      OutlinedButton(onClick = ::refreshStatus, enabled = !busy) { Text("Refresh") }
    }
  }
}

private fun updateStatus(status: VoiceStatus, setStatus: (String) -> Unit, setTarget: (String) -> Unit) {
  setStatus(if (status.enabled) status.state else "voice disabled")
  setTarget(status.targetLabel)
}

private fun shortError(error: Throwable): String = error.message?.take(80) ?: "request failed"
