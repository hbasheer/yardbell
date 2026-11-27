import { StyleSheet, View } from 'react-native'
import { colors, radii, useColorScheme } from './theme'

export type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'unreachable' | 'warning'

export function statusDotColor(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return colors.statusGreen
    case 'connecting':
    case 'reconnecting':
    case 'warning':
      return colors.statusAmber
    case 'unreachable':
      return colors.statusRed
    case 'disconnected':
      return colors.textMuted
  }
}

export function StatusDot({ state }: { state: ConnectionState }) {
  useColorScheme()
  return <View style={[styles.dot, { backgroundColor: statusDotColor(state) }]} />
}

const styles = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: radii.pill }
})
