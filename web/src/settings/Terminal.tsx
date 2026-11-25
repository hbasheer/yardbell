// Terminal and browser settings follow Orca's panes (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { browserPrefs, ENGINES, setBrowserPrefs } from '@/lib/browser-prefs'
import { Group, inputClass, Row, Section, Segmented, SwitchRow } from './ui'
import { setTerminalTheme, terminalTheme, type TermTheme } from '@/shell/theme'

export type TermPrefs = {
  fontFamily?: string
  fontWeight?: string
  lineHeight?: number
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorBlink?: boolean
  scrollback?: number
  padding?: number
  copyOnSelect?: boolean
  rightClickPaste?: boolean
  darkTheme?: string
  lightTheme?: string
}
const PREFS_KEY = 'yardbell.term.prefs'
const FONT_KEY = 'yardbell.term.fontSize'
export const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20]

export function termPrefs(): TermPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

// Open terminals sit in frames of this page, and a storage event only reaches other documents, so
// each frame is also told directly.
function tellFrames(key: string) {
  for (const f of document.querySelectorAll('iframe')) {
    try {
      f.contentWindow?.dispatchEvent(new StorageEvent('storage', { key }))
    } catch {}
  }
}

export function useTermPrefs(): [TermPrefs, (change: TermPrefs) => void] {
  const [p, setP] = useState<TermPrefs>(termPrefs)
  const set = (change: TermPrefs) => {
    const next = { ...termPrefs(), ...change }
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
    setP(next)
    tellFrames(PREFS_KEY)
  }
  return [p, set]
}

export function useTermFontSize(): [number, (n: number) => void] {
  const [n, setN] = useState(() => Number(localStorage.getItem(FONT_KEY)) || 14)
  return [
    n,
    (size) => {
      localStorage.setItem(FONT_KEY, String(size))
      setN(size)
      tellFrames(FONT_KEY)
    }
  ]
}

type Palette = Record<string, string>
type Themes = { dark: Record<string, Palette>; light: Record<string, Palette> }
const FALLBACK: Record<'dark' | 'light', Palette> = {
  dark: { background: '#0d1117', foreground: '#e6edf3', green: '#3fb950', magenta: '#a371f7', brightBlack: '#8b949e', cursor: '#e6edf3' },
  light: { background: '#ffffff', foreground: '#1f2328', green: '#1a7f37', magenta: '#8250df', brightBlack: '#6e7781', cursor: '#1f2328' }
}

export function useTermThemes(): Themes | null {
  const [t, setT] = useState<Themes | null>((window as any).YardbellTermThemes || null)
  useEffect(() => {
    if (t) return
    const s = document.querySelector('script[src="/term-themes.js"]') || Object.assign(document.createElement('script'), { src: '/term-themes.js' })
    if (!s.isConnected) document.head.append(s)
    const ready = () => setT((window as any).YardbellTermThemes || null)
    s.addEventListener('load', ready)
    return () => s.removeEventListener('load', ready)
  }, [])
  return t
}

const appDark = () => document.documentElement.classList.contains('dark')
export function shownMode(): 'dark' | 'light' {
  const t = terminalTheme()
  return t === 'app' ? (appDark() ? 'dark' : 'light') : t
}
export function paletteFor(themes: Themes | null, p: TermPrefs, mode: 'dark' | 'light'): Palette {
  const name = mode === 'dark' ? p.darkTheme : p.lightTheme
  return (name && themes?.[mode]?.[name]) || FALLBACK[mode]
}

export function TermPreview({ p, size, palette }: { p: TermPrefs; size: number; palette?: Palette }) {
  const cursor = p.cursorStyle || 'block'
  const c = palette || FALLBACK.dark
  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-lg border border-border"
      style={{
        background: c.background,
        color: c.foreground, fontFamily: `${p.fontFamily ? `${p.fontFamily}, ` : ''}"JetBrains Mono", ui-monospace, Menlo, monospace`, fontSize: size, fontWeight: p.fontWeight === 'bold' ? 600 : 400, lineHeight: p.lineHeight || 1.15, padding: p.padding ?? 8 }}
    >
      <div>
        <span style={{ color: c.green }}>~/Projects/webapp</span> <span style={{ color: c.magenta }}>main</span> $ npm test
      </div>
      <div style={{ color: c.brightBlack }}>PASS src/checkout.test.ts (12 tests)</div>
      <div>
        $ <span style={{ background: c.cursor || c.foreground }} className={cn('inline-block w-[0.6em] align-text-bottom', cursor === 'block' && 'h-[1.1em]', cursor === 'bar' && 'h-[1.1em] w-[2px]', cursor === 'underline' && 'h-[2px]', p.cursorBlink !== false && 'animate-pulse')} />
      </div>
    </div>
  )
}

const SWATCH = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']
function ThemePicker({ label, themes, value, onPick }: { label: string; themes: Record<string, Palette>; value?: string; onPick: (name: string) => void }) {
  return (
    <div className="grid gap-2 py-3">
      <p className="text-[13px] font-medium">{label}</p>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {[['', null] as [string, Palette | null], ...Object.entries(themes)].map(([name, t]) => {
          const on = (value || '') === name
          return (
            <button
              key={name || 'default'}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(name)}
              className={cn('grid gap-1.5 rounded-lg border p-1.5 text-left transition-colors', on ? 'border-foreground ring-2 ring-foreground/15' : 'border-border hover:border-foreground/30')}
            >
              <span className="flex h-9 items-end gap-0.5 rounded-md px-1.5 pb-1.5" style={{ background: t?.background || 'linear-gradient(135deg,#ffffff 50%,#0d1117 50%)' }}>
                {t && SWATCH.map((k) => <span key={k} className="h-2 flex-1 rounded-sm" style={{ background: t[k] }} />)}
              </span>
              <span className="truncate px-0.5 text-[11.5px]">{name || 'Yardbell default'}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function TerminalSection() {
  const [p, set] = useTermPrefs()
  const [size, setSize] = useTermFontSize()
  const [scroll, setScroll] = useState(String(p.scrollback || 5000))
  const themes = useTermThemes()
  const [mode, setMode] = useState<TermTheme>(terminalTheme)
  const shown = mode === 'app' ? (appDark() ? 'dark' : 'light') : mode
  return (
    <Section title="Terminal" description="How terminals behave in Workspace and session tabs, kept on this device. Open terminals change at once.">
      <TermPreview p={p} size={size} palette={paletteFor(themes, p, shown)} />
      <Group title="Terminal themes" description="Built-in colour themes. Each mode keeps its own, so a light app can still have a dark terminal.">
        <Row
          label="Theme mode"
          control={
            <Segmented
              label="Theme mode"
              value={mode}
              onChange={(t) => {
                setMode(t)
                setTerminalTheme(t)
              }}
              options={[
                ['app', 'Same as app'],
                ['light', 'Light'],
                ['dark', 'Dark']
              ]}
            />
          }
        />
        {themes ? (
          <>
            <ThemePicker label="Dark theme" themes={themes.dark} value={p.darkTheme} onPick={(darkTheme) => set({ darkTheme })} />
            <ThemePicker label="Light theme" themes={themes.light} value={p.lightTheme} onPick={(lightTheme) => set({ lightTheme })} />
          </>
        ) : (
          <p className="py-3 text-xs text-muted-foreground">Loading themes…</p>
        )}
      </Group>
      <Group title="Cursor">
        <Row
          label="Cursor shape"
          control={
            <Segmented
              label="Cursor shape"
              value={p.cursorStyle || 'block'}
              onChange={(cursorStyle) => set({ cursorStyle: cursorStyle as TermPrefs['cursorStyle'] })}
              options={[
                ['block', 'Block'],
                ['bar', 'Bar'],
                ['underline', 'Underline']
              ]}
            />
          }
        />
        <SwitchRow label="Blinking cursor" checked={p.cursorBlink !== false} onChange={(cursorBlink) => set({ cursorBlink })} />
      </Group>
      <Group title="Typography">
        <Row
          label="Font"
          description="A font installed on this device. Empty uses JetBrains Mono, then the system's monospace font."
          control={
            <input
              defaultValue={p.fontFamily || ''}
              onBlur={(e) => e.target.value.trim() !== (p.fontFamily || '') && set({ fontFamily: e.target.value.trim() })}
              placeholder="JetBrains Mono"
              spellCheck={false}
              className={cn(inputClass, 'w-56')}
            />
          }
        />
        <Row
          label="Font size"
          control={
            <select value={size} onChange={(e) => setSize(Number(e.target.value))} className={cn(inputClass, 'w-28')}>
              {FONT_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} px
                </option>
              ))}
            </select>
          }
        />
        <Row
          label="Font weight"
          control={
            <Segmented
              label="Font weight"
              value={p.fontWeight || 'normal'}
              onChange={(fontWeight) => set({ fontWeight })}
              options={[
                ['normal', 'Normal'],
                ['bold', 'Bold']
              ]}
            />
          }
        />
        <Row
          label="Line height"
          control={
            <Segmented
              label="Line height"
              value={String(p.lineHeight || 1.15)}
              onChange={(v) => set({ lineHeight: Number(v) })}
              options={[
                ['1', '1.0'],
                ['1.15', '1.15'],
                ['1.3', '1.3'],
                ['1.5', '1.5']
              ]}
            />
          }
        />
        <Row
          label="Padding"
          description="Space between the terminal's edge and its text."
          control={
            <Segmented
              label="Padding"
              value={String(p.padding ?? 6)}
              onChange={(v) => set({ padding: Number(v) })}
              options={[
                ['0', 'None'],
                ['6', 'Small'],
                ['12', 'Medium'],
                ['20', 'Large']
              ]}
            />
          }
        />
      </Group>
      <Group title="Terminal interaction">
        <SwitchRow
          label="Copy on select"
          description="Selecting text copies it, as in many Linux terminals. Over plain http the browser may refuse; the apps always can."
          checked={Boolean(p.copyOnSelect)}
          onChange={(copyOnSelect) => set({ copyOnSelect })}
        />
        <SwitchRow
          label="Right-click to paste"
          description="Right-clicking pastes the clipboard instead of opening the browser's menu."
          checked={Boolean(p.rightClickPaste)}
          onChange={(rightClickPaste) => set({ rightClickPaste })}
        />
        <Row
          label="Scrollback rows"
          description="Lines kept above the screen in this view. tmux keeps its own history, which the session's scroll mode shows."
          control={
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={500}
                max={100000}
                step={500}
                value={scroll}
                onChange={(e) => setScroll(e.target.value)}
                onBlur={() => {
                  const n = Math.min(100000, Math.max(500, Number(scroll) || 5000))
                  setScroll(String(n))
                  set({ scrollback: n })
                }}
                className={cn(inputClass, 'w-28')}
              />
              <span className="text-xs text-muted-foreground">rows</span>
            </span>
          }
        />
      </Group>
    </Section>
  )
}

export function BrowserSection() {
  const [p, setP] = useState(browserPrefs)
  const [home, setHome] = useState(p.home)
  const change = (c: Partial<typeof p>) => {
    setBrowserPrefs(c)
    setP(browserPrefs())
  }
  return (
    <Section title="Browser" description="The browser tabs in Workspace, kept on this device. Pages from your machines open inside Yardbell; most public sites refuse to, so they open in your own browser.">
      <Group>
        <Row
          label="Default search engine"
          description="What the address bar searches when you type words instead of an address."
          control={
            <select value={p.engine} onChange={(e) => change({ engine: e.target.value })} className={cn(inputClass, 'w-48')}>
              {Object.entries(ENGINES).map(([id, e]) => (
                <option key={id} value={id}>
                  {e.label}
                </option>
              ))}
            </select>
          }
        />
        <Row
          label="Default home page"
          description="Where a new browser tab opens. Empty shows the new tab page with your machines' apps and recent pages."
          control={
            <span className="flex items-center gap-2">
              <input value={home} onChange={(e) => setHome(e.target.value)} placeholder="http://localhost:3000" spellCheck={false} autoCapitalize="off" className={cn(inputClass, 'w-64')} />
              <Button
                size="sm"
                variant="outline"
                disabled={home.trim() === p.home}
                onClick={() => {
                  const v = home.trim()
                  const url = v && !/^[a-z]+:\/\//i.test(v) ? `http://${v}` : v
                  setHome(url)
                  change({ home: url })
                  toast('Home page saved.')
                }}
              >
                Save
              </Button>
            </span>
          }
        />
        <Row
          label="Default zoom"
          description="The zoom a new tab starts at. Each tab's own zoom buttons still change it."
          control={
            <select value={String(p.zoom)} onChange={(e) => change({ zoom: Number(e.target.value) })} className={cn(inputClass, 'w-32')}>
              {[0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5].map((z) => (
                <option key={z} value={z}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
          }
        />
      </Group>
    </Section>
  )
}
