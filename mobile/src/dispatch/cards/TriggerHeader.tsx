import { useState } from 'react'
import { Linking } from 'react-native'
import { ExternalLink, Timer } from 'lucide-react-native'
import type { Trigger } from '../types'
import { triggerLine, triggerToast, type TriggerStanding } from './model'
import { Buttons, CardButton, CardFrame, CardHead, NoteLine } from './parts'

export type TriggerHeaderProps = {
  trigger: Trigger
  standing: TriggerStanding
  onToggle?: (enabled: boolean) => Promise<void>
}

export function TriggerHeader({ trigger, standing, onToggle }: TriggerHeaderProps) {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState('')
  const [error, setError] = useState<string | null>(null)
  const known = standing !== null && standing !== 'deleted' ? standing : null

  async function toggle(enabled: boolean) {
    if (!onToggle) return
    setBusy(true)
    setError(null)
    try {
      await onToggle(enabled)
      setSaid(triggerToast(trigger.name, enabled))
    } catch (caught) {
      setSaid('')
      setError(caught instanceof Error && caught.message ? caught.message : 'The trigger could not be changed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const url = trigger.url
  return (
    <CardFrame>
      <CardHead icon={Timer} title={`Started by the trigger ${trigger.name}`} where={triggerLine(trigger, standing)} tint={known && !known.enabled ? 'muted' : undefined} whereLines={4} />
      {said ? <NoteLine text={said} tone="ok" /> : null}
      {error ? <NoteLine text={error} tone="error" /> : null}
      {url || (known && onToggle) ? (
        <Buttons>
          {url ? <CardButton label="Open ticket" icon={ExternalLink} onPress={() => void Linking.openURL(url).catch(() => {})} /> : null}
          {known && onToggle ? <CardButton label={known.enabled ? 'Turn off' : 'Turn on'} busy={busy} disabled={busy} onPress={() => void toggle(!known.enabled)} /> : null}
        </Buttons>
      ) : null}
    </CardFrame>
  )
}
