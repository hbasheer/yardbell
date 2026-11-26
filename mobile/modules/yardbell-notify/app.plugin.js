const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins')

const SERVICE = 'dev.yardbell.notify.NotifyService'
const RECEIVER = 'dev.yardbell.notify.BootReceiver'

const permissions = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED'
]

const service = {
  $: {
    'android:name': SERVICE,
    'android:exported': 'false',
    'android:foregroundServiceType': 'specialUse'
  },
  property: [
    {
      $: {
        'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
        'android:value': "Keeps a connection to the user's own Yardbell server over their VPN to show agent alerts"
      }
    }
  ]
}

const receiver = {
  $: { 'android:name': RECEIVER, 'android:exported': 'false' },
  'intent-filter': [
    {
      action: [
        { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
        { $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } }
      ]
    }
  ]
}

function replaceByName(list, entry) {
  return [...(list ?? []).filter((item) => item.$['android:name'] !== entry.$['android:name']), entry]
}

module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults
    AndroidConfig.Permissions.ensurePermissions(manifest, permissions)
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest)
    application.service = replaceByName(application.service, service)
    application.receiver = replaceByName(application.receiver, receiver)
    return mod
  })
