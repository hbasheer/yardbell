import { useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'
import { colors } from '@/ui/theme'

export default function MachineScreen() {
  const { machine } = useLocalSearchParams<{ machine: string }>()
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgBase }}>
      <Text style={{ color: colors.textPrimary, fontSize: 16 }}>{machine}</Text>
    </View>
  )
}
