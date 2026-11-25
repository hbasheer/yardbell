import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Redo2, Trash2, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { NODE_W, PipelineCanvas } from './Canvas'
import { newTrigger, StepForm, TokenLimitForm, TriggerForm, type Data } from './Forms'
import { KindIcon } from './icons'
import { KINDS, triggerWords, WORDS, type Definition, type Step } from './model'

const GAP_X = 260
const GAP_Y = 170
const LIBRARY_KEY = 'yb-pipeline-library'

const LIBRARY: [string, [string, string, string, string][]][] = [
  [
    'Start when',
    [
      ['manual', 'manual', 'By hand', 'From Run now'],
      ['schedule', 'schedule', 'Schedule', 'Weekdays, every day, a time'],
      ['linear', 'ticket', 'New ticket', 'From Linear, Trello or any connection'],
      ['webhook', 'call', 'A webhook', 'Another system calls an address'],
      ['github_review', 'pull', 'GitHub review request', 'A PR asks for my review'],
      ['gitlab_reviewer', 'pull', 'GitLab reviewer', 'An MR adds me as reviewer']
    ]
  ],
  [
    'Agent',
    [
      ['agent', 'agent', 'Agent step', 'Your instructions, on a machine'],
      ['plan', 'plan', 'Plan', 'Picks machine, folder and branch']
    ]
  ],
  [
    'Yardbell',
    [
      ['push', 'push', 'Push and draft PR', 'Secret check, never forced'],
      ['checks', 'checks', 'Wait for CI and reviews', 'Goes on when CI passes, holds no agent'],
      ['update', 'update', 'Update the ticket', 'Move or comment, wherever it came from'],
      ['call', 'call', 'Use a connected tool', 'Do one action in a tool, with no agent'],
      ['command', 'command', 'Run a command', 'Its exit code decides pass or fail'],
      ['report', 'report', 'Report to me', 'What the run found, on your phone']
    ]
  ],
  ['You', [['wait', 'wait', 'Wait for me', 'Continues when you say']]]
]

export type Builder = {
  draft: Definition
  setDraft: (d: Definition) => void
  past: Definition[]
  future: Definition[]
  selected: string | null
  problems: string[]
  setProblems: (p: string[]) => void
  select: (id: string | null) => void
  update: (mut: (d: Definition) => void) => void
  edit: (mut: (d: Definition) => void) => void
  snapshot: () => void
  undo: () => void
  redo: () => void
  reset: (d: Definition) => void
}

const clone = <T,>(x: T): T => structuredClone(x)

export function useBuilder(def: Definition | undefined): Builder | null {
  const [draft, setDraftState] = useState<Definition | null>(def ? clone(def) : null)
  const [past, setPast] = useState<Definition[]>([])
  const [future, setFuture] = useState<Definition[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const latest = useRef(draft)
  latest.current = draft
  const baseline = useRef<string>(def ? JSON.stringify(def) : '')

  // A newer saved version replaces the draft only when nothing is being edited.
  useEffect(() => {
    if (!def) {
      setDraftState(null)
      return
    }
    const editing = latest.current && latest.current.id === def.id && JSON.stringify(latest.current) !== baseline.current
    if (latest.current?.id !== def.id) {
      setPast([])
      setFuture([])
      setSelected(null)
      setProblems([])
    }
    baseline.current = JSON.stringify(def)
    if (!editing) setDraftState(clone(def))
    else setDraftState((d) => (d ? { ...d, enabled: def.enabled } : d))
  }, [def ? JSON.stringify(def) : ''])

  const snapshot = useCallback(() => {
    if (!latest.current) return
    setPast((p) => [...p.slice(-99), clone(latest.current!)])
    setFuture([])
  }, [])
  const update = useCallback((mut: (d: Definition) => void) => {
    setDraftState((d) => {
      if (!d) return d
      const next = clone(d)
      mut(next)
      return next
    })
  }, [])
  if (!draft) return null
  return {
    draft,
    setDraft: setDraftState,
    past,
    future,
    selected,
    problems,
    setProblems,
    select: setSelected,
    update,
    edit: (mut) => {
      snapshot()
      update(mut)
    },
    snapshot,
    undo: () => {
      if (!past.length) return
      setFuture((f) => [...f, clone(draft)])
      const prev = past[past.length - 1]
      setPast((p) => p.slice(0, -1))
      setDraftState(prev)
      if (selected && selected !== '@start' && !selected.startsWith('line:') && !prev.steps.some((s) => s.id === selected)) setSelected(null)
    },
    redo: () => {
      if (!future.length) return
      setPast((p) => [...p, clone(draft)])
      const next = future[future.length - 1]
      setFuture((f) => f.slice(0, -1))
      setDraftState(next)
    },
    reset: (d) => {
      baseline.current = JSON.stringify(d)
      setDraftState(clone(d))
    }
  }
}

// The same rule as the server's slug, so a step's id reads like its name.
function slug(name: string, taken: string[]) {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const base = words.length ? words.join('-') : 'step'
  if (!taken.includes(base)) return base
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`
}

function blank(wanted: string, d: Definition, data: Data): Step {
  const kind = wanted === 'call' && !data.connectors.length && data.mcp_servers.length ? 'tool' : wanted
  const names = d.steps.map((s) => s.name.toLowerCase())
  let name = KINDS[kind]
  for (let n = 2; names.includes(name.toLowerCase()); n++) name = `${KINDS[kind]} ${n}`
  const fields: Record<string, Record<string, unknown>> = {
    agent: { instructions: '', agent: '', machine: { pick: [] }, workspace: { kind: 'new_worktree' }, session: 'new', read_only: false, mcp_servers: [] },
    plan: { machines: [] },
    update: { action: 'move', state: 'In Review' },
    call: { connector: data.connectors[0]?.id || '', call: '', params: {} },
    tool: { server: data.mcp_servers[0] || '', tool: '', arguments: {}, call_kind: 'change', schema_hash: '' },
    command: { command: '', approved: '' },
    wait: { message: '' },
    checks: { require_approval: false }
  }
  return {
    id: slug(name, d.steps.map((s) => s.id)),
    name,
    kind,
    ...(fields[kind] || {}),
    max_runs: kind === 'checks' ? 5 : 2,
    minutes: null,
    next: { pass: 'end', fail: 'wait', needs_you: 'wait' },
    x: 0,
    y: 0
  }
}

// Moves a new card down until it no longer sits on another.
function room(d: Definition, x: number, y: number) {
  let at = { x: Math.round(x / 8) * 8, y: Math.round(y / 8) * 8 }
  while (d.steps.some((s) => Math.abs(s.x - at.x) < NODE_W - 20 && Math.abs(s.y - at.y) < 100)) at = { ...at, y: at.y + GAP_Y }
  return at
}

const stepOf = (d: Definition, id?: string | null) => d.steps.find((s) => s.id === id)

// Steps along the pass line go left to right; a step reached another way sits under the step it
// comes from; anything else goes in a row underneath.
function tidy(d: Definition) {
  const chain: string[] = []
  for (let id: string | undefined = d.start; id && stepOf(d, id) && !chain.includes(id); id = stepOf(d, id)!.next.pass) chain.push(id)
  const placed = new Map(chain.map((id, i) => [id, { x: 40 + i * GAP_X, y: 120 }]))
  const below = new Map<number, number>()
  const queue = [...chain]
  while (queue.length) {
    const id = queue.shift()!
    for (const o of ['pass', 'fail', 'needs_you'] as const) {
      const to = stepOf(d, id)!.next[o]
      if (!to || !stepOf(d, to) || placed.has(to)) continue
      const col = placed.get(id)!.x
      const depth = (below.get(col) || 0) + 1
      below.set(col, depth)
      placed.set(to, { x: col, y: 120 + depth * GAP_Y })
      queue.push(to)
    }
  }
  const deepest = Math.max(0, ...below.values())
  let i = 0
  for (const s of d.steps) {
    const at = placed.get(s.id) || { x: 40 + i++ * GAP_X, y: 120 + (deepest + 1) * GAP_Y }
    s.x = at.x
    s.y = at.y
  }
}

export function BuildTab({ b, data, viewKey, proposal = false, decided = false, onSave }: { b: Builder; data: Data; viewKey: string; proposal?: boolean; decided?: boolean; onSave: () => void }) {
  const [libraryOpen, setLibraryOpen] = useState(() => localStorage.getItem(LIBRARY_KEY) !== '0')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [addMenu, setAddMenu] = useState<null | { cx: number; cy: number; world: { x: number; y: number }; from: string; outcome: string }>(null)
  const canvasBox = useRef<HTMLDivElement>(null)
  const carrying = useRef<null | { kind: string; x0: number; y0: number; moved: boolean; ghost?: HTMLDivElement }>(null)
  const d = b.draft
  const editable = !decided

  const select = (id: string | null) => {
    setAddMenu(null)
    b.select(id)
    if (id) setInspectorOpen(true)
  }

  const createAt = (kind: string, x: number, y: number, from: string | null = null, outcome: string | null = null) => {
    let made = ''
    b.edit((draft) => {
      const step = { ...blank(kind, draft, data), ...room(draft, x, y) }
      draft.steps.push(step)
      if (from === '@start' || !draft.start) draft.start = step.id
      else if (from && outcome) stepOf(draft, from)!.next[outcome as 'pass'] = step.id
      made = step.id
    })
    setAddMenu(null)
    setTimeout(() => select(made), 0)
  }

  const centre = () => {
    const c = canvasBox.current?.querySelector<HTMLElement>('[aria-label="Pipeline builder canvas"]')
    if (!c) return { x: 40, y: 120 }
    const pan = c.firstElementChild as HTMLElement
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(pan.style.transform)
    const [vx, vy, k] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1]
    const inner = { x: (c.clientWidth / 2 - vx) / k, y: (c.clientHeight / 2 - vy) / k }
    const first = d.steps.find((s) => s.id === d.start)
    const minX = Math.min(first ? first.x - 280 : 40, ...d.steps.map((s) => s.x)) - 60
    const minY = Math.min(first ? first.y : 120, ...d.steps.map((s) => s.y)) - 60
    return { x: inner.x + minX, y: inner.y + minY }
  }

  const worldAt = (cx: number, cy: number) => {
    const c = canvasBox.current?.querySelector<HTMLElement>('[aria-label="Pipeline builder canvas"]')
    if (!c) return null
    const r = c.getBoundingClientRect()
    if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) return null
    const c0 = centre()
    return { x: c0.x + (cx - (r.left + r.width / 2)) / zoomOf(c), y: c0.y + (cy - (r.top + r.height / 2)) / zoomOf(c) }
  }

  // From the library by click: after the selected step on its pass line; otherwise in view.
  const addStep = (kind: string) => {
    const after = stepOf(d, b.selected)
    if (after) {
      let made = ''
      b.edit((draft) => {
        const a = stepOf(draft, after.id)!
        const step = { ...blank(kind, draft, data), ...room(draft, a.x + GAP_X, a.y) }
        step.next.pass = a.next.pass
        a.next.pass = step.id
        draft.steps.push(step)
        made = step.id
      })
      setTimeout(() => select(made), 0)
      return
    }
    if (b.selected === '@start' && d.start && stepOf(d, d.start)) {
      let made = ''
      b.edit((draft) => {
        const first = stepOf(draft, draft.start)!
        const step = { ...blank(kind, draft, data), ...room(draft, first.x, first.y + GAP_Y) }
        step.next.pass = draft.start
        draft.start = step.id
        draft.steps.push(step)
        made = step.id
      })
      setTimeout(() => select(made), 0)
      return
    }
    const at = centre()
    createAt(kind, at.x - NODE_W / 2, at.y - 50)
  }

  const removeStep = (id: string) =>
    b.edit((draft) => {
      const gone = stepOf(draft, id)!
      draft.steps = draft.steps.filter((s) => s.id !== id)
      for (const s of draft.steps) for (const o of ['pass', 'fail', 'needs_you'] as const) if (s.next[o] === id) s.next[o] = o === 'pass' ? 'end' : 'wait'
      if (draft.start === id) draft.start = gone.next.pass && stepOf(draft, gone.next.pass) ? gone.next.pass : draft.steps[0]?.id || ''
      setTimeout(() => select(null), 0)
    })

  const cutLine = (from: string, outcome: string) =>
    b.edit((draft) => {
      stepOf(draft, from)!.next[outcome as 'pass'] = outcome === 'pass' ? 'end' : 'wait'
      setTimeout(() => select(from), 0)
    })

  const removeSelected = () => {
    if (b.selected?.startsWith('line:')) {
      const [, from, outcome] = b.selected.split(':')
      cutLine(from, outcome)
    } else if (stepOf(d, b.selected)) removeStep(b.selected!)
  }

  const bRef = useRef(b)
  bRef.current = b
  const keys = useRef({ removeSelected, onSave })
  keys.current = { removeSelected, onSave }
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const bb = bRef.current
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (editable) keys.current.onSave()
        return
      }
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return
      if (!editable) return
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) bb.redo()
        else bb.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        bb.redo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        keys.current.removeSelected()
      } else if (e.key === 'Escape') {
        setAddMenu(null)
        bb.select(null)
      } else if (e.key.startsWith('Arrow') && stepOf(bb.draft, bb.selected)) {
        e.preventDefault()
        const by = e.shiftKey ? 32 : 8
        const [dx, dy] = ({ ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] } as Record<string, number[]>)[e.key]
        bb.edit((draft) => {
          const s = stepOf(draft, bb.selected)!
          s.x += dx
          s.y += dy
        })
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [editable])

  // Dragging an item out of the library: a card follows the pointer and lands where it is let go.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const c = carrying.current
      if (!c) return
      if (!c.moved && Math.hypot(e.clientX - c.x0, e.clientY - c.y0) < 5) return
      if (!c.moved) {
        c.moved = true
        c.ghost = Object.assign(document.createElement('div'), { textContent: KINDS[c.kind] })
        c.ghost.className = 'pointer-events-none fixed top-0 left-0 z-[80] rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium shadow-lg'
        document.body.append(c.ghost)
      }
      c.ghost!.style.transform = `translate(${e.clientX + 8}px, ${e.clientY + 8}px)`
    }
    const up = (e: PointerEvent) => {
      const c = carrying.current
      carrying.current = null
      if (!c) return
      c.ghost?.remove()
      if (!c.moved) return
      const at = worldAt(e.clientX, e.clientY)
      if (at) createAt(c.kind, at.x - NODE_W / 2, at.y - 50)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  })

  const fold = () => {
    setLibraryOpen((o) => {
      localStorage.setItem(LIBRARY_KEY, o ? '0' : '1')
      return !o
    })
  }

  const step = stepOf(d, b.selected)
  const mine = step ? b.problems.filter((p) => p.startsWith(`${step.name}: `) || p === `${step.name} is never reached`) : []
  const stepUpdate = (mut: (s: Step) => void) =>
    b.update((draft) => {
      const s = stepOf(draft, step!.id)
      if (s) mut(s)
    })

  let body: React.ReactNode = null
  if (step) {
    body = (
      <>
        {mine.length > 0 && (
          <ul role="alert" className="mx-4 mt-3 grid gap-1 rounded-md border border-destructive/40 bg-destructive/8 p-2.5 text-xs text-destructive">
            {mine.map((p) => (
              <li key={p}>{p.startsWith(`${step.name}: `) ? p.slice(step.name.length + 2) : p}</li>
            ))}
          </ul>
        )}
        <StepForm step={step} draft={d} data={data} update={stepUpdate} proposal={proposal} />
      </>
    )
  } else if (b.selected?.startsWith('line:')) {
    const [, from, outcome] = b.selected.split(':')
    const src = stepOf(d, from)
    body = src ? (
      <div className="grid gap-3 p-4 text-[13px]">
        <p>
          <b className="font-semibold">{src.name}</b> on {WORDS[outcome].replace('passed', 'pass').replace('failed', 'fail')} goes to <b className="font-semibold">{stepOf(d, src.next[outcome as 'pass'])?.name || src.next[outcome as 'pass']}</b>.
        </p>
        <p className="text-xs text-muted-foreground">Drag from the port to another step to change it, or remove the line: the run then {outcome === 'pass' ? 'ends' : 'waits for you'} there.</p>
        <Button size="sm" variant="ghost-destructive" className="w-fit" onClick={() => cutLine(from, outcome)}>
          Remove line
        </Button>
      </div>
    ) : null
  } else if (b.selected === '@start') {
    body = (
      <>
        <TriggerForm d={d} data={data} update={b.update} />
        <TokenLimitForm d={d} data={data} update={b.update} />
      </>
    )
  } else {
    const first = stepOf(d, d.start)
    const row = 'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-accent'
    body = (
      <>
        <section className="grid gap-1 border-b border-border/60 px-2 py-3">
          <p className="px-2 pb-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">Summary</p>
          <button type="button" onClick={() => select('@start')} className={row}>
            <span className="w-20 shrink-0 text-muted-foreground">Starts</span>
            <span className="min-w-0 flex-1 truncate">{triggerWords(d.trigger)}</span>
            <ChevronRight className="size-3.5 text-muted-foreground" />
          </button>
          {first && (
            <button type="button" onClick={() => select(first.id)} className={row}>
              <span className="w-20 shrink-0 text-muted-foreground">First step</span>
              <span className="min-w-0 flex-1 truncate">{first.name}</span>
              <ChevronRight className="size-3.5 text-muted-foreground" />
            </button>
          )}
          <div className={cn(row, 'hover:bg-transparent')}>
            <span className="w-20 shrink-0 text-muted-foreground">Steps</span>
            <span>{d.steps.length}</span>
          </div>
          <p className="px-2 pt-1 text-xs text-muted-foreground">Click a step to edit it, or the Start when card for the trigger. Drag a step in from the library, or click one to add it.</p>
        </section>
        <TokenLimitForm d={d} data={data} update={b.update} />
      </>
    )
  }

  const panelTitle = step ? (
    <>
      <KindIcon kind={step.kind} className="size-3.5" /> {KINDS[step.kind]}
    </>
  ) : b.selected === '@start' ? (
    <>
      <KindIcon kind="start" className="size-3.5" /> Start when
    </>
  ) : b.selected?.startsWith('line:') ? (
    'Line'
  ) : (
    'Pipeline'
  )

  return (
    <div className="flex min-h-0 flex-1">
      {libraryOpen ? (
        <aside aria-label="Steps you can add" className="scrollbar-sleek flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar max-md:hidden">
          <div className="flex h-10 shrink-0 items-center justify-between px-3">
            <span className="text-xs font-semibold text-muted-foreground">Steps</span>
            <Button size="icon-xs" variant="ghost" aria-label="Hide the steps" title="Hide the steps" onClick={fold} className="text-muted-foreground">
              <ChevronLeft className="size-3.5" />
            </Button>
          </div>
          {LIBRARY.map(([group, items]) => (
            <section key={group} className="grid gap-0.5 px-2 pb-3">
              <h3 className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">{group}</h3>
              {items.map(([kind, iconKind, name, hint]) => (
                <button
                  key={kind}
                  type="button"
                  disabled={!editable}
                  onPointerDown={group === 'Start when' ? undefined : (e) => e.button === 0 && (carrying.current = { kind, x0: e.clientX, y0: e.clientY, moved: false })}
                  onClick={() => {
                    if (group === 'Start when') {
                      b.update((draft) => (draft.trigger = newTrigger(kind, data)))
                      select('@start')
                    } else addStep(kind)
                  }}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
                >
                  <span className={cn('grid size-7 shrink-0 place-items-center rounded-md', group === 'Start when' ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-muted-foreground')}>
                    <KindIcon kind={iconKind} className="size-3.5" />
                  </span>
                  <span className="grid min-w-0">
                    <b className="truncate text-[13px] font-medium">{name}</b>
                    <small className="truncate text-[11px] text-muted-foreground">{hint}</small>
                  </span>
                </button>
              ))}
            </section>
          ))}
        </aside>
      ) : (
        <aside className="flex w-10 shrink-0 justify-center border-r border-border bg-sidebar pt-2 max-md:hidden">
          <Button size="icon-xs" variant="ghost" aria-label="Show the steps" title="Show the steps" onClick={fold} className="text-muted-foreground">
            <ChevronRight className="size-3.5" />
          </Button>
        </aside>
      )}
      <div ref={canvasBox} className="relative flex min-h-0 min-w-0 flex-1">
        <PipelineCanvas
          def={d}
          editable={editable}
          selected={b.selected}
          problems={b.problems}
          viewKey={viewKey}
          className="flex-1"
          on={{
            select,
            begin: b.snapshot,
            move: (id, x, y) =>
              b.update((draft) => {
                const s = stepOf(draft, id)
                if (s && (s.x !== x || s.y !== y)) {
                  s.x = x
                  s.y = y
                }
              }),
            connect: (from, outcome, to) =>
              b.edit((draft) => {
                if (from === '@start') draft.start = to
                else stepOf(draft, from)!.next[outcome as 'pass'] = to
              }),
            drop: (world, from, outcome, cx, cy) => setAddMenu({ cx, cy, world, from, outcome })
          }}
        >
          {b.problems.length > 0 && (
            <div data-own-drag role="alert" className="absolute top-3 left-1/2 z-10 grid max-w-[min(560px,90%)] -translate-x-1/2 gap-1 rounded-lg border border-destructive/40 bg-card p-3 text-xs shadow-lg">
              <p className="font-semibold text-destructive">Not saved. Fix these first:</p>
              <ul className="list-disc pl-4 text-destructive">
                {b.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {!d.steps.length && (
            <p className="pointer-events-none absolute top-1/2 left-1/2 -translate-1/2 rounded-lg border border-dashed border-border bg-card px-3.5 py-2.5 text-[13px] text-muted-foreground">Drag a step here, or click one in the library.</p>
          )}
          {editable && (
            <div data-own-drag className="absolute top-3 left-3 z-10 flex gap-1 rounded-[10px] border border-border bg-card p-[3px] shadow-xs">
              <Button size="icon-sm" variant="ghost" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!b.past.length} onClick={b.undo}>
                <Undo2 className="size-4" />
              </Button>
              <Button size="icon-sm" variant="ghost" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!b.future.length} onClick={b.redo}>
                <Redo2 className="size-4" />
              </Button>
              <Button size="sm" variant="ghost" title="Line the steps up" disabled={!d.steps.length} onClick={() => b.edit(tidy)}>
                Tidy
              </Button>
            </div>
          )}
          {!inspectorOpen && (
            <Button data-own-drag size="icon-sm" variant="outline" title="Show the panel" aria-label="Show the panel" onClick={() => setInspectorOpen(true)} className="absolute top-3 right-3 z-10">
              <ChevronLeft className="size-4" />
            </Button>
          )}
        </PipelineCanvas>
        {addMenu && (
          <div role="menu" className="fixed z-[70] grid w-60 gap-0.5 rounded-[12px] border border-black/7 bg-popover p-1.5 text-popover-foreground shadow-lg dark:border-white/9" style={{ left: Math.min(addMenu.cx, innerWidth - 248), top: Math.min(addMenu.cy, innerHeight - 380) }}>
            <div className="flex items-center justify-between px-2 py-1">
              <p className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">Add a step on this line</p>
              <button type="button" aria-label="Close" onClick={() => setAddMenu(null)} className="text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            </div>
            {LIBRARY.filter(([g]) => g !== 'Start when')
              .flatMap(([, items]) => items)
              .map(([kind, iconKind, name]) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  onClick={() => createAt(kind, addMenu.world.x - NODE_W / 2, addMenu.world.y - 50, addMenu.from, addMenu.outcome)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                >
                  <KindIcon kind={iconKind} className="size-3.5 text-muted-foreground" /> {name}
                </button>
              ))}
          </div>
        )}
      </div>
      {inspectorOpen && (
        <aside aria-label="Selected step" className="flex w-[22rem] shrink-0 flex-col border-l border-border bg-background max-lg:w-80">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/60 px-4">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold">{panelTitle}</span>
            <Button size="icon-xs" variant="ghost" title="Hide the panel" aria-label="Hide the panel" onClick={() => setInspectorOpen(false)} className="text-muted-foreground">
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">{body}</div>
          {step && editable && (
            <div className="flex shrink-0 justify-end border-t border-border/60 px-4 py-2">
              <Button size="sm" variant="ghost-destructive" onClick={() => removeStep(step.id)}>
                <Trash2 /> Delete step
              </Button>
            </div>
          )}
        </aside>
      )}
    </div>
  )
}

function zoomOf(c: HTMLElement) {
  const pan = c.firstElementChild as HTMLElement
  const m = /scale\(([-\d.]+)\)/.exec(pan.style.transform)
  return m ? Number(m[1]) : 1
}

