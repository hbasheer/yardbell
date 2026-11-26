import { Image, Text, useColorScheme, View } from 'react-native'
import { colors } from '@/theme/colors'

export default function Index() {
  const theme = colors[useColorScheme() === 'light' ? 'light' : 'dark']
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.background
      }}
    >
      <Image source={require('../assets/icon.png')} style={{ width: 96, height: 96, borderRadius: 22 }} />
      <Text style={{ marginTop: 16, fontSize: 24, fontWeight: '600', color: theme.foreground }}>
        Yardbell
      </Text>
    </View>
  )
}
