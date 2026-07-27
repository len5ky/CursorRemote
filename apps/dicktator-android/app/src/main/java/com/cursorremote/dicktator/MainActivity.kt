package com.cursorremote.dicktator

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
import com.cursorremote.dicktator.api.VoiceStatus

class MainActivity : ComponentActivity() {
  private var onMicrophoneDenied: (() -> Unit)? = null
  private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    if (granted) VoiceSessionService.connect(this) else onMicrophoneDenied?.invoke()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    setContent { MaterialTheme { DicktatorScreen(this@MainActivity) } }
  }

  fun connectVoice(onDenied: () -> Unit) {
    onMicrophoneDenied = onDenied
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      VoiceSessionService.connect(this)
    } else {
      microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
    }
  }
}

@Composable
private fun DicktatorScreen(activity: MainActivity) {
  val client = remember { VoiceApiClient(activity) }
  var baseUrl by remember { mutableStateOf(client.baseUrl()) }
  var bearerToken by remember { mutableStateOf(client.bearerToken()) }
  var password by remember { mutableStateOf("") }
  var status by remember { mutableStateOf("idle") }
  var voiceStatus by remember { mutableStateOf<VoiceStatus?>(null) }
  var busy by remember { mutableStateOf(false) }

  fun applyStatus(value: VoiceStatus) {
    voiceStatus = value
    status = if (value.enabled) value.state else "voice disabled"
  }

  fun refreshStatus() {
    busy = true
    Thread {
      val result = runCatching { client.status() }
      activity.runOnUiThread {
        result.onSuccess(::applyStatus).onFailure { status = shortError(it) }
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
        if (client.bearerToken().isBlank() && password.isNotBlank()) client.login(password) else client.bearerToken()
      }
      activity.runOnUiThread {
        result.onSuccess {
          bearerToken = it
          password = ""
          activity.connectVoice { status = "microphone permission is required" }
        }.onFailure { status = shortError(it) }
        busy = false
      }
    }.start()
  }

  fun hangUp() {
    status = "hanging up"
    VoiceSessionService.hangUp(activity)
  }

  Column(
    modifier = Modifier.fillMaxSize().padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text("DICKTATOR", style = MaterialTheme.typography.headlineMedium)
    Text("Native WebRTC voice client", style = MaterialTheme.typography.bodyMedium)
    AssistChip(onClick = {}, label = { Text(status) }, enabled = false)
    Text("Target: ${voiceStatus?.targetLabel ?: "no target"}", style = MaterialTheme.typography.bodyMedium)
    Text("Session: ${voiceStatus?.state ?: status}", style = MaterialTheme.typography.bodyMedium)
    voiceStatus?.idleStatus?.let { Text("Idle: $it", style = MaterialTheme.typography.bodyMedium) }
    voiceStatus?.budgetState?.let { budgetState ->
      val remaining = voiceStatus?.remainingBudgetCents?.let { "${it}c remaining" } ?: "remaining budget unavailable"
      Text("Budget: $budgetState, $remaining", style = MaterialTheme.typography.bodyMedium)
    }
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

private fun shortError(error: Throwable): String = error.message?.take(80) ?: "request failed"
