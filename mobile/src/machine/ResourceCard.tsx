import { Text, View } from 'react-native'
import { gb, resourcesOf, type Level, type MemoryPart } from '@/state/resources'
import type { HealthView } from '@/state/types'
import { levelColor } from '@/ui/resourceColors'
import { colors, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

const PART_COLOR: Record<MemoryPart['key'], () => string> = {
  agents: () => colors.accentBlue,
  mine: () => colors.statusPurple,
  other: () => colors.textMuted,
  free: () => colors.borderSubtle
}

function Bar({ parts, label }: { parts: { color: string; share: number }[]; label: string }) {
  return (
    <View style={styles.bar} accessibilityRole="progressbar" accessibilityLabel={label}>
      {parts.map((part, index) => (
        <View key={index} style={{ width: `${Math.max(0, Math.min(100, part.share))}%`, backgroundColor: part.color }} />
      ))}
    </View>
  )
}

function Headline({ name, pct, level, rest, aside }: { name: string; pct: number; level: Level; rest: string; aside?: string }) {
  return (
    <View style={styles.headline}>
      <Text style={styles.headlineText} numberOfLines={1}>
        {name} <Text style={[styles.strong, { color: levelColor(level) }]}>{pct}% used</Text> {rest}
      </Text>
      {aside ? (
        <Text style={styles.aside} numberOfLines={1}>
          {aside}
        </Text>
      ) : null}
    </View>
  )
}

export function ResourceCard({ up, health }: { up: boolean; health: HealthView | null | undefined }) {
  useColorScheme()
  const resources = resourcesOf(up, health)
  if (!resources) return null
  const { memory, cpu, disk, limit } = resources
  return (
    <View style={styles.card} accessibilityLabel="Machine resources">
      {memory ? (
        <View style={styles.block}>
          <Headline name="Memory" pct={memory.pct} level={memory.level} rest={`of ${memory.totalGb} GB`} />
          <Bar
            label={`Memory ${memory.pct}% used of ${memory.totalGb} GB: ${memory.parts.map((p) => `${p.label.toLowerCase()} ${gb(p.kb)} GB`).join(', ')}`}
            parts={memory.parts.slice(0, -1).map((p) => ({ color: PART_COLOR[p.key](), share: p.share }))}
          />
          <View style={styles.legend}>
            {memory.parts.map((p) => (
              <View key={p.key} style={styles.legendItem}>
                <View style={[styles.swatch, p.key === 'free' ? styles.swatchFree : { backgroundColor: PART_COLOR[p.key]() }]} />
                <Text style={styles.legendText} numberOfLines={1}>
                  {p.label} {gb(p.kb)} GB
                </Text>
              </View>
            ))}
          </View>
          {limit ? (
            <Text style={styles.legendText} numberOfLines={1}>
              Your account's limit:{' '}
              <Text style={[styles.strong, { color: levelColor(limit.level, colors.textSecondary) }]}>
                {limit.usedGb} of {limit.limitGb} GB
              </Text>
              , {limit.pct}%
            </Text>
          ) : null}
        </View>
      ) : null}
      {cpu ? (
        <View style={styles.headline}>
          <Text style={styles.headlineText} numberOfLines={1}>
            CPU load <Text style={styles.strong}>{cpu.load}</Text>
            {cpu.cpus ? ` / ${cpu.cpus} CPUs` : ''}
          </Text>
        </View>
      ) : null}
      {disk ? (
        <View style={styles.block}>
          <Headline name="Disk" pct={disk.pct} level={disk.level} rest={`of ${disk.totalGb} GB`} aside={`${disk.freeGb} GB free`} />
          <Bar
            label={`Disk ${disk.pct}% used of ${disk.totalGb} GB, ${disk.freeGb} GB free`}
            parts={[{ color: levelColor(disk.level, colors.textMuted), share: disk.pct }]}
          />
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    gap: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.bgRaised
  },
  block: { gap: 6 },
  headline: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  headlineText: { flexShrink: 1, fontSize: 13, color: colors.textSecondary },
  strong: { fontWeight: '600', color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  aside: { fontSize: 12, color: colors.textMuted },
  bar: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.borderSubtle },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md, rowGap: 2 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
  swatch: { width: 6, height: 6, borderRadius: 3 },
  swatchFree: { borderWidth: 1, borderColor: colors.textMuted },
  legendText: { fontSize: 11, color: colors.textMuted }
}))
