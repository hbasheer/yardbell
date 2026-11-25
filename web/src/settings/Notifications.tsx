import { useState } from 'react'
import { BellRing, Bot, MessageCircleQuestion } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { canNotify, inApp, notifyPrefs, permissionNow, playSound, setNotifyPrefs, show, type NotifyPrefs } from '@/lib/notify'
import { Group, inputClass, Row, Section, Segmented } from './ui'

function Toggle({ icon, label, description, checked, disabled, onChange }: { icon?: React.ReactNode; label: string; description: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          {label}
        </span>
      }
      description={description}
      control={<Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />}
    />
  )
}

export function DesktopNotifications({ machines }: { machines: string[] }) {
  const [p, setP] = useState<NotifyPrefs>(notifyPrefs)
  const [permission, setPermission] = useState<string>(permissionNow)
  const set = (c: Partial<NotifyPrefs>) => {
    setNotifyPrefs(c)
    setP(notifyPrefs())
  }
  const enable = async (on: boolean) => {
    if (on && !inApp() && canNotify() && Notification.permission === 'default') setPermission(await Notification.requestPermission())
    set({ enabled: on })
  }
  const off = !p.enabled
  return (
    <Section title="Notifications" description="System notifications on this device when an agent needs you or finishes, kept in this browser. The phone app's notifications are below.">
      {inApp() && (
        <p role="note" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          The Yardbell app shows these as system notifications. Which session events notify is set in its menu bar panel; the test below goes through the app.
        </p>
      )}
      {permission === 'unsupported' && (
        <p role="note" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This browser only shows system notifications on a secure page, such as Yardbell on localhost or over https. Here only the sound plays.
        </p>
      )}
      {permission === 'denied' && (
        <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2 text-xs">
          Notifications are blocked for this site. Allow them in the browser's site settings, then come back.
        </p>
      )}
      <Group>
        <Toggle label="Enable notifications" description="System notifications for agent sessions on every machine, while Yardbell is open on this device." checked={p.enabled} onChange={enable} />
        <Toggle icon={<Bot className="size-4" />} label="Agent task complete" description="A coding agent finishes and becomes idle." checked={p.taskComplete} disabled={off} onChange={(taskComplete) => set({ taskComplete })} />
        <Toggle
          icon={<MessageCircleQuestion className="size-4" />}
          label="Agent needs input"
          description="A coding agent asks for permission or has a question."
          checked={p.needsInput}
          disabled={off}
          onChange={(needsInput) => set({ needsInput })}
        />
        {machines.map((m) => (
          <Toggle
            key={m}
            label={`Sessions on ${m}`}
            description="Turn off to stay quiet about this machine."
            checked={!p.muted.includes(m)}
            disabled={off}
            onChange={(on) => set({ muted: on ? p.muted.filter((x) => x !== m) : [...p.muted, m] })}
          />
        ))}
        <Row
          label="Sound"
          description="Plays with each notification."
          control={
            <span className="flex items-center gap-3">
              <Segmented
                label="Sound"
                value={p.sound}
                onChange={(sound) => {
                  set({ sound: sound as NotifyPrefs['sound'] })
                  playSound(sound, p.volume)
                }}
                options={[
                  ['chime', 'Chime'],
                  ['ping', 'Ping'],
                  ['none', 'None']
                ]}
              />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={p.volume}
                disabled={p.sound === 'none'}
                aria-label="Volume"
                onChange={(e) => setP({ ...p, volume: Number(e.target.value) })}
                onPointerUp={() => {
                  set({ volume: p.volume })
                  playSound(p.sound, p.volume)
                }}
                className={cn(inputClass, 'h-auto w-28 border-0 bg-transparent px-0')}
              />
            </span>
          }
        />
        <Toggle label="Suppress while focused" description="Skip notifications while Yardbell is the window you are looking at." checked={p.suppressWhenFocused} disabled={off} onChange={(suppressWhenFocused) => set({ suppressWhenFocused })} />
        <div className="flex flex-wrap items-center gap-2 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={off}
            onClick={() => {
              const shown = show('Yardbell', 'Notifications work on this device.')
              if (!shown) toast(permission === 'granted' ? 'Played the sound.' : 'Played the sound. System notifications are not allowed here.')
            }}
          >
            <BellRing /> Send test notification
          </Button>
        </div>
      </Group>
    </Section>
  )
}
