import { X } from 'lucide-react-native'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '@/ui/theme'
import { dockStyles as styles } from './dockStyles'
import type { AttachState } from './useAttach'

export function AttachStatus({ state, onDismiss }: { state: AttachState; onDismiss: () => void }) {
  if (state.kind === 'idle') return null
  const failed = state.kind === 'failed'
  return (
    <View style={styles.status} accessibilityLiveRegion="polite">
      {failed ? null : <ActivityIndicator size="small" color={colors.textSecondary} />}
      <Text style={[styles.statusText, failed && styles.statusError]} numberOfLines={3}>
        {failed ? state.message : `Uploading ${state.file} ${Math.round(state.fraction * 100)}%`}
      </Text>
      {failed ? (
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
          <X size={16} color={colors.textSecondary} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  )
}
