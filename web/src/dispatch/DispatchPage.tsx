/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Activity, AlarmClock, AlertCircle, ArrowUp, ChevronRight, ExternalLink, FileText, MessageSquare, MessagesSquare, PanelRight, Plus, Search, Settings2, SquareTerminal, Trash2, Workflow, X, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { confirmAction } from '@/lib/confirm'
import { Markdown } from '@/lib/markdown'
import type { YardbellState } from '@/lib/state'
import { Composer, type Attached, type ComposerHandle } from './Composer'
import { loadLegacy, type Legacy } from './legacy'
import { openInsights } from '@/insights/Insights'
import {
  ago,
  api,
  blocks,
  CLAUDE_MODELS,
  folderOf,
  LABELS,
  optionLabel,
  readable,
  serverTime,
  short,
  target,
  termUrl,
  type Block,
  type Chip,
  type Convo,
  type Conversation,
  type Event,
  type RunsOn,
  type Task,
  type Tracked,
  type Trigger
} from './model'

const SCREEN_TAIL = 4
const SESSION_STATES: Record<string, { tone: string; word: string; hint: string }> = {
  blocked: { tone: 'warn', word: 'Waiting for you', hint: 'The session is asking something. Pick an answer below or open it.' },
  idle: { tone: '', word: 'Stopped', hint: 'Finished, or waiting for the next step.' },
  ended: { tone: '', word: 'Ended', hint: 'The session is gone.' }
}

const conversationOfUrl = () => new URLSearchParams(location.search).get('c')

// Renders one of the old pages' cards with its own code.
function Lit({ legacy, tpl }: { legacy: Legacy; tpl: unknown }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) legacy.lit.render(tpl, ref.current)
  })
  return <div ref={ref} className="yb-legacy" />
}

function sessionWord(t: Tracked, state: YardbellState | null) {
  const s = state?.sessions.find((x) => x.machine === t.machine && x.tmux === t.name && !x.stale)
  const word = !s ? 'ended' : s.activity === 'blocked' ? 'needs you' : s.activity === 'active' ? 'working' : (s as any).stopped ? 'stopped on an error' : 'idle'
  return { s, word }
}

export function DispatchPage({ onOpenSession }: { onOpenSession: (machine: string, name: string) => void }) {
  const [loaded, setLoaded] = useState<Legacy | null>(null)
  const [legacy, setLegacy] = useState<Legacy | null>(null)
  const [loadError, setLoadError] = useState('')
  const [conversations, setConversations] = useState<Convo[]>([])
  const [pipelined, setPipelined] = useState<Set<string>>(new Set())
  const [tasks, setTasks] = useState<Task[]>([])
  const [runsOn, setRunsOn] = useState<RunsOn | null>(null)
  const [current, setCurrentState] = useState<string | null>(conversationOfUrl)
  const [busy, setBusyState] = useState(false)
  const [, setVersion] = useState(0)
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [triggerInfo, setTriggerInfo] = useState<{ triggers: { trigger: { name: string; enabled: boolean } }[] } | null>(null)
  const [tracked, setTracked] = useState<Tracked[]>([])
  const [backend, setBackend] = useState('claude')
  const [tab, setTab] = useState<'chats' | 'tasks'>('chats')
  const [side, setSide] = useState(() => localStorage.getItem('yardbell.dispatch.side') !== 'hidden')
  const [sideQuery, setSideQuery] = useState('')
  const sideMatch = (x: string) => !sideQuery.trim() || x.toLowerCase().includes(sideQuery.trim().toLowerCase())
  const showSide = (on: boolean) => {
    setSide(on)
    try {
      if (on) localStorage.removeItem('yardbell.dispatch.side')
      else localStorage.setItem('yardbell.dispatch.side', 'hidden')
    } catch {}
  }
  const [taskForm, setTaskForm] = useState<{ editing: string | null; name: string; text: string } | null>(null)
  const [state, setState] = useState<YardbellState | null>(null)

  const events = useRef<Event[]>([])
  const shown = useRef({ count: 0, updated: '' })
  const currentRef = useRef(current)
  const busyRef = useRef(false)
  const view = useRef(0)
  const answers = useRef(new Map<string, { key: string | null }>())
  const screens = useRef(new Set<string>())
  const stateRef = useRef<YardbellState | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  const tasksRef = useRef<Task[]>([])
  tasksRef.current = tasks

  const draw = useCallback(() => setVersion((v) => v + 1), [])
  const setCurrent = (id: string | null) => {
    currentRef.current = id
    setCurrentState(id)
    history.replaceState(null, '', id ? `${location.pathname}?c=${encodeURIComponent(id)}` : location.pathname)
  }
  const setBusy = (on: boolean) => {
    busyRef.current = on
    setBusyState(on)
    if (on) requestAnimationFrame(scrollDown)
  }
  const scrollDown = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight })

  const loadState = useCallback(async () => {
    const s = await api<YardbellState>('GET', '/state').catch(() => stateRef.current)
    stateRef.current = s
    setState(s)
    return s
  }, [])
  const loadList = useCallback(async () => {
    const [list, runs] = await Promise.all([
      api<Convo[]>('GET', '/dispatch/conversations'),
      api<{ runs: { conversation?: string }[] }>('GET', '/api/runs').catch(() => ({ runs: [] }))
    ])
    setConversations(list)
    setPipelined(new Set(runs.runs.map((r) => r.conversation).filter(Boolean) as string[]))
  }, [])
  const loadTasks = useCallback(async () => setTasks(await api<Task[]>('GET', '/dispatch/tasks').catch(() => [])), [])
  const loadRunsOn = useCallback(async () => {
    const r = await api<RunsOn>('GET', '/dispatch/runs-on').catch(() => null)
    if (!r) return
    setRunsOn(r)
    if (!currentRef.current) setBackend(r.runs_on || 'claude')
  }, [])


  const show = (e: Event) => {
    events.current.push(e)
    shown.current.count = Math.max(shown.current.count, events.current.length)
    draw()
    requestAnimationFrame(scrollDown)
  }

  // Session cards and review results arrive between turns, and a step decided on another device changes in place.
  const catchUp = useCallback(
    async (showNew = true) => {
      const id = currentRef.current
      if (!id || busyRef.current) return
      const convo = await api<Conversation>('GET', `/dispatch/conversations/${encodeURIComponent(id)}`).catch(() => null)
      if (!convo || currentRef.current !== id || busyRef.current) return
      const grew = convo.events.length > shown.current.count
      if (convo.updated !== shown.current.updated || grew) {
        events.current = convo.events.slice()
        draw()
        if (showNew && grew) requestAnimationFrame(scrollDown)
      }
      shown.current = { count: convo.events.length, updated: convo.updated }
      setTracked(convo.sessions || [])
    },
    [legacy]
  )

  const watch = async (id: string) => {
    while (currentRef.current === id && busyRef.current) {
      await new Promise((r) => setTimeout(r, 2000))
      const convo = await api<Conversation>('GET', `/dispatch/conversations/${encodeURIComponent(id)}`).catch(() => null)
      if (!convo || currentRef.current !== id) return
      if (!convo.busy) {
        await loadList()
        open(id)
        return
      }
      if (convo.updated !== shown.current.updated) {
        const grew = convo.events.length > shown.current.count
        events.current = convo.events.slice()
        shown.current = { count: convo.events.length, updated: convo.updated }
        draw()
        if (grew) requestAnimationFrame(scrollDown)
      }
    }
  }

  const open = async (id: string | null) => {
    setCurrent(id)
    view.current++
    events.current = []
    setTrigger(null)
    setBackend(runsOn?.runs_on || 'claude')
    loadRunsOn()
    answers.current = new Map()
    screens.current.clear()
    legacy?.steps.reset()
    legacy?.groups.reset()
    setBusy(false)
    setTracked([])
    shown.current = { count: 0, updated: '' }
    draw()
    if (!id) {
      composer.current?.focus()
      return
    }
    try {
      const convo = await api<Conversation>('GET', `/dispatch/conversations/${encodeURIComponent(id)}?opened=1`)
      if (currentRef.current !== id) return
      events.current = convo.events.slice()
      shown.current = { count: convo.events.length, updated: convo.updated }
      setBackend(convo.backend || 'claude')
      setTrigger(convo.trigger || null)
      if (convo.trigger) api('GET', '/api/triggers').then(setTriggerInfo, () => {})
      setTracked(convo.sessions || [])
      setBusy(convo.busy)
      draw()
      requestAnimationFrame(scrollDown)
      if (convo.busy) watch(id)
    } catch (e) {
      toast.error((e as Error).message)
      setCurrent(null)
      events.current = []
      draw()
    }
  }

  // Each conversation runs on its own on the server, so a reply streams only into the chat that
  // sent it; switching away leaves it running there, and the chat list shows it working.
  const ask = async (text: string, marks: Record<string, unknown> = {}, files: Attached[] = []) => {
    const mine = view.current
    const here = () => view.current === mine
    setBusy(true)
    loadRunsOn()
    const sent: Event = { role: 'user', text, ...marks }
    if (files.length) sent.attachments = files.map(({ file, kind, url }) => ({ name: file.name, kind, size: file.size, url }))
    show(sent)
    let answering = false
    try {
      const attachments = await Promise.all(files.map(async ({ file }) => ({ name: file.name, data: await legacy!.attach.toBase64(file) })))
      const res = await fetch('/dispatch/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation: currentRef.current, text, ...marks, ...(files.length ? { attachments } : {}) })
      })
      if (res.status === 401) {
        location.href = '/login'
        return
      }
      if (!res.ok) {
        const out = await res.json().catch(() => ({}))
        throw new Error(out.error || `Request failed (${res.status})`)
      }
      answering = true
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.role === 'conversation') {
            if (here()) setCurrent(event.id)
            loadList().catch(() => {})
          } else if (here()) show(event)
        }
      }
    } catch (e) {
      if (!here()) toast.error((e as Error).message)
      else {
        if (!answering) {
          events.current = events.current.filter((x) => x !== sent)
          composer.current?.restore(text, files)
        }
        show({ role: 'error', text: (e as Error).message })
      }
    } finally {
      loadList().catch(() => {})
      ;(window as any).YardbellUsage?.load?.()
      if (here()) {
        setBusy(false)
        catchUp(false)
      }
    }
  }

  const pick = async (index: number, key: string, label: string) => {
    const local = `${view.current}:${index}`
    answers.current.set(local, { key: null })
    draw()
    try {
      events.current[index] = await api('POST', `/dispatch/conversations/${encodeURIComponent(currentRef.current!)}/answers`, { card: index, key })
      toast(`Answered "${label}"`)
    } catch (e) {
      toast.error((e as Error).message)
      if (/already/.test((e as Error).message)) catchUp()
    }
    answers.current.delete(local)
    draw()
  }

  const requestReview = async (index: number) => {
    try {
      const step = await api('POST', `/dispatch/conversations/${encodeURIComponent(currentRef.current!)}/reviews`, { card: index })
      show(step)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // A scan from a session card goes into this conversation; one picked in the message box goes into
  // the open conversation, or a new one named after the folder.
  const requestScan = async (body: Record<string, unknown>) => {
    try {
      const { conversation, step } = await api('POST', '/dispatch/scans', { conversation: currentRef.current, ...body })
      if (conversation !== currentRef.current) {
        await loadList()
        await open(conversation)
        return
      }
      show(step)
    } catch (e) {
      if (body.card !== undefined) toast.error((e as Error).message)
      else throw e
    }
  }

  const insights = (machine: string, name: string, here: boolean) =>
    openInsights({ machine, name, onSuggest: (data: any) => suggest(data, here) })

  const suggest = async (data: any, here = false) => {
    if (busyRef.current) return toast('Dispatch is still working on the last message. Stop it or wait, then try again.')
    if (!here && currentRef.current) await open(null)
    const task = data.from ? { name: data.from.name, version: data.from.version } : undefined
    ask(data.suggest, { improve: { machine: data.machine, name: data.name, ...(task ? { task } : {}) } })
  }

  // The old cards are handed what they need from this page once.
  useEffect(() => {
    let gone = false
    loadLegacy().then(
      (l) => {
        if (gone) return
        setLoaded(l)
      },
      (e) => setLoadError(e.message)
    )
    return () => {
      gone = true
    }
  }, [])

  useEffect(() => {
    if (!loaded) return
    const ctx = {
      api,
      toast: (m: string, kind = 'error') => (kind === 'ok' ? toast(m) : toast.error(m)),
      draw,
      termUrl,
      short,
      folderOf,
      conversation: () => currentRef.current,
      events: () => events.current,
      state: () => stateRef.current,
      loadState,
      reload: () => catchUp(false),
      decided: () => {
        loadList().catch(() => {})
        loadTasks()
      },
      addStep(step: Event) {
        const i = events.current.findIndex((e) => e.role === 'action' && e.id === step.id)
        if (i >= 0) events.current[i] = step
        else events.current.push(step)
        shown.current.count = Math.max(shown.current.count, events.current.length)
        requestAnimationFrame(scrollDown)
      },
      replaceStep(step: Event) {
        const i = events.current.findIndex((e) => e.role === 'action' && e.id === step.id)
        if (i >= 0) events.current[i] = step
      },
      replaceAt(index: number, event: Event) {
        events.current[index] = event
      }
    }
    loaded.steps.setup(ctx)
    loaded.pulls.setup(ctx)
    loaded.groups.setup(ctx)
    setLegacy(loaded)
    draw()
  }, [loaded, catchUp])

  useEffect(() => {
    loadRunsOn()
    loadTasks()
    loadState()
    const asked = new URLSearchParams(location.search).get('ask')
    // Insights on another page hands its suggestion over here.
    let handedOver: any = null
    try {
      handedOver = JSON.parse(sessionStorage.getItem('yardbell.dispatch.suggest') || 'null')
      sessionStorage.removeItem('yardbell.dispatch.suggest')
    } catch {}
    loadList()
      .then(() => open(asked === null && !handedOver ? conversationOfUrl() : null))
      .then(() => {
        if (asked) composer.current?.fill(asked)
        if (handedOver) suggest(handedOver)
      })
      .catch((e) => toast.error(e.message))
    const tick = setInterval(() => {
      catchUp(true)
      loadState()
      if (!busyRef.current) {
        loadList().catch(() => {})
        loadRunsOn()
      }
    }, 5000)
    const back = () => {
      const id = conversationOfUrl()
      if (id !== currentRef.current && !busyRef.current) open(id)
    }
    window.addEventListener('popstate', back)
    return () => {
      clearInterval(tick)
      window.removeEventListener('popstate', back)
    }
  }, [])

  useLayoutEffect(() => {
    legacy?.steps.afterDraw()
  })

  // Links in the cards open their page inside the app, and a session in the Workspace.
  const follow = (e: React.MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
    const url = new URL(link.href, location.href)
    if (url.origin !== location.origin) return
    e.preventDefault()
    const [first, machine, name] = url.pathname.split('/').slice(1).map(decodeURIComponent)
    if (first === 'term' && machine && name) return onOpenSession(machine, name)
    if (first === 'dispatch') {
      const id = url.searchParams.get('c')
      if (!busyRef.current) open(id)
      return
    }
    if (first === 'settings') {
      history.pushState(null, '', `/ui/settings${url.hash}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
      return
    }
    window.postMessage({ yardbell: 'go', href: url.href }, location.origin)
  }
  const openSettings = (hash: string) => {
    history.pushState(null, '', `/ui/settings#${hash}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  const saveRunsOn = async (change: Record<string, string>) => {
    try {
      const settings = await api('GET', '/api/settings')
      const d = settings.dispatch || {}
      await api('POST', '/api/settings/dispatch', {
        instructions: d.instructions || '',
        agent: d.agent || '',
        runs_on: d.runs_on || 'claude',
        model: d.model || '',
        codex_model: d.codex_model || '',
        ...(d.approval ? { approval: d.approval } : {}),
        rules: d.rules || [],
        ...change
      })
      await loadRunsOn()
      if (change.approval) return void toast(({ prompt: 'Dispatch asks before each step', allow: 'Dispatch goes ahead without asking', deny: 'Dispatch refuses each step unless a rule allows it' } as Record<string, string>)[change.approval])
      toast(
        change.runs_on
          ? `New conversations start on ${change.runs_on === 'codex' ? 'Codex' : 'Claude Code'}`
          : `Dispatch now uses ${CLAUDE_MODELS[change.model || ''] || change.model || change.codex_model || 'the default model'}`
      )
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const deleteConvo = async (c: Convo) => {
    if (!(await confirmAction({ title: 'Delete this conversation?', body: c.title, confirm: 'Delete', danger: true }))) return
    try {
      await api('POST', `/dispatch/conversations/${encodeURIComponent(c.id)}/delete`, {})
      await loadList()
      if (c.id === currentRef.current) open(null)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const clearAll = async () => {
    if (
      !(await confirmAction({
        title: 'Delete every conversation?',
        body: 'Conversations that are still working are kept. Sessions they started keep running.',
        confirm: 'Delete all',
        danger: true
      }))
    )
      return
    try {
      const { kept } = await api('POST', '/dispatch/clear', {})
      const list = await api<Convo[]>('GET', '/dispatch/conversations')
      setConversations(list)
      if (!list.some((c) => c.id === currentRef.current)) open(null)
      if (kept) toast(`${kept} conversation${kept === 1 ? ' is' : 's are'} still working and ${kept === 1 ? 'was' : 'were'} kept.`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const runTask = (task: Task) => {
    if (busyRef.current) return toast('Dispatch is still working on the last message.')
    ask(task.text, { task: { name: task.name, version: task.version } })
  }
  const editTask = (task: Task | null, text = '') => {
    setTab('tasks')
    setTaskForm({ editing: task?.name || null, name: task?.name || '', text: text || task?.text || '' })
  }
  const saveTask = async () => {
    if (!taskForm) return
    try {
      setTasks(await api('POST', '/dispatch/tasks', { name: taskForm.name, text: taskForm.text, replacing: taskForm.editing }))
      toast(`Saved "${taskForm.name.trim()}"`)
      setTaskForm(null)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const forgetTask = async (task: Task) => {
    const note = task.builtin ? 'It is a default prompt, so Restore default prompts brings it back.' : 'Conversations it started are kept.'
    if (!(await confirmAction({ title: `Delete the saved prompt "${task.name}"?`, body: note, confirm: 'Delete', danger: true }))) return
    try {
      setTasks(await api('POST', '/dispatch/tasks/delete', { name: task.name }))
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const saveVersion = async (task: Task, text: string) => {
    try {
      const list = await api<Task[]>('POST', '/dispatch/tasks', { name: task.name, text, replacing: task.name })
      setTasks(list)
      const saved = list.find((t) => t.name === task.name)
      toast(saved && saved.version !== task.version ? `Saved as version ${saved.version} of "${task.name}"` : `"${task.name}" already has this text`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const shownTasks = tasks.filter((t) => !t.hidden)
  const openConvo = conversations.find((c) => c.id === current)
  const agentLabel = (name: string) => runsOn?.agents?.[name]?.label || (name === 'codex' ? 'Codex' : 'Claude Code')
  const agentModel = (name: string) => {
    const m = runsOn?.agents?.[name]?.model || ''
    return CLAUDE_MODELS[m] || m || 'default model'
  }
  const runsOnText = (name: string) => `${agentLabel(name)} (${agentModel(name)})`
  const list = legacy ? blocks(events.current, legacy.steps) : []

  const chip = (c: Chip, i: number) => {
    const tone = c.result ? (c.result.is_error ? 'bad' : 'ok') : busy ? 'running' : ''
    return (
      <details key={i} className="group/chip rounded-md border border-border/70 bg-muted/30 text-xs open:w-full">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-muted-foreground">
          <span
            className={cn(
              'size-1.5 rounded-full',
              tone === 'ok'
                ? 'bg-status-success'
                : tone === 'bad'
                  ? 'bg-destructive'
                  : tone === 'running'
                    ? 'animate-pulse bg-foreground/60'
                    : 'bg-muted-foreground/40'
            )}
          />
          {LABELS[c.name] || c.name}
          {target(c.input)}
        </summary>
        {c.result && (
          <pre className="max-h-64 overflow-auto border-t border-border/60 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">{c.result.text}</pre>
        )}
      </details>
    )
  }

  const sessionCard = (e: Event, index: number) => {
    const st = e.answer
      ? { tone: '', word: 'Answered', hint: 'You answered its question here.' }
      : SESSION_STATES[e.state] || { tone: '', word: e.state, hint: '' }
    const answer = e.answer || answers.current.get(`${view.current}:${index}`)
    const reviewable = (e.state === 'idle' || e.state === 'ended') && !e.review
    const key = `${view.current}:${index}`
    const lines = e.screen ? readable(e.screen).split('\n') : []
    const opened = screens.current.has(key)
    const long = lines.length > SCREEN_TAIL
    return (
      <div className={cn('overflow-hidden rounded-xl border bg-card', !e.answer && e.state === 'blocked' ? 'border-status-warning/50' : 'border-border')}>
        <header className="flex items-start gap-3 px-4 pt-3.5">
          <span className={cn('grid size-[30px] shrink-0 place-items-center rounded-lg', !e.answer && e.state === 'blocked' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'bg-muted text-muted-foreground')}>
            <SquareTerminal className="size-4" />
          </span>
          <div className="grid min-w-0 flex-1 gap-0.5">
            <strong className="truncate text-[13.5px] font-semibold">{e.name}</strong>
            <span className="truncate text-xs text-muted-foreground" title={e.path ? short(e.path) : undefined}>
              on {e.machine}
              {e.path && (
                <>
                  {' · '}
                  <code className="font-mono">{folderOf(e.path)}</code>
                </>
              )}
            </span>
          </div>
          <span
            title={st.hint}
            className={cn(
              'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium',
              st.tone === 'warn' ? 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-border bg-muted/60 text-muted-foreground'
            )}
          >
            {st.word}
          </span>
        </header>
        {e.screen && (
          <div className="mt-2.5 mr-4 ml-[58px]">
            {long && (
              <button
                type="button"
                aria-expanded={opened}
                onClick={() => {
                  if (opened) screens.current.delete(key)
                  else screens.current.add(key)
                  draw()
                }}
                className="mb-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {opened ? 'Show the end only' : `Show all ${lines.length} lines`}
              </button>
            )}
            <pre className="max-h-80 overflow-auto rounded-lg bg-muted/50 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {(long && !opened ? lines.slice(-SCREEN_TAIL) : lines).join('\n')}
            </pre>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 px-4 py-3">
          {(e.options || []).map((o: { key: string; label: string }) => {
            const label = optionLabel(o.label)
            return (
              <Button
                key={o.key}
                size="sm"
                variant={o.key === '1' ? 'default' : 'outline'}
                title={label}
                disabled={Boolean(answer)}
                onClick={() => pick(index, o.key, label)}
                className={cn('max-w-64', answer?.key === o.key && 'ring-2 ring-ring/50')}
              >
                <span className="truncate">{label}</span>
              </Button>
            )
          })}
          {reviewable && (
            <Button
              size="sm"
              variant="outline"
              title="Start a reviewer in the same folder that runs the tests and changes nothing"
              onClick={() => requestReview(index)}
            >
              Review branch
            </Button>
          )}
          {reviewable && e.path && legacy && (
            <Button
              size="sm"
              variant="outline"
              aria-haspopup="menu"
              title="Start a scanner in the same folder that reads all of its code and changes nothing"
              onClick={(ev) => legacy.scans.toggleMenu(ev.currentTarget, (kind: string) => requestScan({ card: index, kind }))}
            >
              Scan <ChevronRight className="size-3 rotate-90" />
            </Button>
          )}
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" title="When it worked, waited and idled, and the tools and tests it ran" onClick={() => insights(e.machine, e.name, true)}>
              <Activity /> Insights
            </Button>
            {e.state !== 'ended' && (
              <Button size="sm" variant="outline" onClick={() => onOpenSession(e.machine, e.name)}>
                <SquareTerminal /> Open
              </Button>
            )}
          </span>
          {e.answer && (
            <span className="text-xs text-muted-foreground">
              You answered {optionLabel(e.answer.label)}
              {e.answer.at ? ` at ${new Date(e.answer.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
          )}
        </div>
      </div>
    )
  }

  const sentFiles = (files: { name: string; kind: string; url?: string; file?: string; size?: number }[]) => (
    <div className="mt-1.5 flex flex-wrap justify-end gap-2">
      {files.map((a, i) => {
        const href = a.url || `/dispatch/conversations/${encodeURIComponent(current || '')}/attachments/${encodeURIComponent(a.file || '')}`
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={a.name}
            className="flex h-14 max-w-48 items-center gap-2 overflow-hidden rounded-lg border border-border bg-background pr-2 text-xs"
          >
            {a.kind === 'image' ? (
              <img src={href} alt="" loading="lazy" className="h-full w-14 object-cover" />
            ) : (
              <FileText className="ml-2 size-4 text-muted-foreground" />
            )}
            <span className="truncate">{a.name}</span>
          </a>
        )
      })}
    </div>
  )

  const promptActions = (b: Block) => {
    if (!legacy) return null
    const asked = events.current
      .slice(0, b.key)
      .reverse()
      .find((e) => e.role === 'user')
    if (!asked?.improve) return null
    const text = legacy.tasks.proposedPrompt((b as any).event.text)
    if (!text) return null
    const from = asked.improve.task && tasks.find((t) => t.name === asked.improve.task.name && !t.hidden)
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => editTask(null, text)}>
          Save as a new saved prompt
        </Button>
        {from && (
          <Button size="sm" onClick={() => saveVersion(from, text)}>
            Save as version {from.version + 1} of {from.name}
          </Button>
        )}
      </div>
    )
  }

  const block = (b: Block) => {
    if (b.kind === 'tools') return <div className="flex flex-wrap gap-1.5">{(b as any).chips.map(chip)}</div>
    const e = (b as any).event as Event
    if (!legacy) return null
    switch (b.kind) {
      case 'action':
        return <Lit legacy={legacy} tpl={legacy.steps.stepCard(e)} />
      case 'review':
        return <Lit legacy={legacy} tpl={legacy.steps.reviewCard(e, b.key)} />
      case 'pull':
        return <Lit legacy={legacy} tpl={legacy.pulls.pullCard(e, b.key)} />
      case 'group':
        return <Lit legacy={legacy} tpl={legacy.groups.groupCard(e)} />
      case 'results':
        return <Lit legacy={legacy} tpl={legacy.groups.resultsCard(e, b.key)} />
      case 'session':
        return sessionCard(e, b.key)
      case 'user': {
        const by =
          e.by === 'yardbell'
            ? 'Sent by Yardbell once the results were in'
            : e.improve
              ? `Suggest a better prompt for ${e.improve.name} on ${e.improve.machine}`
              : e.task
                ? `Saved prompt ${e.task.name} · version ${e.task.version}`
                : ''
        return (
          <div className="flex flex-col items-end">
            {by && <span className="mb-1 text-[11px] text-muted-foreground">{by}</span>}
            {e.improve ? (
              <details className="max-w-[85%] rounded-2xl bg-muted px-4 py-2 text-sm">
                <summary className="cursor-pointer text-muted-foreground">What Dispatch was asked</summary>
                <p className="mt-1 whitespace-pre-wrap">{e.text}</p>
              </details>
            ) : (
              e.text && <p className="max-w-[85%] rounded-2xl bg-muted px-4 py-2 text-sm whitespace-pre-wrap">{e.text}</p>
            )}
            {e.attachments?.length > 0 && sentFiles(e.attachments)}
          </div>
        )
      }
      case 'assistant':
        return (
          <div className="text-sm leading-relaxed">
            <Markdown text={e.text} />
            {promptActions(b)}
          </div>
        )
      case 'error':
        return (
          <p role="alert" className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">{e.text}</span>
          </p>
        )
      default:
        return null
    }
  }

  const triggerHead = () => {
    if (!trigger) return null
    const known = triggerInfo?.triggers.find((v) => v.trigger.name === trigger.name)
    const on = known?.trigger.enabled
    const late = trigger.slot && trigger.at && Date.parse(trigger.at) - Date.parse(trigger.slot) >= 120000
    const flip = async () => {
      try {
        setTriggerInfo(await api('POST', '/api/triggers/enable', { name: trigger.name, enabled: !on }))
        toast(!on ? `The trigger ${trigger.name} is on.` : `The trigger ${trigger.name} is off. It starts nothing until you turn it on here or in Settings.`)
      } catch (e) {
        toast.error((e as Error).message)
      }
    }
    return (
      <div className={cn('flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3', known && !on && 'opacity-70')}>
        <AlarmClock className="size-4 shrink-0 text-muted-foreground" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <strong className="text-[13px] font-semibold">Started by the trigger {trigger.name}</strong>
          <span className="text-xs text-muted-foreground">
            {trigger.task ? `Saved prompt ${trigger.task}${trigger.version ? `, version ${trigger.version}` : ''} · ` : ''}
            {trigger.what} · {serverTime(trigger.at)}
            {late ? `, late for ${serverTime(trigger.slot).split(', ')[1]}` : ''}
            {known && !on ? ' · The trigger is off' : ''}
            {triggerInfo && !known ? ' · The trigger was deleted' : ''}
          </span>
        </div>
        <div className="flex gap-1.5">
          {trigger.url && (
            <Button size="sm" variant="ghost" asChild>
              <a href={trigger.url} target="_blank" rel="noopener noreferrer">
                Open ticket
              </a>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => openSettings('triggers')}>
            Triggers
          </Button>
          {known && (
            <Button size="sm" variant="outline" onClick={flip}>
              {on ? 'Turn off' : 'Turn on'}
            </Button>
          )}
        </div>
      </div>
    )
  }

  const switchTo = (id: string) => id !== currentRef.current && open(id)
  const newChat = () => open(null)

  const starters = shownTasks.slice(0, 6)
  const intro = (
    <div className="mx-auto grid w-full max-w-2xl gap-6 pt-[9vh]">
      <div className="grid justify-items-center gap-2 text-center">
        <span className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
          <MessageSquare className="size-5" />
        </span>
        <h2 className="text-xl font-semibold">What should your agents work on?</h2>
        <p className="max-w-lg text-sm text-muted-foreground">
          Describe a task in plain words. Dispatch finds the machine with the repository and the most room, and proposes each step for you to approve.
        </p>
      </div>
      {starters.length > 0 && (
        <div className="grid gap-2">
          <p className="text-xs font-medium text-muted-foreground">Start from a saved prompt. It goes in the box below for you to change before sending.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {starters.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => composer.current?.fill(t.text)}
                title={t.text}
                className="group/start grid gap-0.5 rounded-xl border border-border/60 bg-card px-3.5 py-2.5 text-left transition-colors hover:border-border hover:bg-accent/40"
              >
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  <Zap className="size-3.5 text-muted-foreground" />
                  {t.name}
                  <ArrowUp className="ml-auto size-3.5 rotate-180 text-muted-foreground opacity-0 transition-opacity group-hover/start:opacity-100" />
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{t.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="text-center text-[11.5px] text-muted-foreground">
        Runs {runsOnText(backend)} with Yardbell's own tools; it starts, reads and answers sessions, never edits files itself. Type{' '}
        <kbd className="rounded border border-border px-1 font-sans">/</kbd> for a saved prompt, <kbd className="rounded border border-border px-1 font-sans">@</kbd> to name a machine, session or folder.
      </p>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 bg-background">

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          {trigger && <AlarmClock className="size-4 text-muted-foreground" />}
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{openConvo?.title || (current ? 'Conversation' : 'New conversation')}</h1>
          <Button size="sm" variant="ghost" className="md:hidden" onClick={newChat}>
            <Plus /> New
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openSettings('dispatch')}>
            <Settings2 /> Settings
          </Button>
          {!side && (
            <Hint label="Show chats and saved prompts">
              <Button size="icon-sm" variant="ghost" aria-label="Show the right sidebar" className="max-md:hidden" onClick={() => showSide(true)}>
                <PanelRight className="size-4" />
              </Button>
            </Hint>
          )}
        </header>
        {tracked.length > 0 && !side && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-4 py-1.5 text-xs">
            <span className="font-medium text-muted-foreground">Sessions</span>
            {tracked.map((t) => {
              const { s, word } = sessionWord(t, state)
              const tone = !s
                ? 'bg-muted-foreground/40'
                : s.activity === 'blocked'
                  ? 'bg-status-warning'
                  : s.activity === 'active'
                    ? 'bg-status-success'
                    : (s as any).stopped
                      ? 'bg-destructive'
                      : 'bg-muted-foreground/60'
              return (
                <span key={`${t.machine}/${t.name}`} className="inline-flex items-center gap-1.5">
                  <span className={cn('size-1.5 rounded-full', tone)} />
                  {s ? (
                    <button type="button" onClick={() => onOpenSession(t.machine, t.name)} className="font-medium hover:underline">
                      {t.name}
                    </button>
                  ) : (
                    <span className="font-medium">{t.name}</span>
                  )}
                  <span className="text-muted-foreground">
                    {t.machine} · {word}
                  </span>
                </span>
              )
            })}
          </div>
        )}
        <div ref={scroller} onClick={follow} className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto" aria-live="polite">
          <div className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-6">
            {loadError && <p className="text-sm text-destructive">The cards could not load: {loadError}</p>}
            {!current && !events.current.length ? (
              intro
            ) : (
              <>
                {triggerHead()}
                {current && runsOn && backend !== runsOn.runs_on && (
                  <p role="note" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    This conversation runs on {runsOnText(backend)}, so it carries on there. New conversations start on {runsOnText(runsOn.runs_on)}. To switch,
                    start a new conversation.
                  </p>
                )}
                {list.map((b) => (
                  <div key={`${view.current}:${b.key}`}>{block(b)}</div>
                ))}
                {legacy && <Lit legacy={legacy} tpl={legacy.steps.waitingBar(events.current)} />}
              </>
            )}
            {busy && (
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${i * 150}ms` }} />
                  ))}
                </span>
                Working
              </p>
            )}
          </div>
        </div>
        <Composer
          ref={composer}
          conversation={current}
          busy={busy}
          backend={backend}
          runsOn={runsOn}
          tasks={shownTasks}
          sent={events.current.filter((e) => e.role === 'user' && e.text).map((e) => e.text)}
          legacy={legacy}
          state={loadState}
          onSend={(text, files) => {
            if (busyRef.current) {
              toast('Dispatch is still working on the last message. Stop it or wait, then send.')
              return false
            }
            ask(text, {}, files)
            return true
          }}
          onStop={() =>
            currentRef.current && api('POST', `/dispatch/conversations/${encodeURIComponent(currentRef.current)}/stop`, {}).catch((e) => toast.error(e.message))
          }
          onSaveTask={(text) => editTask(null, text)}
          onScan={async () => {
            const s = stateRef.current || (await loadState())
            legacy?.scans.openDialog({ state: s, submit: (body: Record<string, unknown>) => requestScan(body) })
          }}
          onRunsOn={saveRunsOn}
          onOpenSettings={openSettings}
        />
      </main>
      {side && (
      <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-card max-md:hidden">
        <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-tab-bar pl-1">
          <div role="tablist" aria-label="Dispatch lists" className="flex min-w-0 flex-1 items-stretch gap-0.5">
            {(
              [
                ['chats', 'Chats', MessagesSquare, conversations.filter((c) => c.waiting).length],
                ['tasks', 'Saved prompts', Zap, 0]
              ] as const
            ).map(([id, label, Icon, n]) => (
              <Hint key={id} label={label}>
                <button
                  type="button"
                  role="tab"
                  aria-label={label}
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={cn('relative grid w-8 place-items-center text-muted-foreground hover:text-foreground', tab === id && 'text-foreground')}
                >
                  <Icon size={15} />
                  {n > 0 && (
                    <span className="absolute top-0.5 right-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status-warning px-1 text-3xs leading-none font-semibold text-background tabular-nums">{n}</span>
                  )}
                  {tab === id && <span className="absolute right-[25%] bottom-0 left-[25%] h-[2px] rounded-t bg-activity-bar-indicator" />}
                </button>
              </Hint>
            ))}
          </div>
          <Hint label="Hide the right sidebar">
            <button
              type="button"
              aria-label="Hide the right sidebar"
              onClick={() => showSide(false)}
              className="mx-1 my-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <PanelRight className="size-4" />
            </button>
          </Hint>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 px-2 pt-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={sideQuery}
              onChange={(e) => setSideQuery(e.target.value)}
              placeholder={tab === 'chats' ? 'Search chats' : 'Search saved prompts'}
              aria-label={tab === 'chats' ? 'Search chats' : 'Search saved prompts'}
              className="h-7 w-full rounded-md border border-input bg-muted/55 pr-2 pl-7 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <Button size="xs" variant="outline" className="h-7" onClick={() => (tab === 'chats' ? newChat() : editTask(null))}>
            <Plus /> {tab === 'chats' ? 'New chat' : 'New prompt'}
          </Button>
        </div>
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-2">
          {tab === 'chats' ? (
            <>
              {!conversations.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">No conversations yet.</p>}
              {conversations.filter((c) => sideMatch(c.title)).map((c) => (
                <div key={c.id} className={cn('group relative rounded-md', c.id === current ? 'bg-accent' : 'hover:bg-accent/50')}>
                  <button
                    type="button"
                    aria-current={c.id === current ? 'true' : undefined}
                    onClick={() => switchTo(c.id)}
                    className="grid w-full min-w-0 gap-0.5 px-2.5 py-2 pr-8 text-left"
                  >
                    <span className="truncate text-[13px] font-medium">{c.title}</span>
                    <span className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                      {pipelined.has(c.id) && <Workflow className="size-3" aria-label="A pipeline run" />}
                      {c.trigger && <AlarmClock className="size-3" aria-label={`Started by the trigger ${c.trigger}`} />}
                      {c.busy ? (
                        <>
                          <span className="size-1.5 animate-pulse rounded-full bg-status-success" /> working
                        </>
                      ) : c.waiting ? (
                        <>
                          <span className="size-1.5 rounded-full bg-status-warning" /> {c.waiting} waiting for you
                        </>
                      ) : (
                        ago(c.updated)
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${c.title}`}
                    onClick={() => deleteConvo(c)}
                    className="absolute top-2 right-1.5 hidden size-6 place-items-center rounded-md text-muted-foreground group-hover:grid hover:bg-background hover:text-destructive focus-visible:grid"
                  >
                    <X className="size-3.5" />
                  </button>
                  {c.id === current && tracked.length > 0 && (
                    <div className="ml-3 flex flex-col gap-0.5 border-l border-border pb-1.5 pl-2">
                      {tracked.map((t) => {
                        const { s, word } = sessionWord(t, state)
                        const tone = !s
                          ? 'bg-muted-foreground/40'
                          : s.activity === 'blocked'
                            ? 'bg-status-warning'
                            : s.activity === 'active'
                              ? 'bg-status-success'
                              : (s as any).stopped
                                ? 'bg-destructive'
                                : 'bg-muted-foreground/60'
                        return (
                          <button
                            key={`${t.machine}/${t.name}`}
                            type="button"
                            disabled={!s}
                            onClick={() => onOpenSession(t.machine, t.name)}
                            title={`${t.name} on ${t.machine}: ${word}`}
                            className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground enabled:hover:bg-background enabled:hover:text-foreground"
                          >
                            <span className={cn('size-1.5 shrink-0 rounded-full', tone)} />
                            <span className="truncate font-medium">{t.name}</span>
                            <span className="ml-auto shrink-0">{word}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </>
          ) : (
            <>
              {taskForm && (
                <div className="mb-2 grid gap-2 rounded-lg border border-border p-2.5">
                  <label className="grid gap-1 text-xs font-medium">
                    Name
                    <input
                      autoFocus
                      maxLength={60}
                      value={taskForm.name}
                      onChange={(e) => setTaskForm({ ...taskForm, name: e.target.value })}
                      className="h-8 rounded-md border border-input bg-background px-2 text-[13px] font-normal outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-medium">
                    What to ask Dispatch
                    <textarea
                      rows={4}
                      value={taskForm.text}
                      onChange={(e) => setTaskForm({ ...taskForm, text: e.target.value })}
                      className="resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[13px] font-normal outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    />
                  </label>
                  {taskForm.editing &&
                    (() => {
                      const t = tasks.find((x) => x.name === taskForm.editing)
                      if (!t) return null
                      return (
                        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          Version {t.version}
                          {t.builtin ? (t.customised ? ', changed from the default' : ', the default') : ''}
                          <button
                            type="button"
                            className="underline underline-offset-2 hover:text-foreground"
                            onClick={() =>
                              legacy?.tasks.openHistory({
                                name: t.name,
                                customised: t.customised,
                                api,
                                toast: (m: string) => toast(m),
                                changed: (list: Task[]) => {
                                  setTasks(list)
                                  const now = list.find((x) => x.name === t.name)
                                  if (now) setTaskForm({ editing: now.name, name: now.name, text: now.text })
                                }
                              })
                            }
                          >
                            History
                          </button>
                        </p>
                      )
                    })()}
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setTaskForm(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" disabled={!taskForm.name.trim() || !taskForm.text.trim()} onClick={saveTask}>
                      Save prompt
                    </Button>
                  </div>
                </div>
              )}
              {!shownTasks.length && !taskForm && <p className="px-2 py-6 text-center text-xs text-muted-foreground">No saved prompts yet.</p>}
              {shownTasks.filter((t) => sideMatch(`${t.name} ${t.text}`)).map((t) => (
                <div key={t.name} className="group relative rounded-md hover:bg-accent/50">
                  <button type="button" title={t.text} onClick={() => runTask(t)} className="grid w-full min-w-0 gap-0.5 px-2.5 py-2 pr-14 text-left">
                    <span className="truncate text-[13px] font-medium">{t.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground">{t.text}</span>
                  </button>
                  <span className="absolute top-2 right-1.5 hidden gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      aria-label={`Edit ${t.name}`}
                      onClick={() => editTask(t)}
                      className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <Settings2 className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => forgetTask(t)}
                      className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-destructive"
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="flex h-10 shrink-0 items-center border-t border-border/60 px-3 text-xs">
          {tab === 'chats'
            ? conversations.length > 0 && (
                <button type="button" onClick={clearAll} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-3.5" /> Clear all
                </button>
              )
            : tasks.some((t) => t.hidden) && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      setTasks(await api('POST', '/dispatch/tasks/restore', {}))
                    } catch (e) {
                      toast.error((e as Error).message)
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  Restore default prompts
                </button>
              )}
        </div>
      </aside>
      )}
    </div>
  )
}
