package com.cursorremote.dicktator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import com.cursorremote.dicktator.api.VoiceApiClient

class VoiceSessionService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (VoiceApiClient(applicationContext).currentSession() == null) {
      stopSelf(startId)
      return START_NOT_STICKY
    }
    startForeground(NOTIFICATION_ID, notification("Voice session admitted"))
    if (intent?.action == ACTION_HANG_UP) hangUp(startId)
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun hangUp(startId: Int) {
    Thread {
      val client = VoiceApiClient(applicationContext)
      val result = runCatching { client.terminateStoredSession("notification_action") }
      if (result.isSuccess && result.getOrNull() != null) {
        client.clearSession()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
      } else {
        getSystemService(NotificationManager::class.java)
          .notify(NOTIFICATION_ID, notification("Hang Up failed. Tap Hang Up to retry."))
      }
    }.start()
  }

  private fun notification(content: String): Notification {
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
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Hang Up", hangUpAction).build())
      .build()
  }

  private fun createNotificationChannel() {
    getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "DICKTATOR voice", NotificationManager.IMPORTANCE_LOW),
    )
  }

  companion object {
    const val ACTION_SHOW_SESSION = "com.cursorremote.dicktator.SHOW_SESSION"
    const val ACTION_HANG_UP = "com.cursorremote.dicktator.HANG_UP"
    private const val CHANNEL_ID = "voice_session"
    private const val NOTIFICATION_ID = 1001

    fun show(context: Context) {
      context.startForegroundService(
        Intent(context, VoiceSessionService::class.java).setAction(ACTION_SHOW_SESSION),
      )
    }
  }
}
