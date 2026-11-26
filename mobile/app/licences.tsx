import { Stack } from 'expo-router'
import { ScrollView, Text } from 'react-native'
import { notices } from '@/about/notices'
import { useTheme } from '@/theme/useTheme'

export default function Licences() {
  const theme = useTheme()
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 16 }}>
      <Stack.Screen
        options={{ headerShown: true, title: 'Licences', headerStyle: { backgroundColor: theme.background }, headerTintColor: theme.foreground }}
      />
      <Text selectable style={{ color: theme.foreground, fontSize: 13, fontFamily: 'monospace' }}>
        {notices}
      </Text>
    </ScrollView>
  )
}
