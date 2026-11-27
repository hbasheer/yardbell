import { Text, View } from 'react-native'

export function WebView() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1b26' }}>
      <Text style={{ color: '#8b949e', fontFamily: 'monospace' }}>Terminal (preview placeholder)</Text>
    </View>
  )
}

export type WebViewMessageEvent = { nativeEvent: { data: string } }
