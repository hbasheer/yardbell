import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ExpoConfig } from 'expo/config'
import { versionCode } from './src/version.ts'

function cargoVersion(): string {
  const cargo = readFileSync(path.join(__dirname, '..', 'Cargo.toml'), 'utf8')
  const packageSection = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1]
  const version = packageSection && /^version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1]
  if (!version) throw new Error('No [package] version found in ../Cargo.toml')
  return version
}

const version = cargoVersion()

const config: ExpoConfig = {
  name: 'Yardbell',
  slug: 'yardbell',
  scheme: 'yardbell',
  version,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  android: {
    package: 'dev.yardbell.android',
    versionCode: versionCode(version),
    allowBackup: false,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#18181B'
    }
  },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { backgroundColor: '#0a0a0a', image: './assets/icon.png', imageWidth: 160 }],
    ['expo-camera', { cameraPermission: "Scan the pairing code shown in Yardbell's Settings", recordAudioAndroid: false }],
    'expo-secure-store',
    ['expo-build-properties', { android: { minSdkVersion: 26, targetSdkVersion: 35, usesCleartextTraffic: true } }],
    './plugins/withReleaseSigning',
    './modules/yardbell-notify/app.plugin.js'
  ]
}

export default config
