package com.cogolfers.cg_streamer

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
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service shown while the camera is live. It does not own the stream (StreamEngine
 * does); it tells Android this app is actively using the camera and microphone so capture
 * continues with the screen off, and shows the persistent "camera is live" notification.
 *
 * Android 14+ requires FOREGROUND_SERVICE_CAMERA/MICROPHONE and that the service is started
 * while the app is visible, which is the case: it starts when the operator taps Go Live.
 */
class CgStreamService : Service() {

    companion object {
        private const val CHANNEL_ID = "cg_streamer_live"
        private const val NOTIFICATION_ID = 4711
        const val EXTRA_TITLE = "title"

        fun start(context: Context, title: String) {
            val intent = Intent(context, CgStreamService::class.java).putExtra(EXTRA_TITLE, title)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CgStreamService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "CoGolfer camera is live"
        val notification = buildNotification(title)
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // The operator swiped the app away: stop publishing rather than leave a zombie stream.
        StreamEngine.stop()
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    private fun buildNotification(title: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Live camera", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while this phone is streaming to the CoGolfer control room."
                },
            )
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pending = launch?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText("Camera and microphone are being streamed. Open the app to stop.")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(pending)
            .build()
    }
}
