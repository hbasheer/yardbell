const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'react-native-webview') {
    return { type: 'sourceFile', filePath: path.join(__dirname, 'src/preview/webview.web.tsx') }
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
