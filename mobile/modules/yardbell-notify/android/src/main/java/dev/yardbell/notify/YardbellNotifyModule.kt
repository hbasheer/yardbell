package dev.yardbell.notify

import com.facebook.react.modules.websocket.WebSocketModule
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.TimeUnit

class PairedServer : Record {
  @Field val address: String = ""
  @Field val token: String = ""
}

class YardbellNotifyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("YardbellNotify")

    Events("open")

    OnCreate {
      // The server never pings, so without this a silent Meshnet drop leaves the socket open forever.
      WebSocketModule.setCustomClientBuilder { it.pingInterval(15, TimeUnit.SECONDS) }
    }

    Function("setServers") { list: List<PairedServer> ->
      val context = appContext.reactContext ?: return@Function
      NotifyService.setServers(context, list.filter { it.address.isNotEmpty() && it.token.isNotEmpty() }.associate { it.address to it.token })
    }

    Function("start") {
      appContext.reactContext?.let { NotifyService.start(it) }
    }

    Function("getInitialLink") {
      appContext.currentActivity?.intent?.let { NotifyService.takeClick(it) }
    }

    OnNewIntent { intent ->
      NotifyService.takeClick(intent)?.let { sendEvent("open", mapOf("link" to it)) }
    }
  }
}
