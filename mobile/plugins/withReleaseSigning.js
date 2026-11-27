const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { withAppBuildGradle } = require('expo/config-plugins')

const defaultProperties = path.join(os.homedir(), '.local', 'android', 'release', 'keystore.properties')

function releaseProperties() {
  const file = process.env.YARDBELL_KEYSTORE_PROPERTIES || defaultProperties
  if (!fs.existsSync(file)) {
    throw new Error(
      `Release signing needs ${file}. Set YARDBELL_KEYSTORE_PROPERTIES to a keystore.properties file.`
    )
  }
  return file
}

module.exports = (config) =>
  withAppBuildGradle(config, (mod) => {
    const file = releaseProperties()
    let gradle = mod.modResults.contents
    if (gradle.includes('yardbellRelease')) return mod

    const loader = `
def yardbellKeystore = new Properties()
file(${JSON.stringify(file)}).withInputStream { yardbellKeystore.load(it) }
`
    gradle = gradle.replace(/^android \{/m, `${loader}\nandroid {`)
    gradle = gradle.replace(
      /signingConfigs \{/,
      `signingConfigs {
        yardbellRelease {
            storeFile file(yardbellKeystore['storeFile'])
            storePassword yardbellKeystore['password']
            keyAlias yardbellKeystore['keyAlias']
            keyPassword yardbellKeystore['password']
        }`
    )
    gradle = gradle.replace(
      /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig signingConfigs.yardbellRelease'
    )
    if (!gradle.includes('signingConfigs.yardbellRelease')) {
      throw new Error('withReleaseSigning could not find the release signing config to replace')
    }
    mod.modResults.contents = gradle
    return mod
  })
