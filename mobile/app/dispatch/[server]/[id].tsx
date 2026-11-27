import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { NavBar } from '@/ui/NavBar'
import { NavBarButton } from '@/ui/NavBarButton'
import { StateView } from '@/ui/StateView'
import { colors } from '@/ui/theme'

export default function ChatRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: colors.bgBase, paddingTop: insets.top }}>
      <NavBar
        title={id === 'new' ? 'New chat' : 'Chat'}
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />}
      />
      <StateView title="Chat coming next" />
    </View>
  )
}
