import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { areaClass, inputClass } from '@/settings/ui'
import { api, enc, gb, short, type DashState, type Mach, type Sess, type Setup } from './model'

const SHOWN = 12
const code = 'rounded bg-muted px-1 py-px font-mono text-[12px]'

function List({ items }: { items: string[] }) {
  return (
    <ul className="max-h-40 overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-[12px]">
      {items.slice(0, SHOWN).map((i) => (
        <li key={i} className="truncate">
          {i}
        </li>
      ))}
      {items.length > SHOWN && <li className="text-muted-foreground">and {items.length - SHOWN} more</li>}
    </ul>
  )
}

export function setupNote(run?: Setup) {
  if (!run) return ''
  return run.ok ? `Setup ran: ${run.command}` : `Setup failed: ${run.command}`
}

export function SetupDialog({ run, onClose }: { run: Setup | null; onClose: () => void }) {
  if (!run) return null
  const title = run.ok ? 'Setup finished' : run.timed_out ? 'Setup timed out' : 'Setup failed'
  const what = run.ok
    ? `It finished in ${run.seconds} s.`
    : run.timed_out
      ? `It was stopped after ${run.seconds} s, its timeout. The agent started anyway and was told.`
      : `It ${run.exit == null ? 'could not run' : `ended with exit code ${run.exit}`}. The agent started anyway and was told.`
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          <code className={code}>{run.command}</code> in <code className={code}>{short(run.path)}</code>. {what}
        </DialogDescription>
        <pre className="max-h-[50vh] overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-[12px] whitespace-pre-wrap">{run.output || 'No output.'}</pre>
        {run.log && (
          <p className="text-xs text-muted-foreground">
            Full output: <code className={code}>{run.log}</code>
          </p>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Worktree = { linked: boolean; path: string; main: string; branch: string; dirty: string[]; unpushed: string[]; merged_into?: string }
type Inspect = { worktree: Worktree; sessions?: string[] }

// What removing would lose is shown before anything is removed; the server refuses the same
// things on its own, so a stale dialog cannot remove more than it showed.
export function RemoveWorktreeDialog({ target, onClose }: { target: { machine: string; path: string } | null; onClose: () => void }) {
  const [info, setInfo] = useState<Inspect | null>(null)
  const [error, setError] = useState('')
  const [fatal, setFatal] = useState('')
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setInfo(null)
    setError('')
    setFatal('')
    setDeleteBranch(false)
    if (!target) return
    let gone = false
    api<Inspect>('POST', `/worktrees/${enc(target.machine)}/inspect`, { path: target.path }).then(
      (d) => !gone && setInfo(d),
      (e) => !gone && setFatal(e.message)
    )
    return () => {
      gone = true
    }
  }, [target])

  if (!target) return null
  const w = info?.worktree
  const risky = Boolean(w && (w.dirty.length || w.unpushed.length))

  const remove = async () => {
    if (!w) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/worktrees/${enc(target.machine)}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ path: w.path, force: risky, delete_branch: deleteBranch })
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast(data.removed?.note || 'Removed the worktree')
        onClose()
        return
      }
      if (data.worktree) setInfo({ ...info!, worktree: data.worktree })
      setError(data.error || `Request failed (${res.status})`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  let body: React.ReactNode
  let actions: React.ReactNode = <Button onClick={onClose}>Close</Button>
  let title = 'Remove this worktree?'
  if (fatal) {
    title = 'Cannot remove this worktree'
    body = (
      <p role="alert" className="text-sm text-destructive">
        {fatal}
      </p>
    )
  } else if (!w) {
    body = (
      <DialogDescription>
        Checking <code className={code}>{short(target.path)}</code> on {target.machine}…
      </DialogDescription>
    )
    actions = (
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
    )
  } else if (!w.linked) {
    title = 'Not a worktree'
    body = (
      <DialogDescription>
        <code className={code}>{short(w.path)}</code> is the repository's main checkout. Yardbell only removes worktrees.
      </DialogDescription>
    )
  } else if (info?.sessions?.length) {
    title = 'A session still runs there'
    body = (
      <DialogDescription>
        {info.sessions.join(', ')} runs in <code className={code}>{short(w.path)}</code> on {target.machine}. Stop it first, then remove the worktree.
      </DialogDescription>
    )
  } else {
    body = (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Removes <code className={code}>{short(w.path)}</code> on {target.machine} with <code className={code}>git worktree remove</code> and prunes. The main checkout{' '}
          <code className={code}>{short(w.main)}</code> is not touched.
        </p>
        {w.dirty.length > 0 && (
          <>
            <p className="font-medium text-amber-700 dark:text-amber-400">
              {w.dirty.length} uncommitted {w.dirty.length === 1 ? 'change' : 'changes'} would be lost:
            </p>
            <List items={w.dirty} />
          </>
        )}
        {w.unpushed.length > 0 && (
          <>
            <p className="font-medium text-amber-700 dark:text-amber-400">
              {w.unpushed.length} {w.unpushed.length === 1 ? 'commit' : 'commits'} on <code className={code}>{w.branch}</code> that no remote or other branch has:
            </p>
            <List items={w.unpushed} />
          </>
        )}
        {w.branch &&
          (w.merged_into ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
              <span>
                Also delete branch <code className={code}>{w.branch}</code>, merged into <code className={code}>{w.merged_into}</code>
              </span>
            </label>
          ) : (
            <p className="text-xs text-muted-foreground">
              Branch <code className={code}>{w.branch}</code> is kept{w.unpushed.length ? ', so its commits stay unless you delete it yourself' : ''}.
            </p>
          ))}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    )
    actions = (
      <>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button variant={risky ? 'destructive' : 'default'} disabled={busy} onClick={remove}>
          {busy ? 'Removing…' : risky ? 'Remove and lose these' : 'Remove worktree'}
        </Button>
      </>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        {body}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function room(m: Mach) {
  const h = m.health
  if (!h) return 0
  const free = Math.max(0, h.mem_total_kb - h.mem_used_kb)
  return h.limit_kb ? Math.min(free, Math.max(0, h.limit_kb - h.limit_used_kb)) : free
}

type Moved = { machine: string; name: string; path: string; changes_moved?: boolean; setup?: Setup; from?: { stopped?: boolean } }

export function MoveDialog({
  session,
  state,
  onClose,
  onOpen,
  onLeave
}: {
  session: Sess | null
  state: DashState | null
  onClose: () => void
  onOpen: (machine: string, name: string) => void
  onLeave: (id: string) => void
}) {
  const [to, setTo] = useState('')
  const [task, setTask] = useState('')
  const [stop, setStop] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [moved, setMoved] = useState<Moved | null>(null)

  useEffect(() => {
    setTo('')
    setTask('')
    setStop(false)
    setError('')
    setMoved(null)
    if (!session?.tmux) return
    let gone = false
    api('GET', `/sessions/${enc(session.machine)}/${enc(session.tmux)}/task`)
      .then((d) => !gone && setTask((t) => t || d.task || ''))
      .catch(() => {})
    return () => {
      gone = true
    }
  }, [session])

  if (!session) return null
  const s = session
  const others = (state?.machines || []).filter((m) => m.up && m.name !== s.machine).sort((a, b) => room(b) - room(a))
  const has = (m: Mach) => (state?.folders || []).some((f) => f.machine === m.name && f.label === s.folder)

  const move = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await api<Moved>('POST', `/sessions/${enc(s.machine)}/${enc(s.tmux!)}/move`, { to, task, stop_original: stop })
      setMoved(res)
      if (res.from?.stopped) onLeave(s.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stopOriginal = async () => {
    setBusy(true)
    try {
      await api('POST', `/sessions/${enc(s.machine)}/${enc(s.tmux!)}/stop`)
      toast(`Stopped ${s.tmux} on ${s.machine}`)
      onLeave(s.id)
      onClose()
    } catch (e) {
      toast.error((e as Error).message || 'Could not stop it')
    } finally {
      setBusy(false)
    }
  }

  let content: React.ReactNode
  if (!others.length) {
    content = (
      <>
        <DialogTitle>Nowhere to move it</DialogTitle>
        <DialogDescription>No other machine is connected right now.</DialogDescription>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </>
    )
  } else if (moved) {
    const stopped = moved.from?.stopped
    content = (
      <>
        <DialogTitle>Moved to {moved.machine}</DialogTitle>
        <DialogDescription>
          {moved.name} runs in <code className={code}>{short(moved.path)}</code> on {moved.machine}
          {moved.changes_moved ? ', with the uncommitted changes' : ''}. {stopped ? `${s.tmux} on ${s.machine} was stopped.` : `${s.tmux} still runs on ${s.machine}.`}
        </DialogDescription>
        {moved.setup && !moved.setup.ok && <p className="text-sm text-amber-700 dark:text-amber-400">{setupNote(moved.setup)}. The agent was told.</p>}
        <DialogFooter>
          {!stopped && (
            <Button variant="ghost-destructive" disabled={busy} onClick={stopOriginal}>
              Stop the original
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
          <Button
            autoFocus
            onClick={() => {
              onClose()
              onOpen(moved.machine, moved.name)
            }}
          >
            Open
          </Button>
        </DialogFooter>
      </>
    )
  } else {
    content = (
      <>
        <DialogTitle>Move {s.tmux} to another machine</DialogTitle>
        <DialogDescription>
          The branch <code className={code}>{s.branch}</code> and its uncommitted changes go over ssh into a worktree there. Nothing is committed or pushed. The same agent starts there with this
          task and a note that it continued from {s.machine}.
        </DialogDescription>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Move to
          <select autoFocus value={to} onChange={(e) => setTo(e.target.value)} className={inputClass}>
            <option value="">The machine with the most room</option>
            {others.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} · {gb(room(m))} GB free{m.health ? ` · load ${Number(m.health.load1).toFixed(1)}` : ''}
                {has(m) ? '' : ' · folder not listed'}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
          Task
          <textarea rows={4} value={task} onChange={(e) => setTask(e.target.value)} placeholder="What the agent should do there" className={areaClass} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={stop} onChange={(e) => setStop(e.target.checked)} />
          Stop the original once the new one runs
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={move}>
            {busy ? 'Moving…' : 'Move session'}
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>{content}</DialogContent>
    </Dialog>
  )
}
