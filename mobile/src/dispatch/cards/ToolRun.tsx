import { useState, type ComponentType } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight, Eye, Folder, Server, SquareTerminal, Wrench } from 'lucide-react-native'
import { chipState, runState, runTitle, toolLabel, type Chip } from '../blocks'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { toolTarget } from './model'
import { MonoBox } from './parts'

type IconProps = { size?: number; color?: string; strokeWidth?: number }

const ICONS: Record<string, ComponentType<IconProps>> = {
  list_machines: Server,
  list_sessions: SquareTerminal,
  list_folders: Folder,
  read_session: Eye
}

export type ToolRunProps = { chips: Chip[]; running?: boolean }

export function ToolRun({ chips, running = false }: ToolRunProps) {
  useColorScheme()
  const [open, setOpen] = useState(false)
  const state = runState(chips, running)
  return (
    <View style={styles.run}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={runTitle(chips)}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} style={open ? styles.turned : undefined} />
        <Text style={[styles.headerText, state === 'error' && styles.errorText]} numberOfLines={1}>
          {runTitle(chips)}
        </Text>
        <Mark state={state} />
      </Pressable>
      {open ? (
        <View style={styles.members}>
          {chips.map((chip, at) => (
            <Line key={at} chip={chip} running={running} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

function Mark({ state }: { state: 'running' | 'error' | 'ok' | 'idle' }) {
  useColorScheme()
  if (state === 'running') return <ActivityIndicator size="small" color={colors.textMuted} style={styles.spinner} />
  if (state === 'error') return <View style={[styles.dot, { backgroundColor: colors.statusRed }]} />
  return null
}

function Line({ chip, running }: { chip: Chip; running: boolean }) {
  const [open, setOpen] = useState(false)
  const state = chipState(chip, running)
  const Icon = ICONS[chip.name] ?? Wrench
  const target = toolTarget(chip.input)
  const detail = chip.result?.text ?? ''
  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        disabled={!detail}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      >
        <Icon size={14} color={state === 'error' ? colors.statusRed : colors.textMuted} strokeWidth={2} />
        <Text style={styles.verb} numberOfLines={1}>
          {toolLabel(chip.name)}
        </Text>
        {target ? (
          <Text style={styles.target} numberOfLines={1}>
            {target}
          </Text>
        ) : null}
        <Mark state={state} />
        {detail ? <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} style={open ? styles.turned : undefined} /> : null}
      </Pressable>
      {open && detail ? (
        <View style={styles.detail}>
          <MonoBox text={detail} />
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  run: { minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28, paddingVertical: 3 },
  headerText: { flexShrink: 1, fontSize: 14, color: colors.textMuted },
  errorText: { color: colors.statusRed },
  members: {
    marginLeft: 7,
    paddingLeft: 13,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle,
    gap: 2
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  verb: { flexShrink: 0, maxWidth: '60%', fontSize: 13, color: colors.textMuted },
  target: { flex: 1, minWidth: 0, fontSize: 13, color: colors.textPrimary },
  detail: { marginLeft: 22, paddingBottom: spacing.xs },
  turned: { transform: [{ rotate: '90deg' }] },
  spinner: { transform: [{ scale: 0.7 }] },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pressed: { opacity: 0.7 }
}))
