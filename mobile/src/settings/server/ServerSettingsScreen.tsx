import { useRouter } from 'expo-router'
import { Bell, Bot, Zap } from 'lucide-react-native'
import type { PairedServer } from '../../servers/store'
import { ListGroup } from '../../ui/ListGroup'
import { ListRow } from '../../ui/ListRow'
import { SectionHeader } from '../../ui/SectionHeader'
import { colors, useColorScheme } from '../../ui/theme'
import { SettingsFooter, SettingsScreen } from '../SettingsScreen'
import { modelSummary, agentName } from './dispatchModel'
import { dispatchSettingsHref, phoneSettingsHref, triggersHref } from './hrefs'
import { useServerSettings, useTriggers } from './queries'

export const ON_THE_COMPUTER =
  'Machines, Mesh, Integrations, MCP, agent installs, Security, Power, voice and health checks stay on the computer.'

export function ServerSettingsScreen({ server, serverCount }: { server: PairedServer; serverCount: number }) {
  useColorScheme()
  const router = useRouter()
  const settings = useServerSettings(server)
  const triggers = useTriggers(server, false)
  const data = settings.data
  const icon = (Icon: typeof Bot) => <Icon size={18} color={colors.textSecondary} strokeWidth={2} />
  const dispatchValue = data?.dispatch ? `${agentName(data, data.dispatch.runs_on)}, ${modelSummary(data)}` : undefined
  const on = triggers.data?.triggers.filter((t) => t.trigger.enabled).length
  return (
    <SettingsScreen title="Server settings">
      {serverCount > 1 ? <SectionHeader title={server.machine} first /> : null}
      <ListGroup>
        <ListRow key="dispatch" title="Dispatch" subtitle={dispatchValue} subtitleLines={1} leading={icon(Bot)} navigates onPress={() => router.push(dispatchSettingsHref(server.id) as never)} />
        <ListRow key="phone" title="Phone notifications" leading={icon(Bell)} navigates onPress={() => router.push(phoneSettingsHref(server.id) as never)} />
        <ListRow
          key="triggers"
          title="Triggers"
          value={on === undefined ? undefined : `${on} on`}
          leading={icon(Zap)}
          navigates
          onPress={() => router.push(triggersHref(server.id) as never)}
        />
      </ListGroup>
      <SettingsFooter>{`These are settings of ${server.machine}, the same ones its web page uses. ${ON_THE_COMPUTER}`}</SettingsFooter>
    </SettingsScreen>
  )
}
