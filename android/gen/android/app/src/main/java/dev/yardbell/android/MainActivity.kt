package dev.yardbell.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Android's web view does not report the status bar as a safe area on every version, so pages
    // scrolled under it. The bars and the keyboard are kept off the page here instead.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    paintBars(getSharedPreferences("app", Context.MODE_PRIVATE).getString("theme", null) ?: systemTheme())
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
  }

  // Yardbell's pages can be set to light or dark apart from the phone, so they say which one they
  // show and the bars around them follow.
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Theme(), "YardbellApp")
  }

  // The page cannot tell the app went to the background, and a terminal left open there would
  // keep the session sized for the phone.
  private fun tellPage(state: String) {
    webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('yardbell-app', { detail: '$state' }))", null)
  }

  inner class Theme {
    @JavascriptInterface
    fun theme(name: String) {
      if (name != "dark" && name != "light") return
      getSharedPreferences("app", Context.MODE_PRIVATE).edit().putString("theme", name).apply()
      runOnUiThread { paintBars(name) }
    }
  }

  private fun systemTheme(): String {
    val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    return if (night == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"
  }

  private fun paintBars(theme: String) {
    val dark = theme == "dark"
    window.setBackgroundDrawable(ColorDrawable(if (dark) 0xFF0C0E10.toInt() else 0xFFECEEF0.toInt()))
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !dark
      isAppearanceLightNavigationBars = !dark
    }
  }

  override fun onResume() {
    super.onResume()
    tellPage("foreground")
    NotifyService.start(this)
    askToKeepRunning()
  }

  // Asleep, Android cuts the network of apps it optimizes for battery, and notifications then stop
  // until the phone wakes. Asked once, after sign-in and after notifications are allowed.
  private fun askToKeepRunning() {
    val prefs = getSharedPreferences("app", Context.MODE_PRIVATE)
    if (prefs.getBoolean("asked_battery", false)) return
    if (NotifyService.signedIn(this).isEmpty()) return
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    val power = getSystemService(PowerManager::class.java)
    if (power.isIgnoringBatteryOptimizations(packageName)) return
    prefs.edit().putBoolean("asked_battery", true).apply()
    try {
      startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    } catch (_: Exception) {
      // Some phones have no such screen; the app still works, only later while asleep.
    }
  }

  // Signing in happens inside the app, so the watch also starts when the user leaves it.
  override fun onPause() {
    tellPage("background")
    NotifyService.start(this)
    super.onPause()
  }
}
