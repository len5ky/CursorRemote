package com.cursorremote.dicktator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.cursorremote.dicktator.api.VoiceApiClient
import com.cursorremote.dicktator.api.VoiceSession
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class VoiceSessionService : Service() {
  private val lock = Any()
  private val heartbeatExecutor = Executors.newSingleThreadScheduledExecutor()
  private var heartbeat: ScheduledFuture<*>? = null
  private var webRtcSession: WebRtcSession? = null
  @Volatile private var stopping = false

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_CONNECT -> {
        stopping = false
        showForeground("Connecting to OpenAI Realtime")
        Thread { connect(startId) }.start()
      }
      ACTION_HANG_UP -> {
        showForeground("Disconnecting voice session")
        Thread { hangUp(startId, "notification_action") }.start()
      }
      else -> stopSelf(startId)
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopLocal()
    heartbeatExecutor.shutdownNow()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun connect(startId: Int) {
    val client = VoiceApiClient(applicationContext)
    try {
      val admission = client.mintClientSecret()
      client.saveSession(VoiceSession(admission.sessionId, admission.epoch))
      check(!stopping) { "Voice session cancelled" }

      val localSession = WebRtcSession(applicationContext)
      synchronized(lock) { webRtcSession = localSession }
      val call = localSession.connect(admission.ephemeralValue)
      check(!stopping) { "Voice session cancelled" }

      client.attachCall(call.callId, admission.ephemeralValue, admission.sessionId, admission.epoch)
      check(!stopping) { "Voice session cancelled" }
      startHeartbeat(client, admission.sessionId, admission.epoch)
      showForeground("Voice live")
    } catch (_: Throwable) {
      stopLocal()
      if (!stopping) runCatching { client.terminateStoredSession("connect_failed") }
      client.clearSession()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf(startId)
    }
  }

  private fun startHeartbeat(client: VoiceApiClient, sessionId: String, epoch: Int) {
    heartbeat?.cancel(true)
    heartbeat = heartbeatExecutor.scheduleAtFixedRate(
      { if (!stopping) runCatching { client.heartbeat(sessionId, epoch) } },
      HEARTBEAT_SECONDS,
      HEARTBEAT_SECONDS,
      TimeUnit.SECONDS,
    )
  }

  private fun hangUp(startId: Int, reason: String) {
    stopping = true
    // Local audio must be gone before the relay revokes the remote session.
    stopLocal()
    val client = VoiceApiClient(applicationContext)
    val result = runCatching { client.terminateStoredSession(reason) }
    client.clearSession()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf(startId)
    if (result.isFailure) {
      getSystemService(NotificationManager::class.java)
        .notify(NOTIFICATION_ID, notification("Local audio stopped; relay cleanup unconfirmed", ongoing = false))
    }
  }

  private fun stopLocal() {
    heartbeat?.cancel(true)
    heartbeat = null
    val localSession = synchronized(lock) {
      webRtcSession.also { webRtcSession = null }
    }
    localSession?.stop()
  }

  private fun showForeground(content: String) {
    val value = notification(content, ongoing = true)
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, value, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, value)
    }
  }

  private fun notification(content: String, ongoing: Boolean): Notification {
    createNotificationChannel()
    val hangUpIntent = Intent(this, VoiceSessionService::class.java).setAction(ACTION_HANG_UP)
    val hangUpAction = PendingIntent.getService(
      this,
      0,
      hangUpIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val openAppIntent = PendingIntent.getActivity(
      this,
      1,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_voice_call)
      .setContentTitle("DICKTATOR")
      .setContentText(content)
      .setContentIntent(openAppIntent)
      .setOngoing(ongoing)
      .addAction(Notification.Action.Builder(null, "Hang Up", hangUpAction).build())
      .build()
  }

  private fun createNotificationChannel() {
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "DICKTATOR voice", NotificationManager.IMPORTANCE_LOW),
    )
  }

  companion object {
    const val ACTION_CONNECT = "com.cursorremote.dicktator.CONNECT"
    const val ACTION_HANG_UP = "com.cursorremote.dicktator.HANG_UP"
    private const val CHANNEL_ID = "voice_session"
    private const val NOTIFICATION_ID = 1001
    private const val HEARTBEAT_SECONDS = 10L

    fun connect(context: Context) {
      context.startForegroundService(Intent(context, VoiceSessionService::class.java).setAction(ACTION_CONNECT))
    }

    fun hangUp(context: Context) {
      context.startForegroundService(Intent(context, VoiceSessionService::class.java).setAction(ACTION_HANG_UP))
    }
  }
}
