package dev.yardbell.notify

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
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicInteger

// Keeps a long poll open to each paired Yardbell server and shows what it sends as Android
// notifications, so the phone needs no push service: the servers are only reachable over the
// mesh VPN anyway.
class NotifyService : Service() {
  private val watching = mutableMapOf<String, Thread>()
  private val ids = AtomicInteger(100)
  @Volatile private var running = true
  private var manager: Thread? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    channels(this)
    val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
    ServiceCompat.startForeground(this, WATCHING_ID, watchingNotice(), type)
    manager = Thread({ manage() }, "yardbell-notify").also { it.start() }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  override fun onDestroy() {
    running = false
    manager?.interrupt()
    synchronized(watching) { watching.values.forEach { it.interrupt() } }
    super.onDestroy()
  }

  private fun manage() {
    while (running) {
      val servers = signedIn(this)
      if (servers.isEmpty()) {
        stopSelf()
        return
      }
      synchronized(watching) {
        for ((server, token) in servers) {
          if (watching[server]?.isAlive == true) continue
          watching[server] = Thread({ watch(server, token) }, "yardbell-notify-$server").also { it.start() }
        }
      }
      try {
        Thread.sleep(30_000)
      } catch (_: InterruptedException) {
        return
      }
    }
  }

  private fun watch(server: String, token: String) {
    val prefs = getSharedPreferences("notify", Context.MODE_PRIVATE)
    var backoff = 5_000L
    while (running) {
      if (signedIn(this)[server] != token) return
      val boot = prefs.getString("$server boot", null)
      val after = prefs.getLong("$server next", 0)
      try {
        val page = poll(server, token, boot, after)
        if (page == null) {
          signedOut(server, token)
          return
        }
        val notes = page.optJSONArray("notes") ?: JSONArray()
        for (i in 0 until notes.length()) show(notes.getJSONObject(i))
        prefs.edit()
          .putString("$server boot", page.getString("boot"))
          .putLong("$server next", page.getLong("next"))
          .apply()
        backoff = 5_000L
      } catch (_: InterruptedException) {
        return
      } catch (_: Exception) {
        try {
          Thread.sleep(backoff)
        } catch (_: InterruptedException) {
          return
        }
        backoff = (backoff * 2).coerceAtMost(60_000L)
      }
    }
  }

  // Returns null when the server no longer accepts the token, which ends the watch.
  private fun poll(server: String, token: String, boot: String?, after: Long): JSONObject? {
    val query = if (boot == null) "" else "?boot=${URLEncoder.encode(boot, "UTF-8")}&after=$after"
    val conn = URL("$server/app/notifications$query").openConnection() as HttpURLConnection
    try {
      conn.connectTimeout = 15_000
      conn.readTimeout = 80_000
      conn.setRequestProperty("Accept", "application/json")
      conn.setRequestProperty("Authorization", "Bearer $token")
      return when (val code = conn.responseCode) {
        200 -> JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        401 -> null
        else -> throw java.io.IOException("server answered $code")
      }
    } finally {
      conn.disconnect()
    }
  }

  private fun signedOut(server: String, token: String) {
    if (!forget(this, server, token)) return
    post("Yardbell", "This phone was signed out of $server. Open the app to pair again.", NotificationCompat.PRIORITY_HIGH, null)
  }

  private fun show(note: JSONObject) {
    val priority = if (note.optInt("priority", 3) >= 4) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT
    val click = if (note.isNull("click")) null else note.optString("click").ifEmpty { null }
    post(note.optString("title", "Yardbell"), note.optString("message"), priority, click)
  }

  private fun post(title: String, message: String, priority: Int, click: String?) {
    val id = ids.incrementAndGet()
    val launch = launchIntent(this).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (click != null) launch.putExtra(CLICK, click)
    // Each notice gets its own request code, or Android reuses one PendingIntent and every tap
    // opens the link of the newest notice.
    val open = PendingIntent.getActivity(this, id, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notice = NotificationCompat.Builder(this, ALERTS)
      .setSmallIcon(R.drawable.ic_notify)
      .setContentTitle(title)
      .setContentText(message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(message))
      .setPriority(priority)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    val notifications = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 24 && !notifications.areNotificationsEnabled()) return
    notifications.notify(id, notice)
  }

  private fun watchingNotice(): Notification {
    val open = PendingIntent.getActivity(this, 0, launchIntent(this), PendingIntent.FLAG_IMMUTABLE)
    return NotificationCompat.Builder(this, WATCHING)
      .setSmallIcon(R.drawable.ic_notify)
      .setContentTitle("Watching your agents")
      .setContentText("Yardbell tells you when an agent needs you.")
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setOngoing(true)
      .setContentIntent(open)
      .build()
  }

  companion object {
    private const val WATCHING = "watching"
    private const val ALERTS = "alerts"
    private const val WATCHING_ID = 1
    private const val CLICK = "dev.yardbell.notify.click"
    private const val SERVERS = "servers"
    private val serversLock = Any()

    fun start(context: Context) {
      if (signedIn(context).isEmpty()) return
      try {
        ContextCompat.startForegroundService(context, Intent(context, NotifyService::class.java))
      } catch (_: Exception) {
        // Android refuses to start it while the app is in the background; the next launch does.
      }
    }

    fun setServers(context: Context, servers: Map<String, String>) {
      synchronized(serversLock) { write(context, servers) }
      if (servers.isEmpty()) {
        context.stopService(Intent(context, NotifyService::class.java))
      } else {
        start(context)
      }
    }

    fun takeClick(intent: Intent): String? {
      val click = intent.getStringExtra(CLICK) ?: return null
      intent.removeExtra(CLICK)
      return click
    }

    fun signedIn(context: Context): Map<String, String> {
      val raw = prefs(context).getString(SERVERS, null) ?: return emptyMap()
      return try {
        val list = JSONArray(raw)
        (0 until list.length())
          .map { list.getJSONObject(it) }
          .filter { it.optString("token").isNotEmpty() }
          .associate { it.getString("address") to it.getString("token") }
      } catch (_: Exception) {
        emptyMap()
      }
    }

    // False when the list already moved on (the server was removed or re-paired with a new
    // token), so a stale watch does not drop the new pairing or announce a sign-out twice.
    private fun forget(context: Context, server: String, token: String): Boolean = synchronized(serversLock) {
      val servers = signedIn(context)
      if (servers[server] != token) return@synchronized false
      write(context, servers - server)
      true
    }

    private fun write(context: Context, servers: Map<String, String>) {
      val list = JSONArray()
      for ((address, token) in servers) list.put(JSONObject().put("address", address).put("token", token))
      prefs(context).edit().putString(SERVERS, list.toString()).commit()
    }

    private fun prefs(context: Context) = context.getSharedPreferences("notify-servers", Context.MODE_PRIVATE)

    private fun launchIntent(context: Context): Intent =
      context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: throw IllegalStateException("${context.packageName} has no launcher activity")

    private fun channels(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val notifications = context.getSystemService(NotificationManager::class.java)
      notifications.createNotificationChannel(
        NotificationChannel(ALERTS, "Agents and machines", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "An agent is waiting, a session ended, a machine went down or memory ran low"
        },
      )
      notifications.createNotificationChannel(
        NotificationChannel(WATCHING, "Watching in the background", NotificationManager.IMPORTANCE_MIN).apply {
          description = "Android needs this to keep Yardbell connected. You can hide it."
        },
      )
    }
  }
}
