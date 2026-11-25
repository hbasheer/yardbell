// Browser chrome adapted from Orca's browser pane (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Ellipsis, ExternalLink, Globe, History, Minus, Monitor, Plus, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { later } from '@/components/ui/menu-items'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { hostOf, matching, recordVisit, useHistory } from '@/lib/browser-history'
import type { YardbellState } from '@/lib/state'
import { BrowserHistory } from './BrowserHistory'
import { BrowserNewTab, Favicon } from './BrowserNewTab'
import { browserPrefs, searchUrl } from '@/lib/browser-prefs'
import type { Place } from './SendNotes'

const VIEWPORTS = [
  { id: 'mobile-s', label: 'Mobile S', width: 320, height: 568 },
  { id: 'mobile-m', label: 'Mobile M', width: 375, height: 667 },
  { id: 'mobile-l', label: 'Mobile L', width: 425, height: 812 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'laptop', label: 'Laptop', width: 1024, height: 768 },
  { id: 'laptop-l', label: 'Laptop L', width: 1440, height: 900 },
  { id: 'desktop', label: 'Desktop', width: 1920, height: 1080 }
]
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

const looksLikeUrl = (v: string) => /^[a-z]+:\/\//i.test(v) || /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(v) || /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(v)
const toUrl = (v: string) => (/^[a-z]+:\/\//i.test(v) ? v : `http://${v}`)

// Pages Yardbell's own machines serve load inside a frame; most public sites forbid it with frame headers.
function framesFreely(url: string) {
  try {
    const host = new URL(url).hostname
    return host === location.hostname || host === 'localhost' || /^(127\.|10\.|192\.168\.|100\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || !host.includes('.')
  } catch {
    return true
  }
}


// Eases toward 90% while loading since a frame reports no progress, and the real load finishes it.
function LoadProgress({ loading }: { loading: boolean }) {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const running = el.getAnimations()[0]
    if (loading) {
      if (running) return
      el.animate(
        [
          { offset: 0, transform: 'scaleX(0)', opacity: 0 },
          { offset: 0.01, transform: 'scaleX(0.15)', opacity: 1 },
          { offset: 0.07, transform: 'scaleX(0.45)', opacity: 1 },
          { offset: 0.2, transform: 'scaleX(0.7)', opacity: 1 },
          { offset: 0.5, transform: 'scaleX(0.85)', opacity: 1 },
          { offset: 1, transform: 'scaleX(0.9)', opacity: 1 }
        ],
        { duration: 30_000, delay: 200, fill: 'forwards', easing: 'ease-out' }
      )
      return
    }
    if (!running) return
    const { transform, opacity } = getComputedStyle(el)
    running.cancel()
    if (Number(opacity) === 0) return
    el.animate(
      [{ transform, opacity }, { transform: 'scaleX(1)', opacity, offset: 0.4 }, { transform: 'scaleX(1)', opacity: 0 }],
      { duration: 450, easing: 'ease-out' }
    )
  }, [loading])
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
      <div ref={bar} className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-callout-note opacity-0" />
    </div>
  )
}

type Suggestion = { url: string; title: string; subtitle?: string; search?: boolean }

function AddressBar({
  url,
  loading,
  inputRef,
  onNavigate
}: {
  url: string
  loading: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  onNavigate: (url: string, external?: boolean) => void
}) {
  const history = useHistory()
  const [value, setValue] = useState(url)
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState(-1)
  useEffect(() => setValue(url), [url])

  const typed = value.trim()
  const suggestions: Suggestion[] = []
  if (open && typed && typed !== url) {
    if (looksLikeUrl(typed)) suggestions.push({ url: toUrl(typed), title: toUrl(typed) })
    for (const v of matching(history, typed, 6)) if (!suggestions.some((s) => s.url === v.url)) suggestions.push({ url: v.url, title: v.title || hostOf(v.url), subtitle: v.url })
    if (!looksLikeUrl(typed)) suggestions.push({ url: searchUrl(typed), title: typed, subtitle: 'Search the web, opens in your browser', search: true })
  }

  const choose = (s: Suggestion) => {
    setOpen(false)
    setPick(-1)
    inputRef.current?.blur()
    if (s.search) {
      setValue(url)
      onNavigate(s.url, true)
    } else onNavigate(s.url)
  }

  const submit = () => {
    if (pick >= 0 && suggestions[pick]) return choose(suggestions[pick])
    if (!typed) return
    choose(looksLikeUrl(typed) ? { url: toUrl(typed), title: typed } : { url: searchUrl(typed), title: typed, search: true })
  }

  return (
    <div className="relative flex min-w-11 flex-1 items-stretch">
      <form
        className="relative flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-transparent bg-muted px-2.5 transition-colors focus-within:border-border"
        onClick={() => inputRef.current?.focus()}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {url ? <Favicon url={url} className="size-3.5 shrink-0" /> : <Globe className="size-3.5 shrink-0 text-muted-foreground" />}
        <input
          ref={inputRef}
          value={value}
          placeholder="Search or enter URL"
          aria-label="Address"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="browser-suggestions"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            setValue(e.target.value)
            setOpen(true)
            setPick(-1)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setPick((p) => Math.max(-1, Math.min(suggestions.length - 1, p + (e.key === 'ArrowDown' ? 1 : -1))))
            } else if (e.key === 'Escape') {
              if (open && suggestions.length) setOpen(false)
              else {
                setValue(url)
                e.currentTarget.blur()
              }
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
        <LoadProgress loading={loading} />
      </form>
      {suggestions.length > 0 && (
        <div
          id="browser-suggestions"
          role="listbox"
          className="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-[12px] border border-black/7 bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:border-white/9"
        >
          {suggestions.map((s, i) => (
            <div
              key={`${s.search ? 'search:' : ''}${s.url}`}
              role="option"
              aria-selected={pick === i}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setPick(i)}
              onClick={() => choose(s)}
              className={cn('flex cursor-pointer items-center gap-2 rounded-md px-3 py-2', pick === i && 'bg-accent')}
            >
              {s.search ? <Search className="size-3.5 shrink-0 text-muted-foreground" /> : <Favicon url={s.url} className="size-3.5 shrink-0" />}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{s.title}</span>
                {s.subtitle && <span className="truncate text-xs text-muted-foreground">{s.subtitle}</span>}
              </div>
              {s.search && <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ReloadButton({ onReload, onHardReload }: { onReload: () => void; onHardReload: () => void }) {
  const [menu, setMenu] = useState(false)
  return (
    <DropdownMenu modal={false} open={menu} onOpenChange={setMenu}>
      <Hint label="Reload · right-click for Hard Reload" side="bottom">
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-xs"
            variant="muted-field-icon"
            aria-label="Reload"
            onPointerDown={(e) => e.button === 0 && e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onReload()
              }
            }}
            onClick={onReload}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(true)
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" alignOffset={-4}>
        <DropdownMenuItem onSelect={onReload}>Reload</DropdownMenuItem>
        <DropdownMenuItem onSelect={onHardReload}>Hard Reload</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function BrowserView({ url, place, state, onUrl }: { url: string; place: Place | null; state: YardbellState | null; onUrl: (url: string) => void }) {
  const [trail, setTrail] = useState<{ list: string[]; at: number }>({ list: url ? [url] : [], at: url ? 0 : -1 })
  const [loading, setLoading] = useState(Boolean(url))
  const [frameKey, setFrameKey] = useState(0)
  const [zoom, setZoom] = useState(() => browserPrefs().zoom || 1)
  const [viewport, setViewport] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [notice, setNotice] = useState(true)
  const frame = useRef<HTMLIFrameElement>(null)
  const address = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (url && trail.list[trail.at] !== url) setTrail((t) => ({ list: [...t.list.slice(0, t.at + 1), url], at: t.at + 1 }))
  }, [url])

  const show = (next: string) => {
    setLoading(Boolean(next))
    setNotice(true)
    onUrl(next)
    if (next) recordVisit(next)
  }

  const navigate = (next: string, external?: boolean) => {
    if (external) {
      window.open(next, '_blank', 'noopener')
      return
    }
    setTrail((t) => ({ list: [...t.list.slice(0, t.at + 1), next], at: t.at + 1 }))
    if (next === url) reload()
    else show(next)
  }

  const step = (by: number) => {
    const at = trail.at + by
    if (at < 0 || at >= trail.list.length) return
    setTrail((t) => ({ ...t, at }))
    show(trail.list[at])
  }

  const reload = () => {
    if (!frame.current || !url) return
    setLoading(true)
    frame.current.src = url
  }
  const hardReload = () => {
    if (!url) return
    setLoading(true)
    setFrameKey((k) => k + 1)
  }

  const onLoad = () => {
    setLoading(false)
    try {
      const here = frame.current?.contentWindow?.location.href
      if (here && here !== 'about:blank' && here !== url) onUrl(here)
    } catch {}
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const ctrl = e.metaKey || e.ctrlKey
    if (ctrl && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      address.current?.focus()
    } else if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      setHistoryOpen(true)
    } else if (e.altKey && e.key === 'ArrowLeft') step(-1)
    else if (e.altKey && e.key === 'ArrowRight') step(1)
  }

  const preset = VIEWPORTS.find((v) => v.id === viewport)
  const zoomAt = ZOOMS.indexOf(zoom)
  const frameStyle: React.CSSProperties = preset
    ? { width: preset.width, height: preset.height, zoom }
    : { width: `${100 / zoom}%`, height: `${100 / zoom}%`, zoom }

  return (
    <div className="flex size-full flex-col bg-background" onKeyDown={onKeyDown}>
      <div className="relative z-20 flex shrink-0 items-center gap-1 border-b border-border/70 bg-background/95 px-2 py-1">
        <Hint label="Back" side="bottom">
          <Button size="icon-xs" variant="muted-field-icon" onClick={() => step(-1)} disabled={trail.at <= 0} aria-label="Back">
            <ArrowLeft className="size-3.5" />
          </Button>
        </Hint>
        <Hint label="Forward" side="bottom">
          <Button
            size="icon-xs"
            variant="muted-field-icon"
           
            onClick={() => step(1)}
            disabled={trail.at >= trail.list.length - 1}
            aria-label="Forward"
          >
            <ArrowRight className="size-3.5" />
          </Button>
        </Hint>
        <ReloadButton onReload={reload} onHardReload={hardReload} />
        <div className="mx-1 flex h-8 min-w-0 flex-1 items-stretch">
          <AddressBar url={url} loading={loading} inputRef={address} onNavigate={navigate} />
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size="icon-xs" variant="muted-field-icon" aria-label="Browser menu" title="Browser menu">
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <div className="flex items-center gap-2 px-2.5 py-[5px] text-[13px]">
              <span className="flex-1">Zoom</span>
              <Button size="icon-xs" variant="ghost" aria-label="Zoom out" disabled={zoomAt <= 0} onClick={() => setZoom(ZOOMS[zoomAt - 1])}>
                <Minus className="size-3.5" />
              </Button>
              <button type="button" aria-label="Reset zoom" onClick={() => setZoom(1)} className="w-11 text-center text-xs tabular-nums text-muted-foreground hover:text-foreground">
                {Math.round(zoom * 100)}%
              </button>
              <Button size="icon-xs" variant="ghost" aria-label="Zoom in" disabled={zoomAt >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[zoomAt + 1])}>
                <Plus className="size-3.5" />
              </Button>
            </div>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Monitor className="size-3.5" /> Viewport Size
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={() => setViewport(null)}>
                  <Check className={cn('size-3.5', viewport && 'invisible')} /> Default
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {VIEWPORTS.map((v) => (
                  <DropdownMenuItem key={v.id} onSelect={() => setViewport(v.id)}>
                    <Check className={cn('size-3.5', viewport !== v.id && 'invisible')} />
                    <span className="truncate">
                      {v.label}, {v.width} × {v.height}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!url} onSelect={hardReload}>
              <RotateCcw className="size-3.5" /> Hard Reload
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!url} onSelect={() => window.open(url, '_blank', 'noopener')}>
              <ExternalLink className="size-3.5" /> Open in default browser
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => later(() => setHistoryOpen(true))}>
              <History className="size-3.5" /> History
              <DropdownMenuShortcut>{mod}Y</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {url && notice && !framesFreely(url) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">Many public sites refuse to open inside another page. If this one stays blank, open it in your browser.</span>
          <Button size="xs" variant="outline" onClick={() => window.open(url, '_blank', 'noopener')}>
            <ExternalLink /> Open
          </Button>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(false)} className="grid size-5 place-items-center rounded hover:bg-accent hover:text-foreground">
            <X className="size-3" />
          </button>
        </div>
      )}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden', preset && 'flex items-start justify-center overflow-auto bg-muted/60 p-4')}>
        {url ? (
          <iframe
            key={frameKey}
            ref={frame}
            title={url}
            src={url}
            onLoad={onLoad}
            style={frameStyle}
            className={cn('block shrink-0 border-0 bg-white', preset && 'rounded-md shadow-lg')}
          />
        ) : (
          <BrowserNewTab place={place} state={state} onOpen={(u) => navigate(u)} />
        )}
      </div>
      <BrowserHistory open={historyOpen} onClose={() => setHistoryOpen(false)} onOpen={(u) => navigate(u)} />
    </div>
  )
}
