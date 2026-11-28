import { Check, Mic, Settings, Square } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Linking, Pressable } from 'react-native'
import type { PairedServer } from '../../servers/store'
import { ActionSheet } from '../../ui/ActionSheet'
import { colors, feedback, radii, themedStyleSheet, useColorScheme } from '../../ui/theme'
import type { RunsOn } from '../types'
import { COMPOSER_CONTROL_HIT_SLOP, COMPOSER_CONTROL_SIZE } from '../composer/sizes'
import { MIC_DENIED_TEXT, MIC_DENIED_TITLE, VOICE_OFF_TEXT, VOICE_OFF_TITLE, micHint, micMode } from './model'
import { useDictation, type DictationPhase } from './useDictation'

type Props = {
  server: PairedServer
  runsOn: RunsOn | undefined
  onText: (text: string) => void
  onProblem: (text: string) => void
  onPhase?: (phase: DictationPhase) => void
}

export function MicButton({ server, runsOn, onText, onProblem, onPhase }: Props) {
  useColorScheme()
  const [sheet, setSheet] = useState<'off' | 'denied' | null>(null)
  const mode = micMode(runsOn?.voice_mode)
  const on = runsOn?.voice_input === true
  const { phase, pressIn, pressOut } = useDictation(server, { mode, onText, onProblem, onDenied: () => setSheet('denied') })
  useEffect(() => onPhase?.(phase), [phase, onPhase])
  const recording = phase === 'recording'
  const working = phase === 'starting' || phase === 'transcribing'

  const label = recording ? 'Stop dictation' : phase === 'transcribing' ? 'Transcribing' : on ? micHint(mode) : VOICE_OFF_TITLE

  return (
    <>
      <Pressable
        onPress={on ? undefined : () => setSheet('off')}
        onPressIn={on ? pressIn : undefined}
        onPressOut={on ? pressOut : undefined}
        disabled={working && phase === 'transcribing'}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy: working, selected: recording }}
        style={({ pressed }) => [styles.round, recording && styles.recording, !on && styles.off, pressed && styles.pressed]}
      >
        {working ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : recording ? (
          <Square size={13} color={colors.bgBase} fill={colors.bgBase} />
        ) : (
          <Mic size={18} color={colors.textPrimary} strokeWidth={2.2} />
        )}
      </Pressable>
      <ActionSheet
        visible={sheet === 'off'}
        title={VOICE_OFF_TITLE}
        message={VOICE_OFF_TEXT}
        actions={[{ label: 'OK', icon: Check, onPress: () => {} }]}
        onClose={() => setSheet(null)}
      />
      <ActionSheet
        visible={sheet === 'denied'}
        title={MIC_DENIED_TITLE}
        message={MIC_DENIED_TEXT}
        actions={[{ label: 'Open settings', icon: Settings, onPress: () => void Linking.openSettings() }]}
        onClose={() => setSheet(null)}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  round: {
    width: COMPOSER_CONTROL_SIZE,
    height: COMPOSER_CONTROL_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.composerControl
  },
  recording: { backgroundColor: colors.statusRed },
  off: { opacity: 0.6 },
  pressed: { opacity: feedback.pressedOpacity }
}))
