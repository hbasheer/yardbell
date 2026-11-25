/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react'
import { Check, Download, Mic, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'
import { api } from '@/pipelines/model'
import type { SettingsData } from './Integrations'
import { saved } from './saved'
import { areaClass, Group, inputClass, Row, Section, Segmented } from './ui'

const QUALITY = ['Poor', 'Fair', 'Good', 'Very good', 'Excellent']
const MIC_KEY = 'yardbell.voice.mic'
const LANGUAGES: [string, string][] = [
  ['', 'English'],
  ['auto', 'Auto-detect'],
  ['ar', 'Arabic'],
  ['zh', 'Chinese'],
  ['nl', 'Dutch'],
  ['fi', 'Finnish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['hi', 'Hindi'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['pl', 'Polish'],
  ['pt', 'Portuguese'],
  ['ru', 'Russian'],
  ['es', 'Spanish'],
  ['sv', 'Swedish'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian']
]
const MODE_HELP: Record<string, (keys: string) => string> = {
  auto: (k) => `Tap ${k} or the microphone to start and stop, or hold it while you talk. It stops by itself after a few seconds of quiet.`,
  hold: (k) => `Talk while you hold ${k} or the microphone.`,
  toggle: (k) => `Press ${k} or the microphone to start, and again to stop.`
}
// Choices that apply the moment they are picked; the engine, paths and API fields wait for Save.
const AT_ONCE: Record<string, string> = {
  mode: 'Dictation mode saved. Dispatch uses it within a few seconds.',
  language: 'Dictation language saved.',
  vocabulary: 'Vocabulary saved.',
  remove_fillers: 'Remove filler words saved.'
}

type VoiceValues = {
  input: string
  whisper_command: string
  whisper_model: string
  api_url: string
  api_model: string
  api_key: string
  language: string
  vocabulary: string
  remove_fillers: boolean
  mode: string
}
type Model = {
  name: string
  label: string
  note: string
  bytes: number
  quality: number
  downloaded: boolean
  partial?: number
  download?: { running?: boolean; done: number; total?: number; error?: string }
}
type Models = { dir: string; models: Model[]; active: string; recommended: string; whisper: boolean; input: string; custom?: { found: boolean; path: string } }

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)
function downloading(m: Model) {
  const d = m.download!
  const total = d.total || m.bytes
  return `Downloading, ${Math.round(d.done / 1e6)} of ${Math.round(total / 1e6)} MB (${total ? Math.floor((d.done * 100) / total) : 0}%)`
}
function Quality({ q }: { q: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="flex gap-0.5" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} className={cn('size-1.5 rounded-full', n <= q ? 'bg-foreground/80' : 'bg-muted-foreground/25')} />
        ))}
      </span>
      {QUALITY[q - 1] || ''}
    </span>
  )
}

function useVoiceKeys() {
  const [keys, setKeys] = useState<any>((window as any).YardbellVoiceKeys || null)
  useEffect(() => {
    if (keys) return
    const s = document.querySelector('script[src="/voice-keys.js"]') || Object.assign(document.createElement('script'), { src: '/voice-keys.js' })
    if (!s.isConnected) document.head.append(s)
    const ready = () => setKeys((window as any).YardbellVoiceKeys || null)
    s.addEventListener('load', ready)
    ready()
    return () => s.removeEventListener('load', ready)
  }, [])
  return keys
}

export function VoiceSection({ data, reload }: { data: SettingsData; reload: () => Promise<SettingsData | null> }) {
  const savedVoice = ((data as any).voice || {}) as Partial<VoiceValues>
  const fromData = (): VoiceValues => ({
    input: savedVoice.input || 'off',
    whisper_command: savedVoice.whisper_command || '',
    whisper_model: savedVoice.whisper_model || '',
    api_url: savedVoice.api_url || '',
    api_model: savedVoice.api_model || '',
    api_key: savedVoice.api_key || '',
    language: savedVoice.language || '',
    vocabulary: savedVoice.vocabulary || '',
    remove_fillers: Boolean(savedVoice.remove_fillers),
    mode: savedVoice.mode || 'auto'
  })
  const [v, setV] = useState<VoiceValues>(fromData)
  const [models, setModels] = useState<Models | null>(null)
  const [status, setStatus] = useState<{ text: string; ok?: boolean } | null>(null)
  const [busy, setBusy] = useState('')
  const [setupWanted, setSetupWanted] = useState<string | null>(null)
  const [setupNote, setSetupNote] = useState('')
  const waits = useRef(0)
  const poll = useRef(0)
  const keys = useVoiceKeys()
  const [, repaint] = useState(0)
  const [listening, setListening] = useState<string | null>(null)
  const [mics, setMics] = useState<{ list: { id: string; label: string }[]; names: boolean; unsupported: boolean }>({
    list: [],
    names: false,
    unsupported: false
  })
  const [mic, setMic] = useState(() => localStorage.getItem(MIC_KEY) || '')
  const keyLabel = keys?.label() || 'the shortcut'

  useEffect(() => setV(fromData()), [JSON.stringify(savedVoice)])

  const loadModels = async () => {
    clearTimeout(poll.current)
    let out: Models
    try {
      out = await api<Models>('GET', '/api/settings/voice/models')
    } catch (e) {
      toast.error((e as Error).message)
      return
    }
    setModels(out)
    const running = out.models.some((m) => m.download?.running)
    if (setupWanted && !running) {
      const done = out.input === 'local' && out.active === setupWanted
      const failed = out.models.find((m) => m.name === setupWanted)?.download?.error
      if (done) {
        const label = out.models.find((m) => m.name === setupWanted)?.label || setupWanted
        setSetupWanted(null)
        saved(`Dictation is set up with ${label}. The microphone button in Dispatch's message box is ready.`)
        reload()
        return
      }
      if (failed || ++waits.current > 10) setSetupWanted(null)
    }
    if (running || setupWanted) poll.current = window.setTimeout(loadModels, 600)
  }
  useEffect(() => {
    loadModels()
    return () => clearTimeout(poll.current)
  }, [setupWanted])

  const fillMics = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return setMics({ list: [], names: false, unsupported: true })
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
    const inputs = all.filter((d) => d.kind === 'audioinput')
    const listed = inputs.filter((d) => d.deviceId && !['default', 'communications'].includes(d.deviceId))
    setMics({
      list: listed.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
      names: inputs.some((d) => !d.label || !d.deviceId),
      unsupported: false
    })
  }
  useEffect(() => {
    fillMics()
    navigator.mediaDevices?.addEventListener?.('devicechange', fillMics)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', fillMics)
  }, [])

  const savedInput = savedVoice.input || 'off'
  const active = models?.models.find((m) => m.name === models.active) || null
  const ready = savedInput === 'api' || (savedInput === 'local' && !!models && (models.custom ? models.custom.found : Boolean(active?.downloaded)))
  const rec = models?.models.find((m) => m.name === models.recommended)

  const stateText = (() => {
    if (v.input !== savedInput) return 'Save to switch.'
    if (v.input === 'off') return "Off. Dispatch's microphone button offers to set it up."
    if (v.input === 'api') return `Recordings are sent to the cloud API below. Press ${keyLabel} in Dispatch's message box.`
    if (!models) return ''
    const missing = models.whisper ? '' : ' whisper.cpp was not found on this machine, so Set up says how to get it.'
    if (models.custom)
      return models.custom.found
        ? `Ready with your own model file. Press ${keyLabel} in Dispatch's message box.${missing}`
        : `There is no model file at ${models.custom.path}. Download a speech model below, or fix the path under Advanced.`
    if (active?.download?.running) return `Works once ${active.label} finishes downloading.`
    if (active?.downloaded) return `Ready with ${active.label}. Press ${keyLabel} in Dispatch's message box.${missing}`
    return `Download a speech model below to start. It runs on this machine, so your audio stays here.${missing}`
  })()

  const saveAtOnce = async (key: keyof VoiceValues, next: VoiceValues) => {
    try {
      await api('POST', '/api/settings/voice', next)
      saved(AT_ONCE[key])
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const change = <K extends keyof VoiceValues>(key: K, value: VoiceValues[K], now = false) => {
    const next = { ...v, [key]: value }
    setV(next)
    if (now && AT_ONCE[key]) saveAtOnce(key, next)
  }
  const modelAct = async (m: Model, act: string) => {
    setBusy(`${m.name}:${act}`)
    try {
      await api('POST', `/api/settings/voice/models/${encodeURIComponent(m.name)}/${act}`, {})
      if (act === 'use') {
        saved('Dictation uses the new model from the next recording.')
        reload()
      }
    } catch (e) {
      toast.error((e as Error).message)
    }
    setBusy('')
    loadModels()
  }
  const setUp = async () => {
    if (!models?.recommended) return
    setBusy('setup')
    try {
      const out = await api<{ ready?: boolean }>('POST', '/api/settings/voice/setup', { model: models.recommended })
      waits.current = out.ready ? 10 : 0
      setSetupWanted(models.recommended)
      setSetupNote('')
    } catch (e) {
      setSetupNote((e as Error).message)
    }
    setBusy('')
  }

  // Change listens for the next key combination; Esc gives up, and a key with no Control, Option or
  // Command is refused, since it would fire while typing.
  useEffect(() => {
    if (listening === null || !keys) return
    const listen = (e: KeyboardEvent) => {
      if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setListening(null)
      const picked = keys.fromEvent(e)
      if (!keys.valid(picked)) return setListening(`Hold ${keys.isMac ? '⌃, ⌥ or ⌘' : 'Ctrl, Alt or Super'} with a key`)
      keys.set(picked)
      setListening(null)
    }
    document.addEventListener('keydown', listen, true)
    return () => document.removeEventListener('keydown', listen, true)
  }, [listening === null, keys])

  const setupNoteText = (() => {
    if (!rec) return ''
    const d = rec.download
    if (d?.running) return downloading(rec)
    if (d?.error) return d.error
    if (setupWanted) return 'Switching dictation to the new model…'
    if (setupNote) return setupNote
    if (rec.downloaded) return 'Already downloaded. Set up switches dictation to it.'
    return `Downloads ${size(rec.bytes)} once. The browser asks for the microphone the first time you dictate.`
  })()

  return (
    <Section
      title="Voice"
      description="Talk instead of typing in Dispatch's message box. Speech is recognized on this machine with whisper.cpp unless you pick a cloud API."
    >
      {rec && !ready && (
        <div className="flex gap-4 rounded-xl border border-border bg-card p-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <Mic className="size-5" />
          </span>
          <div className="grid min-w-0 flex-1 gap-2">
            <h3 className="text-[15px] font-semibold">Set up dictation</h3>
            <p className="text-xs text-muted-foreground">Talk instead of typing. Speech is recognized on this machine, so your audio stays here.</p>
            <p className="flex flex-wrap items-center gap-3 text-[13px]">
              <span className="font-medium">{rec.label}</span>
              <span className="text-xs text-muted-foreground">{size(rec.bytes)}</span>
              <Quality q={rec.quality} />
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" disabled={busy === 'setup' || Boolean(rec.download?.running) || Boolean(setupWanted)} onClick={setUp}>
                <Download /> Set up
              </Button>
              <span role="status" className={cn('text-xs', rec.download?.error || setupNote ? 'text-destructive' : 'text-muted-foreground')}>
                {setupNoteText}
              </span>
            </div>
          </div>
        </div>
      )}

      <Group>
        <Row
          label="Dictation"
          description={stateText}
          control={
            <Switch
              checked={v.input !== 'off'}
              aria-label="Dictation"
              onCheckedChange={async (on) => {
                const next = { ...v, input: on ? (savedVoice.api_url && v.input === 'api' ? 'api' : 'local') : 'off' }
                setV(next)
                try {
                  await api('POST', '/api/settings/voice', next)
                  saved(on ? "Dictation is on. The microphone button shows in Dispatch's message box." : "Dictation is off, so Dispatch's microphone button offers to set it up.")
                  reload()
                } catch (e) {
                  toast.error((e as Error).message)
                }
              }}
            />
          }
        />
        <Row
          label="Shortcut"
          description="Starts dictation in Dispatch's message box. Kept on this device."
          control={
            <span className="flex items-center gap-2">
              {listening !== null ? (
                <span className="text-xs text-muted-foreground">{listening || 'Press the new shortcut…'}</span>
              ) : (
                <span className="flex gap-1" role="img" aria-label={keyLabel}>
                  {(keys?.parts() || []).map((p: string) => (
                    <kbd key={p} className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[11px]">
                      {p}
                    </kbd>
                  ))}
                </span>
              )}
              <Button size="xs" variant="ghost" disabled={!keys} onClick={() => setListening(listening === null ? '' : null)}>
                {listening !== null ? 'Cancel' : 'Change'}
              </Button>
              {keys && JSON.stringify(keys.get()) !== JSON.stringify(keys.defaults()) && listening === null && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    keys.reset()
                    repaint((n) => n + 1)
                  }}
                >
                  Reset
                </Button>
              )}
            </span>
          }
        />
        <Row
          label="Mode"
          description={(MODE_HELP[v.mode] || MODE_HELP.auto)(keyLabel)}
          control={
            <Segmented
              label="Dictation mode"
              value={v.mode}
              onChange={(mode) => change('mode', mode, true)}
              options={[
                ['auto', 'Auto'],
                ['hold', 'Hold'],
                ['toggle', 'Toggle']
              ]}
            />
          }
        />
      </Group>

      <Group
        title="Speech model"
        description={
          <>
            Quality is rated for English. Models download into <code className="font-mono">{models?.dir || 'the models folder'}</code>.
          </>
        }
      >
        {!models && <p className="py-4 text-xs text-muted-foreground">Reading the models…</p>}
        {models?.models.map((m) => {
          const inUse = savedInput === 'local' && models.active === m.name
          const d = m.download
          const running = Boolean(d?.running)
          const recommended = m.name === models.recommended && !ready
          const sub = running
            ? downloading(m)
            : d?.error
              ? d.error
              : !m.downloaded && m.partial
                ? `Partly downloaded (${Math.round(m.partial / 1e6)} MB). Download carries on from there.`
                : m.note
          return (
            <div key={m.name} className="flex flex-wrap items-center gap-3 py-3" data-current={inUse || undefined}>
              <div className="grid min-w-0 flex-1 basis-56 gap-0.5">
                <p className="flex items-center gap-2 text-[13px] font-medium">
                  {m.label}
                  {recommended && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">Recommended</span>}
                </p>
                <p className={cn('text-xs', d?.error && !running ? 'text-destructive' : 'text-muted-foreground')}>{sub}</p>
              </div>
              <Quality q={m.quality} />
              <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">{size(m.bytes)}</span>
              <span className="w-8">
                {m.downloaded && !running && !inUse && (
                  <button
                    type="button"
                    aria-label={`Delete ${m.label}`}
                    title={`Delete ${m.label} (${size(m.bytes)})`}
                    disabled={busy !== ''}
                    onClick={() => modelAct(m, 'delete')}
                    className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </span>
              <span className="w-28 text-right">
                {running ? (
                  <Button size="xs" variant="outline" onClick={() => modelAct(m, 'cancel')}>
                    Cancel
                  </Button>
                ) : inUse && m.downloaded ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-status-success-text">
                    <Check className="size-3.5" /> In use
                  </span>
                ) : m.downloaded ? (
                  <Button size="xs" variant="outline" disabled={busy !== ''} onClick={() => modelAct(m, 'use')}>
                    Use
                  </Button>
                ) : (
                  <Button size="xs" variant={recommended ? 'default' : 'outline'} disabled={busy !== ''} onClick={() => modelAct(m, 'download')}>
                    <Download /> Download
                  </Button>
                )}
              </span>
            </div>
          )
        })}
        {v.input !== 'api' && (
          <Row
            label="Use a cloud API instead"
            description="Send recordings to OpenAI or another OpenAI-compatible speech-to-text service instead of running a model here."
            control={
              <Button size="sm" variant="outline" onClick={() => change('input', 'api')}>
                Use a cloud API
              </Button>
            }
          />
        )}
        {v.input === 'api' && (
          <>
            <Row
              label="API address"
              control={
                <input
                  value={v.api_url}
                  onChange={(e) => change('api_url', e.target.value)}
                  placeholder="https://api.openai.com/v1/audio/transcriptions"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={cn(inputClass, 'w-80')}
                />
              }
            />
            <Row
              label="Model"
              control={
                <input
                  value={v.api_model}
                  onChange={(e) => change('api_model', e.target.value)}
                  placeholder="whisper-1"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={cn(inputClass, 'w-80')}
                />
              }
            />
            <Row
              label="API key"
              description={
                <>
                  Save the key once under Integrations, Secrets, and name it here as <code className="font-mono">{'${secret:name}'}</code>. The key itself never
                  goes into <code className="font-mono">yardbell.yml</code>.
                </>
              }
              control={
                <input
                  value={v.api_key}
                  onChange={(e) => change('api_key', e.target.value)}
                  placeholder="${secret:openai}"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className={cn(inputClass, 'w-80')}
                />
              }
            />
          </>
        )}
      </Group>

      <Group title="Words">
        <Row
          label="Dictation language"
          description="The language you speak. Auto-detect lets the model work it out each time. Models marked English only always hear English."
          control={
            <select value={v.language} onChange={(e) => change('language', e.target.value, true)} className={cn(inputClass, 'w-48')}>
              {!LANGUAGES.some(([c]) => c === v.language) && <option value={v.language}>{v.language}</option>}
              {LANGUAGES.map(([c, l]) => (
                <option key={c} value={c}>
                  {l}
                </option>
              ))}
            </select>
          }
        />
        <div className="grid gap-2 py-4">
          <p className="text-[13px] font-medium">Words to spell your way</p>
          <p className="text-xs text-muted-foreground">
            Names and code terms the model keeps getting wrong, separated by commas. The model reads them before each recording.
          </p>
          <textarea
            rows={2}
            maxLength={800}
            value={v.vocabulary}
            onChange={(e) => change('vocabulary', e.target.value)}
            onBlur={() => v.vocabulary !== (savedVoice.vocabulary || '') && saveAtOnce('vocabulary', v)}
            placeholder="Yardbell, Dispatch, whisper.cpp"
            autoCapitalize="off"
            spellCheck={false}
            className={areaClass}
          />
        </div>
      </Group>

      <Group title="Cleanup">
        <Row
          label="Remove filler words"
          description={'Drops sounds like "um" and "uh" from dictated text, and "like" where it only fills a pause.'}
          control={<Switch checked={v.remove_fillers} onCheckedChange={(on) => change('remove_fillers', on, true)} aria-label="Remove filler words" />}
        />
      </Group>

      <Group title="Input">
        <Row
          label="Microphone"
          description={
            mics.unsupported
              ? 'This browser only lists microphones on a secure page, so dictation uses the system default here.'
              : "The input device for dictation, kept on this device. System default follows the system's own setting."
          }
          control={
            <span className="flex items-center gap-2">
              {mics.names && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
                      for (const t of stream.getTracks()) t.stop()
                    } catch (err: any) {
                      toast.error(
                        err?.name === 'NotAllowedError'
                          ? 'The microphone is blocked. Allow it for this site in the browser to see its name.'
                          : `The microphone did not start: ${err?.message || err}`
                      )
                      return
                    }
                    fillMics()
                  }}
                >
                  Show names
                </Button>
              )}
              <select
                value={mic}
                disabled={mics.unsupported}
                onChange={(e) => {
                  setMic(e.target.value)
                  if (e.target.value) localStorage.setItem(MIC_KEY, e.target.value)
                  else localStorage.removeItem(MIC_KEY)
                }}
                className={cn(inputClass, 'w-56')}
              >
                <option value="">System default</option>
                {mics.list.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                {mic && !mics.list.some((m) => m.id === mic) && <option value={mic}>The chosen microphone (not connected)</option>}
              </select>
            </span>
          }
        />
        <MicTest device={mic} />
      </Group>

      {v.input === 'local' && (
        <Group title="Advanced">
          <Row
            label="Whisper command"
            description="The whisper.cpp program. Set up fills this in when it finds whisper.cpp."
            control={
              <input
                value={v.whisper_command}
                onChange={(e) => change('whisper_command', e.target.value)}
                placeholder="whisper-cli"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={cn(inputClass, 'w-64')}
              />
            }
          />
          <Row
            label="Model"
            description={
              <>
                A model name from the list above, or the path to a ggml file of your own. Needs <code className="font-mono">ffmpeg</code> on this machine.
              </>
            }
            control={
              <input
                value={v.whisper_model}
                onChange={(e) => change('whisper_model', e.target.value)}
                placeholder="small"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={cn(inputClass, 'w-64')}
              />
            }
          />
        </Group>
      )}

      <div className="flex items-center justify-end gap-3 px-1">
        <p role="status" className={cn('mr-auto text-xs', status?.ok ? 'text-status-success-text' : 'text-muted-foreground')}>
          {status?.text}
        </p>
        {v.input !== 'off' && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy === 'check'}
            onClick={async () => {
              setBusy('check')
              setStatus({ text: 'Checking…' })
              try {
                const out = await api<{ ok: boolean; message: string }>('POST', '/api/settings/voice/check', v)
                setStatus({ text: out.message, ok: out.ok })
              } catch (e) {
                setStatus({ text: (e as Error).message })
              }
              setBusy('')
            }}
          >
            Test
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy === 'save'}
          onClick={async () => {
            setBusy('save')
            try {
              await api('POST', '/api/settings/voice', v)
              saved(
                v.input === 'off'
                  ? "Voice input is off, so Dispatch's microphone button offers to set it up."
                  : "Voice settings saved. The microphone button shows in Dispatch's message box."
              )
              reload()
            } catch (e) {
              toast.error((e as Error).message)
            }
            setBusy('')
          }}
        >
          Save
        </Button>
      </div>

    </Section>
  )
}

// A short check that the chosen microphone hears you: it listens for a few seconds and draws the level.
function MicTest({ device }: { device: string }) {
  const [state, setState] = useState<'idle' | 'listening' | 'heard' | 'silent' | 'error'>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const stop = useRef<() => void>(() => {})
  useEffect(() => () => stop.current(), [])
  const start = async () => {
    stop.current()
    setError('')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: device ? { deviceId: { exact: device } } : true })
    } catch (err: any) {
      setState('error')
      setError(err?.name === 'NotAllowedError' ? 'The microphone is blocked. Allow it for this site in the browser.' : `The microphone did not start: ${err?.message || err}`)
      return
    }
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    let peak = 0
    let frame = 0
    const tick = () => {
      analyser.getFloatTimeDomainData(buf)
      const rms = Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length)
      const l = Math.min(1, rms * 8)
      peak = Math.max(peak, l)
      setLevel(l)
      frame = requestAnimationFrame(tick)
    }
    const done = (final: boolean) => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      stream.getTracks().forEach((t) => t.stop())
      ctx.close()
      setLevel(0)
      if (final) setState(peak > 0.08 ? 'heard' : 'silent')
    }
    const timer = window.setTimeout(() => done(true), 6000)
    stop.current = () => done(false)
    setState('listening')
    tick()
  }
  const text = {
    idle: 'Listens for a few seconds so you can see the microphone hears you.',
    listening: 'Listening… say something.',
    heard: 'Ready. The microphone hears you.',
    silent: 'Nothing was heard. Check the microphone above, or that it is not muted.',
    error
  }[state]
  return (
    <Row
      label="Test microphone"
      description={<span className={cn(state === 'heard' && 'text-status-success-text', (state === 'error' || state === 'silent') && 'text-destructive')}>{text}</span>}
      control={
        <span className="flex items-center gap-3">
          {state === 'listening' && (
            <span className="flex h-4 items-end gap-0.5" aria-hidden>
              {[0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((t) => (
                <span key={t} className={cn('w-1 rounded-sm transition-colors', level >= t ? 'bg-status-success' : 'bg-muted-foreground/25')} style={{ height: `${30 + t * 70}%` }} />
              ))}
            </span>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              if (state === 'listening') {
                stop.current()
                setState('idle')
              } else start()
            }}
          >
            {state === 'listening' ? 'Stop' : 'Test'}
          </Button>
        </span>
      }
    />
  )
}
