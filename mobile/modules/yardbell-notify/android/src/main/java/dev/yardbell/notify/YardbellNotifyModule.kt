package dev.yardbell.notify

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class PairedServer : Record {
  @Field val address: String = ""
  @Field val token: String = ""
}

class YardbellNotifyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("YardbellNotify")

    Events("open")

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
