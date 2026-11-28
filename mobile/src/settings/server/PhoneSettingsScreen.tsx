import { useState } from 'react'
import { Switch, Text } from 'react-native'
import { NoticeBanner } from '../../changes/NoticeBanner'
import type { PairedServer } from '../../servers/store'
import { BottomDrawer } from '../../ui/BottomDrawer'
import { ListGroup } from '../../ui/ListGroup'
import { ListRow } from '../../ui/ListRow'
import { PageField } from '../../ui/PageField'
import { SectionHeader } from '../../ui/SectionHeader'
import { SheetHeader } from '../../ui/SheetHeader'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { SettingsScreen } from '../SettingsScreen'
import { setPhoneSettings, type PhoneSettingsChange } from '../serverApi'
import { connectedNote, MAX_WAIT_MINUTES, parseMinutes, PHONE_HELP, PHONE_MAIN, PHONE_PULLS, shown, waitWord, type PhoneKey } from './phoneModel'
import { Failed, Help, Loading, messageOf } from './parts'
import { useServerSettings, useSettingsTask } from './queries'

export function PhoneSettingsScreen({ server, serverCount }: { server: PairedServer; serverCount: number }) {
  useColorScheme()
  const query = useServerSettings(server)
  const { busy: running, notice, setNotice, run, adopt } = useSettingsTask(server)
  const busy = running !== null
  const [pending, setPending] = useState<PhoneSettingsChange>({})
  const [minutes, setMinutes] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const saved = query.data?.phone

  const save = (name: string, change: PhoneSettingsChange, done: string) =>
    run(name, async () => {
      setPending(change)
      try {
        const phone = await setPhoneSettings(server, change)
        adopt({ phone: { ...phone, app_connected: saved?.app_connected } })
        setNotice({ kind: 'info', text: done })
        return true
      } finally {
        setPending({})
      }
    })

  const saveMinutes = async () => {
    const parsed = parseMinutes(minutes ?? '')
    if ('error' in parsed) return setProblem(parsed.error)
    const ok = await save('wait', { wait_minutes: parsed.value }, 'Phone notifications updated.')
    if (ok) setMinutes(null)
  }

  const flip = (key: PhoneKey, on: boolean) => void save(key, { [key]: on }, 'Phone notifications updated.')

  const toggle = (key: PhoneKey, label: string, phone: ReturnType<typeof shown>) => (
    <ListRow
      key={key}
      title={label}
      accessibilityRole="switch"
      checked={Boolean(phone[key])}
      disabled={busy}
      accessory={
        <Switch value={Boolean(phone[key])} disabled={busy} onValueChange={(on) => flip(key, on)} trackColor={{ true: colors.accentBlue }} accessibilityLabel={label} />
      }
      onPress={() => flip(key, !phone[key])}
    />
  )

  let body
  if (query.isPending) body = <Loading title="Loading notification settings" />
  else if (!saved) body = <Failed message={messageOf(query.error, 'This server did not send its phone notification settings.')} onRetry={() => void query.refetch()} />
  else {
    const phone = shown(saved, pending)
    body = (
      <>
        {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}
        {serverCount > 1 ? <SectionHeader title={server.machine} first /> : null}
        <Help>{PHONE_HELP}</Help>
        <ListGroup style={styles.top}>
          {toggle('agent_waiting', 'Agent waiting', phone)}
          <ListRow
            key="wait"
            title="Tell me"
            value={waitWord(phone.wait_minutes)}
            navigates
            disabled={busy}
            onPress={() => {
              setProblem(null)
              setMinutes(String(phone.wait_minutes))
            }}
          />
          {PHONE_MAIN.map(([key, label]) => toggle(key, label, phone))}
        </ListGroup>
        <SectionHeader title="Pull and merge requests of your sessions" />
        <ListGroup>{PHONE_PULLS.map(([key, label]) => toggle(key, label, phone))}</ListGroup>
        <Help tone={saved.app_connected ? 'muted' : 'warn'}>{connectedNote(saved.app_connected)}</Help>

        <BottomDrawer visible={minutes !== null} onClose={() => setMinutes(null)}>
          <SheetHeader title="Agent waiting" subtitle="Minutes before it tells you" onClose={() => setMinutes(null)} trailing={{ label: 'Save', onPress: () => void saveMinutes(), disabled: busy, busy: running === 'wait' }} />
          <PageField
            value={minutes ?? ''}
            onChangeText={(text) => {
              setProblem(null)
              setMinutes(text)
            }}
            keyboardType="number-pad"
            maxLength={2}
            autoFocus
            selectTextOnFocus
            accessibilityLabel={`Minutes, 0 to ${MAX_WAIT_MINUTES}`}
          />
          <Text style={styles.note}>An agent that has asked for you tells your phone after this many minutes. 0 tells it at once.</Text>
          {problem ? (
            <Text style={styles.problem} accessibilityRole="alert">
              {problem}
            </Text>
          ) : null}
        </BottomDrawer>
      </>
    )
  }

  return <SettingsScreen title="Phone notifications">{body}</SettingsScreen>
}

const styles = themedStyleSheet(() => ({
  top: { marginTop: spacing.md },
  note: { fontSize: 13, lineHeight: 18, color: colors.textSecondary, paddingHorizontal: spacing.xs, paddingTop: spacing.md },
  problem: { fontSize: 13, color: colors.statusRed, paddingHorizontal: spacing.xs, paddingTop: spacing.sm }
}))
