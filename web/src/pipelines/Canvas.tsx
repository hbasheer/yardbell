import { useEffect, useLayoutEffect, useRef } from 'react'
import { Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { describe, LINE_WORDS, nodeState, OUTCOMES, triggerWords, TRIGGER_TAGS, type Definition, type Outcome, type Run, type Step } from './model'
import { KindIcon } from './icons'

export const NODE_W = 220
export const NODE_H = 124
const START_GAP = 280
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2
const MINI_W = 168
const MINI_H = 104
const SNAP = 8
const PORT_Y: Record<string, number> = { pass: 0.3, fail: 0.55, needs_you: 0.8 }
const snap = (n: number) => Math.round(n / SNAP) * SNAP

type Pt = { x: number; y: number }
type View = { x: number; y: number; k: number }

export type CanvasEvents = {
  select?: (id: string | null) => void
  begin?: () => void
  move?: (step: string, x: number, y: number) => void
  connect?: (from: string, outcome: string, to: string) => void
  drop?: (at: Pt, from: string, outcome: string, clientX: number, clientY: number) => void
}

function layout(d: Definition) {
  const first = d.steps.find((s) => s.id === d.start)
  const start = first ? { x: first.x - START_GAP, y: first.y } : { x: 40, y: 120 }
  const xs = [start.x, ...d.steps.map((s) => s.x)]
  const ys = [start.y, ...d.steps.map((s) => s.y)]
  const minX = Math.min(...xs) - 60
  const minY = Math.min(...ys) - 60
  return { start, ox: -minX, oy: -minY, width: Math.max(...xs) - minX + NODE_W + 60, height: Math.max(...ys) - minY + NODE_H + 200 }
}

function cubicMid(p0: Pt, p1: Pt, p2: Pt, p3: Pt) {
  const at = (a: number, b: number, c: number, e: number) => 0.125 * a + 0.375 * b + 0.375 * c + 0.125 * e
  return { x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) }
}

// A plain curve forwards; backwards, a loop under both cards.
export function line(a: Pt, b: Pt) {
  if (b.x >= a.x + 40) {
    const dx = Math.max(40, (b.x - a.x) / 2)
    const c1 = { x: a.x + dx, y: a.y }
    const c2 = { x: b.x - dx, y: b.y }
    return { d: `M${a.x} ${a.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`, label: cubicMid(a, c1, c2, b) }
  }
  const otherRow = Math.abs(b.y - a.y) > NODE_H * 0.75
  const turn = otherRow ? (a.y + b.y) / 2 : Math.max(a.y, b.y) + NODE_H / 2 + 56
  const mid = { x: (a.x + b.x) / 2, y: turn }
  return { d: `M${a.x} ${a.y} C${a.x + 70} ${a.y} ${a.x + 70} ${turn} ${mid.x} ${turn} S${b.x - 70} ${b.y} ${b.x} ${b.y}`, label: mid }
}

const outPort = (s: Step, o: string, ox: number, oy: number) => ({ x: s.x + ox + NODE_W, y: s.y + oy + NODE_H * PORT_Y[o] })
const inPort = (s: Step, ox: number, oy: number) => ({ x: s.x + ox, y: s.y + oy + NODE_H / 2 })

const views = new Map<string, View>()
const origins = new Map<string, { ox: number; oy: number }>()

const EDGE: Record<string, string> = {
  pass: 'stroke-[var(--canvas-line)]',
  fail: 'stroke-[color-mix(in_srgb,var(--destructive)_70%,var(--canvas-line))] [stroke-dasharray:5_4]',
  needs_you: 'stroke-[color-mix(in_srgb,var(--status-warning)_75%,var(--canvas-line))] [stroke-dasharray:2_4]',
  taken: 'stroke-status-success stroke-2'
}
const HEAD: Record<string, string> = {
  pass: 'fill-[var(--canvas-line)]',
  fail: 'fill-[color-mix(in_srgb,var(--destructive)_70%,var(--canvas-line))]',
  needs_you: 'fill-[color-mix(in_srgb,var(--status-warning)_75%,var(--canvas-line))]',
  taken: 'fill-status-success'
}

const NODE_STATE: Record<string, string> = {
  done: 'border-[color-mix(in_srgb,var(--status-success)_50%,var(--border))]',
  failed: 'border-[color-mix(in_srgb,var(--destructive)_45%,var(--border))]',
  now: 'border-foreground shadow-[0_0_0_3px_color-mix(in_srgb,var(--foreground)_15%,transparent)]',
  waiting: 'border-status-warning shadow-[0_0_0_3px_color-mix(in_srgb,var(--status-warning)_22%,transparent)]',
  later: 'opacity-55'
}

function NodeBody({ kind, name, mark, who, does, tags, start }: { kind: string; name: string; mark: string; who: string; does: string; tags: string[]; start?: boolean }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-[7px]">
        <span className={cn('grid size-[22px] flex-none place-items-center rounded-md', start ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
          <KindIcon kind={kind} className="size-3.5" />
        </span>
        <b className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{name}</b>
        {mark && (
          <span aria-hidden className={cn('text-xs font-bold', mark === '✗' ? 'text-destructive' : mark === '!' ? 'text-status-warning-text' : 'text-status-success')}>
            {mark}
          </span>
        )}
      </div>
      <small className="truncate text-[11.5px] text-muted-foreground">{who}</small>
      <p className="line-clamp-2 min-h-[2.8em] text-xs leading-[1.4] [overflow-wrap:anywhere] text-foreground/80">{does}</p>
      <div className="mt-auto flex gap-1 overflow-hidden">
        {tags.map((t) => (
          <span key={t} className="max-w-full flex-none truncate rounded-full border border-border px-1.5 text-[11px] leading-[17px] text-muted-foreground">
            {t}
          </span>
        ))}
      </div>
    </>
  )
}

export function PipelineCanvas({
  def: d,
  run = null,
  editable = false,
  selected = null,
  problems = [],
  on = {},
  viewKey,
  className,
  children
}: {
  def: Definition
  run?: Run | null
  editable?: boolean
  selected?: string | null
  problems?: string[]
  on?: CanvasEvents
  viewKey: string
  className?: string
  children?: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const pan = useRef<HTMLDivElement>(null)
  const pct = useRef<HTMLSpanElement>(null)
  const miniView = useRef<SVGRectElement>(null)
  const ghost = useRef<SVGPathElement>(null)
  const held = useRef<null | Record<string, any>>(null)
  const touches = useRef(new Map<number, Pt>())
  const onRef = useRef(on)
  onRef.current = on

  const lay = layout(d)
  const at = Object.fromEntries(d.steps.map((s) => [s.id, s]))
  const mini = Math.min(MINI_W / lay.width, MINI_H / lay.height)

  const place = () => {
    const c = box.current
    const v = views.get(viewKey)
    if (!c || !v || !pan.current) return
    pan.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`
    c.style.backgroundPosition = `${v.x}px ${v.y}px`
    c.style.backgroundSize = `${24 * v.k}px ${24 * v.k}px`
    if (pct.current) pct.current.textContent = `${Math.round(v.k * 100)}%`
    const r = miniView.current
    if (r) {
      r.setAttribute('x', String((-v.x / v.k) * mini))
      r.setAttribute('y', String((-v.y / v.k) * mini))
      r.setAttribute('width', String((c.clientWidth / v.k) * mini))
      r.setAttribute('height', String((c.clientHeight / v.k) * mini))
    }
  }
  const setView = (v: View) => {
    views.set(viewKey, { ...v, k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k)) })
    place()
  }

  // Fits the whole graph when it stays readable, and otherwise centres on the step that matters.
  const fit = (whole = false) => {
    const c = box.current
    if (!c) return
    const cw = c.clientWidth
    const ch = c.clientHeight
    if (!cw || !ch) return
    const all = Math.min(1, (cw - 32) / lay.width, (ch - 32) / lay.height)
    const k = whole ? Math.max(MIN_ZOOM, all) : all >= 0.75 ? all : 0.85
    let x = (cw - lay.width * k) / 2
    let y = Math.max(16, (ch - lay.height * k) / 2)
    const focus = c.querySelector<HTMLElement>('[data-focus="true"]')
    const node = focus || c.querySelector<HTMLElement>('[data-step]')
    if (!whole && lay.width * k > cw) x = focus ? cw / 2 - (focus.offsetLeft + focus.offsetWidth / 2) * k : 16
    if (!whole && lay.height * k > ch && node) y = ch / 2 - (node.offsetTop + node.offsetHeight / 2) * k
    setView({ x, y, k })
  }

  useLayoutEffect(() => {
    const v = views.get(viewKey)
    const was = origins.get(viewKey)
    origins.set(viewKey, { ox: lay.ox, oy: lay.oy })
    if (!v) fit()
    else {
      if (was && (was.ox !== lay.ox || was.oy !== lay.oy)) views.set(viewKey, { ...v, x: v.x - (lay.ox - was.ox) * v.k, y: v.y - (lay.oy - was.oy) * v.k })
      place()
    }
  })

  useEffect(() => {
    const c = box.current
    if (!c) return
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('textarea, select')) return
      e.preventDefault()
      const v = views.get(viewKey)
      if (!v) return
      if (e.ctrlKey || e.metaKey) {
        const r = c.getBoundingClientRect()
        zoomAt(Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top)
        return
      }
      setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })
    }
    c.addEventListener('wheel', wheel, { passive: false })
    const resize = new ResizeObserver(() => place())
    resize.observe(c)
    return () => {
      c.removeEventListener('wheel', wheel)
      resize.disconnect()
    }
  })

  const zoomAt = (factor: number, px: number, py: number) => {
    const v = views.get(viewKey)
    if (!v) return
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor))
    setView({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k })
  }
  const zoomBy = (factor: number) => {
    const c = box.current
    if (c) zoomAt(factor, c.clientWidth / 2, c.clientHeight / 2)
  }

  const toInner = (cx: number, cy: number) => {
    const v = views.get(viewKey)!
    const r = box.current!.getBoundingClientRect()
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k }
  }
  const toWorld = (cx: number, cy: number) => {
    const p = toInner(cx, cy)
    return { x: p.x - lay.ox, y: p.y - lay.oy }
  }

  const capture = (e: React.PointerEvent) => {
    const h = held.current
    if (!h || h.captured) return
    h.captured = true
    try {
      box.current!.setPointerCapture(e.pointerId)
    } catch {}
    box.current!.dataset.grabbing = 'true'
  }

  const down = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const t = e.target as HTMLElement
    if (e.button !== 0 || t.closest('[data-own-drag], button, input, select, textarea, a')) return
    const port = editable && t.closest<HTMLElement>('[data-port="out"]')
    const node = editable && t.closest<HTMLElement>('[data-step]:not([data-step="@start"])')
    if (port) {
      const r = port.getBoundingClientRect()
      held.current = {
        id: e.pointerId,
        kind: 'line',
        from: port.closest<HTMLElement>('[data-step]')!.dataset.step,
        outcome: port.dataset.outcome,
        start: toInner(r.left + r.width / 2, r.top + r.height / 2),
        x: e.clientX,
        y: e.clientY,
        moved: false
      }
    } else if (node) {
      held.current = { id: e.pointerId, kind: 'card', step: node.dataset.step, at: { x: Number(node.dataset.x), y: Number(node.dataset.y) }, x0: e.clientX, y0: e.clientY, moved: false }
    } else {
      held.current = { id: e.pointerId, kind: 'pan', x: e.clientX, y: e.clientY, moved: false }
    }
  }

  const move = (e: React.PointerEvent) => {
    if (touches.current.has(e.pointerId)) {
      const before = [...touches.current.values()]
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.current.size === 2) {
        const after = [...touches.current.values()]
        const dist = (p: Pt[]) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
        const r = box.current!.getBoundingClientRect()
        zoomAt(dist(after) / dist(before), (after[0].x + after[1].x) / 2 - r.left, (after[0].y + after[1].y) / 2 - r.top)
        held.current = null
        return
      }
    }
    const h = held.current
    if (!h || h.id !== e.pointerId) return
    const v = views.get(viewKey)!
    if (h.kind === 'line') {
      h.moved ||= Math.hypot(e.clientX - h.x, e.clientY - h.y) > 4
      capture(e)
      ghost.current?.setAttribute('d', line(h.start, toInner(e.clientX, e.clientY)).d)
      return
    }
    if (h.kind === 'card') {
      if (!h.moved && Math.hypot(e.clientX - h.x0, e.clientY - h.y0) > 4) {
        h.moved = true
        capture(e)
        onRef.current.begin?.()
      }
      if (h.moved) onRef.current.move?.(h.step, snap(h.at.x + (e.clientX - h.x0) / v.k), snap(h.at.y + (e.clientY - h.y0) / v.k))
      return
    }
    h.moved ||= Math.hypot(e.clientX - h.x, e.clientY - h.y) > 3
    if (!h.moved) return
    capture(e)
    setView({ ...v, x: v.x + e.clientX - h.x, y: v.y + e.clientY - h.y })
    h.x = e.clientX
    h.y = e.clientY
  }

  const up = (e: React.PointerEvent) => {
    touches.current.delete(e.pointerId)
    if (box.current) delete box.current.dataset.grabbing
    const h = held.current
    held.current = null
    if (!h || h.id !== e.pointerId) return
    if (h.kind === 'line') {
      ghost.current?.setAttribute('d', '')
      if (e.type !== 'pointerup' || !h.moved) return
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-step]')
      if (over && over.dataset.step !== '@start' && over.dataset.step !== h.from) onRef.current.connect?.(h.from, h.outcome, over.dataset.step!)
      else if (!over) onRef.current.drop?.(toWorld(e.clientX, e.clientY), h.from, h.outcome, e.clientX, e.clientY)
      return
    }
    if (h.kind === 'pan' && !h.moved && e.type === 'pointerup' && !(e.target as HTMLElement).closest('[data-step], [data-edge]')) onRef.current.select?.(null)
  }

  const seeFromMinimap = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const v = views.get(viewKey)
    const c = box.current
    if (!v || !c) return
    const wx = (e.clientX - r.left) / mini
    const wy = (e.clientY - r.top) / mini
    setView({ ...v, x: c.clientWidth / 2 - wx * v.k, y: c.clientHeight / 2 - wy * v.k })
  }

  const lines: { cls: string; from: string; outcome: string; to: string; d: string; label: Pt; word: string }[] = []
  const first = at[d.start]
  if (first) {
    const a = { x: lay.start.x + lay.ox + NODE_W, y: lay.start.y + lay.oy + NODE_H / 2 }
    lines.push({ cls: 'pass', from: '@start', outcome: 'start', to: first.id, ...line(a, inPort(first, lay.ox, lay.oy)), word: '' })
  }
  for (const s of d.steps) {
    for (const o of OUTCOMES) {
      const to = s.next?.[o]
      if (!to || !at[to]) continue
      const taken = Boolean(run && run.steps?.[s.id]?.outcome === o && run.steps?.[to])
      lines.push({ cls: taken ? 'taken' : o, from: s.id, outcome: o, to, word: LINE_WORDS[o], ...line(outPort(s, o, lay.ox, lay.oy), inPort(at[to], lay.ox, lay.oy)) })
    }
  }
  const trigger = d.trigger || { kind: 'manual' }
  const pickable = editable || Boolean(on.select)

  return (
    <div
      ref={box}
      aria-label={editable ? 'Pipeline builder canvas' : 'Steps of this run'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className={cn(
        'relative min-h-0 min-w-0 cursor-grab overflow-clip bg-background select-none data-[grabbing=true]:cursor-grabbing',
        '[--canvas-line:color-mix(in_srgb,var(--foreground)_28%,transparent)] [background-image:radial-gradient(color-mix(in_srgb,var(--foreground)_16%,transparent)_1px,transparent_1px)] [background-size:24px_24px]',
        editable ? 'touch-none' : 'touch-pan-y',
        className
      )}
    >
      <div ref={pan} className="origin-top-left">
        <div className="relative" style={{ width: lay.width, height: lay.height }}>
          <svg width={lay.width} height={lay.height} aria-hidden className="pointer-events-none absolute inset-0 overflow-visible">
            <defs>
              {Object.keys(HEAD).map((k) => (
                <marker key={k} id={`pl-arrow-${viewKey}-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 8 4 0 8z" className={HEAD[k]} />
                </marker>
              ))}
            </defs>
            {lines.map((l) => (
              <path
                key={`${l.from}:${l.outcome}`}
                d={l.d}
                className={cn('fill-none stroke-[1.6]', EDGE[l.cls], selected === `line:${l.from}:${l.outcome}` && 'stroke-foreground stroke-[2.4] [stroke-dasharray:none]')}
                markerEnd={`url(#pl-arrow-${viewKey}-${l.cls})`}
              />
            ))}
            {editable &&
              lines
                .filter((l) => l.from !== '@start')
                .map((l) => (
                  <path
                    key={`hit:${l.from}:${l.outcome}`}
                    data-edge=""
                    d={l.d}
                    className="pointer-events-[stroke] cursor-pointer fill-none stroke-transparent stroke-[14]"
                    onClick={(e) => {
                      e.stopPropagation()
                      on.select?.(`line:${l.from}:${l.outcome}`)
                    }}
                  />
                ))}
            <path ref={ghost} d="" className="fill-none stroke-foreground stroke-2 [stroke-dasharray:4_4]" />
          </svg>
          {lines
            .filter((l) => l.word && l.outcome !== 'pass')
            .map((l) => (
              <span
                key={`w:${l.from}:${l.outcome}`}
                className={cn(
                  'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-card px-1.5 text-[11px] leading-[18px] font-medium whitespace-nowrap shadow-[0_0_0_1px_var(--border)]',
                  l.outcome === 'fail' ? 'text-destructive' : 'text-status-warning-text'
                )}
                style={{ left: l.label.x, top: l.label.y }}
              >
                {l.word}
              </span>
            ))}
          <div
            data-step="@start"
            tabIndex={editable ? 0 : undefined}
            role={editable ? 'button' : undefined}
            aria-label={editable ? 'Start when, the trigger' : undefined}
            onKeyDown={editable ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), on.select?.('@start')) : undefined}
            onClick={
              editable
                ? (e) => {
                    e.stopPropagation()
                    on.select?.('@start')
                  }
                : undefined
            }
            className={cn(
              'absolute flex h-[124px] w-[220px] flex-col gap-[3px] rounded-xl border border-border bg-card px-3 py-2.5 text-[12.5px] shadow-xs',
              editable && 'cursor-pointer hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              editable && selected === '@start' && 'border-foreground shadow-[0_0_0_3px_color-mix(in_srgb,var(--foreground)_15%,transparent)]'
            )}
            style={{ left: lay.start.x + lay.ox, top: lay.start.y + lay.oy }}
          >
            <NodeBody
              start
              kind="start"
              name="Start when"
              mark=""
              who="Trigger"
              does={triggerWords(trigger)}
              tags={[TRIGGER_TAGS[trigger.kind] || 'by hand', trigger.kind === 'manual' ? 'Run now' : 'checked every 3 min']}
            />
            {editable && <span data-port="out" data-outcome="start" title="The first step" className={PORT_CLASS} style={{ left: '100%', top: '50%', background: 'var(--foreground)' }} />}
          </div>
          {d.steps.map((s) => {
            const n = nodeState(run, s)
            const problem = problems.some((p) => p.startsWith(`${s.name}: `) || p === `${s.name} is never reached`)
            const desc = describe(s)
            const label = editable ? `${s.name}, ${desc.who}` : `${s.name}, ${n.note}. Show its result`
            return (
              <div
                key={s.id}
                data-step={s.id}
                data-x={s.x}
                data-y={s.y}
                data-focus={n.cls === 'waiting' || n.cls === 'now' || selected === s.id ? 'true' : undefined}
                tabIndex={pickable ? 0 : undefined}
                role={pickable ? 'button' : undefined}
                aria-label={pickable ? label : undefined}
                aria-pressed={pickable && !editable ? selected === s.id : undefined}
                onKeyDown={pickable ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), on.select?.(s.id)) : undefined}
                onClick={
                  pickable
                    ? (e) => {
                        e.stopPropagation()
                        on.select?.(s.id)
                      }
                    : undefined
                }
                className={cn(
                  'absolute flex h-[124px] w-[220px] flex-col gap-[3px] rounded-xl border border-border bg-card px-3 py-2.5 text-[12.5px] shadow-xs',
                  n.cls && NODE_STATE[n.cls],
                  pickable && 'cursor-pointer hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  selected === s.id && 'border-foreground shadow-[0_0_0_3px_color-mix(in_srgb,var(--foreground)_15%,transparent)]',
                  problem && 'border-destructive shadow-[0_0_0_3px_color-mix(in_srgb,var(--destructive)_18%,transparent)]'
                )}
                style={{ left: s.x + lay.ox, top: s.y + lay.oy }}
              >
                {editable && <span aria-hidden className={PORT_CLASS} style={{ left: 0, top: '50%' }} />}
                <NodeBody kind={s.kind} name={s.name} mark={run ? n.mark : ''} who={desc.who} does={run ? n.note : desc.does} tags={desc.tags} />
                {editable &&
                  OUTCOMES.map((o: Outcome) => (
                    <span
                      key={o}
                      data-port="out"
                      data-outcome={o}
                      title={`On ${LINE_WORDS[o]}`}
                      className={cn(PORT_CLASS, 'cursor-crosshair')}
                      style={{
                        left: '100%',
                        top: `${PORT_Y[o] * 100}%`,
                        background: o === 'pass' ? 'var(--foreground)' : o === 'fail' ? 'var(--destructive)' : 'var(--status-warning)'
                      }}
                    />
                  ))}
              </div>
            )
          })}
        </div>
      </div>
      {children}
      <div data-own-drag className="absolute bottom-3 left-3 flex items-center gap-1 rounded-[10px] border border-border bg-card p-[3px] shadow-xs">
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.25)} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <Minus className="size-3.5" />
        </button>
        <span ref={pct} aria-live="polite" className="min-w-11 text-center text-xs font-medium text-muted-foreground tabular-nums">
          100%
        </span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <Plus className="size-3.5" />
        </button>
        <button type="button" onClick={() => fit(true)} className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          Fit
        </button>
      </div>
      <svg
        data-own-drag
        width={lay.width * mini}
        height={lay.height * mini}
        aria-label="Overview; click to move there"
        onPointerDown={(e) => {
          e.stopPropagation()
          e.currentTarget.setPointerCapture?.(e.pointerId)
          seeFromMinimap(e)
        }}
        onPointerMove={(e) => e.buttons && seeFromMinimap(e)}
        className="absolute right-3 bottom-3 box-content cursor-pointer touch-none rounded-[10px] border border-border bg-card p-1.5 shadow-xs max-md:hidden"
      >
        {[{ x: lay.start.x, y: lay.start.y, id: '' } as Step, ...d.steps].map((n) => {
          const cls = n.id && run ? nodeState(run, n).cls : ''
          return (
            <rect
              key={n.id || '@start'}
              x={(n.x + lay.ox) * mini}
              y={(n.y + lay.oy) * mini}
              width={NODE_W * mini}
              height={NODE_H * mini}
              rx="2"
              className={cn(
                'stroke-[color-mix(in_srgb,var(--foreground)_25%,transparent)] stroke-[0.6]',
                cls === 'done' ? 'fill-[color-mix(in_srgb,var(--status-success)_35%,var(--card))]' : cls === 'waiting' ? 'fill-[color-mix(in_srgb,var(--status-warning)_45%,var(--card))]' : cls === 'now' ? 'fill-[color-mix(in_srgb,var(--foreground)_30%,var(--card))]' : 'fill-muted'
              )}
            />
          )
        })}
        <rect ref={miniView} x="0" y="0" width="0" height="0" rx="3" className="fill-[color-mix(in_srgb,var(--foreground)_6%,transparent)] stroke-foreground/60 stroke-[1.2]" />
      </svg>
    </div>
  )
}

const PORT_CLASS = 'absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-muted-foreground shadow-[0_0_0_1px_var(--border)]'
