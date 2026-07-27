package com.cursorremote.dicktator.car

import android.Manifest
import android.content.pm.PackageManager
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Template
import androidx.core.content.ContextCompat
import com.cursorremote.dicktator.VoiceSessionService
import com.cursorremote.dicktator.api.VoiceApiClient
import com.cursorremote.dicktator.api.VoiceStatus
import java.util.concurrent.Executors

/**
 * Android Auto surface: sticky target + status + Talk / Approve / Later / Hang Up.
 * Matches the overnight car sketch; actions drive the same relay contracts as the phone app.
 */
class DicktatorCarScreen(carContext: CarContext) : Screen(carContext) {
  private val executor = Executors.newSingleThreadExecutor()
  private val client = VoiceApiClient(carContext)
  @Volatile private var statusText = "Idle"
  @Volatile private var targetText = "no target"
  @Volatile private var detailText = "Configure relay URL in the phone app, then Talk."
  @Volatile private var footerText = "DICKTATOR"
  @Volatile private var busy = false

  init {
    refreshStatus()
  }

  override fun onGetTemplate(): Template {
    val talk = Action.Builder()
      .setTitle("Talk")
      .setBackgroundColor(CarColor.DEFAULT)
      .setOnClickListener { onTalk() }
      .build()
    val approve = Action.Builder()
      .setTitle("Approve")
      .setBackgroundColor(CarColor.GREEN)
      .setOnClickListener { onApprove() }
      .build()
    val later = Action.Builder()
      .setTitle("Later")
      .setBackgroundColor(CarColor.DEFAULT)
      .setOnClickListener { onLater() }
      .build()
    val hangUp = Action.Builder()
      .setTitle("Hang Up")
      .setBackgroundColor(CarColor.RED)
      .setOnClickListener { onHangUp() }
      .build()

    return MessageTemplate.Builder("$targetText\n$statusText\n$detailText\n$footerText")
      .setTitle("DICKTATOR")
      .setHeaderAction(Action.APP_ICON)
      .setActionStrip(
        ActionStrip.Builder()
          .addAction(talk)
          .addAction(approve)
          .addAction(later)
          .addAction(hangUp)
          .build(),
      )
      .addAction(
        Action.Builder()
          .setTitle("Refresh")
          .setOnClickListener { refreshStatus() }
          .build(),
      )
      .build()
  }

  private fun onTalk() {
    if (busy) return
    if (ContextCompat.checkSelfPermission(carContext, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      detailText = "Grant microphone permission in the phone app first."
      invalidate()
      return
    }
    if (client.baseUrl().isBlank()) {
      detailText = "Set relay base URL in the phone app."
      invalidate()
      return
    }
    busy = true
    statusText = "Connecting"
    detailText = "Starting WebRTC voice session…"
    invalidate()
    VoiceSessionService.connect(carContext)
    executor.execute {
      Thread.sleep(1500)
      refreshStatus(clearBusy = true)
    }
  }

  private fun onApprove() {
    if (busy) return
    busy = true
    detailText = "Approving pending confirmation…"
    invalidate()
    executor.execute {
      val result = runCatching { client.confirmStoredSession() }
      carContext.mainExecutor.execute {
        result.onSuccess {
          detailText = it?.output ?: "No live session to approve."
          statusText = if (it?.ok == true) "Approved" else "Approve failed"
        }.onFailure { detailText = it.message?.take(120) ?: "Approve failed" }
        busy = false
        refreshStatus()
      }
    }
  }

  private fun onLater() {
    if (busy) return
    busy = true
    detailText = "Deferring pending confirmation…"
    invalidate()
    executor.execute {
      val result = runCatching { client.deferStoredSession() }
      carContext.mainExecutor.execute {
        result.onSuccess {
          detailText = it?.output ?: "No live session to defer."
          statusText = if (it?.ok == true) "Deferred" else "Later failed"
        }.onFailure { detailText = it.message?.take(120) ?: "Later failed" }
        busy = false
        refreshStatus()
      }
    }
  }

  private fun onHangUp() {
    statusText = "Hanging up"
    detailText = "Stopping local audio, then terminating relay session."
    invalidate()
    VoiceSessionService.hangUp(carContext)
    executor.execute {
      Thread.sleep(800)
      refreshStatus(clearBusy = true)
    }
  }

  private fun refreshStatus(clearBusy: Boolean = false) {
    executor.execute {
      val result = runCatching { client.status() }
      carContext.mainExecutor.execute {
        result.onSuccess(::applyStatus).onFailure {
          statusText = "Relay unreachable"
          detailText = it.message?.take(120) ?: "status failed"
        }
        if (clearBusy) busy = false
        invalidate()
      }
    }
  }

  private fun applyStatus(status: VoiceStatus) {
    if (!status.enabled) {
      statusText = "Voice disabled"
      targetText = "no target"
      detailText = "Relay has VOICE_ENABLED off."
      footerText = "DICKTATOR"
      return
    }
    targetText = "Target ${status.targetLabel}"
    statusText = when {
      status.connected -> "Listening"
      else -> status.state.replaceFirstChar { it.uppercase() }
    }
    detailText = status.pendingSummary?.take(160)
      ?: listOfNotNull(status.idleStatus?.let { "Idle: $it" }, status.budgetState?.let { "Budget: $it" })
        .joinToString(" • ")
        .ifBlank { "No pending confirmation." }
    val spend = status.estimatedSpendCents ?: status.reportedSpendCents
    footerText = buildString {
      append("DICKTATOR")
      if (spend != null) append(" • trip ${spend}¢")
      status.remainingBudgetCents?.let { append(" • ${it}¢ left") }
    }
  }
}
