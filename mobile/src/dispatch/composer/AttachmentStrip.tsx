import { Pressable, ScrollView, Text, View } from 'react-native'
import { FileText, Image as ImageIcon, X } from 'lucide-react-native'
import type { PickedFile } from '../attachments'
import { colors, feedback, radii, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'

export function sizeLabel(bytes: number | null | undefined): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic)$/i

type Props = { files: PickedFile[]; error: string | null; onRemove: (index: number) => void }

export function AttachmentStrip({ files, error, onRemove }: Props) {
  useColorScheme()
  if (!files.length && !error) return null
  return (
    <View style={styles.wrap}>
      {files.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} keyboardShouldPersistTaps="handled">
          {files.map((file, index) => {
            const Icon = IMAGE_NAME.test(file.name) ? ImageIcon : FileText
            return (
              <View key={`${file.uri}:${index}`} style={styles.chip}>
                <View style={styles.icon}>
                  <Icon size={15} color={colors.textSecondary} />
                </View>
                <View style={styles.text}>
                  <Text style={styles.name} numberOfLines={1}>
                    {file.name}
                  </Text>
                  {file.size != null ? <Text style={styles.size}>{sizeLabel(file.size)}</Text> : null}
                </View>
                <Pressable
                  onPress={() => onRemove(index)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${file.name}`}
                  style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
                >
                  <X size={14} color={colors.textSecondary} strokeWidth={2.4} />
                </Pressable>
              </View>
            )
          })}
        </ScrollView>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  wrap: { gap: spacing.xs, marginBottom: spacing.sm },
  row: { gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 220,
    paddingVertical: spacing.xs + 2,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.composerControl,
    borderWidth: 1,
    borderColor: colors.composerBorder
  },
  icon: { flexShrink: 0 },
  text: { flexShrink: 1 },
  name: { color: colors.textPrimary, fontSize: 13, fontWeight: '500' },
  size: { color: colors.textMuted, fontSize: 11 },
  remove: { width: 22, height: 22, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: feedback.pressedOpacity },
  error: { color: colors.statusRed, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.xs }
}))
