import { stopSession } from '@/lib/actions'
import { askChoice } from '@/lib/confirm'
import type { Session, YardbellState } from '@/lib/state'
import { agentName, keyOf } from '@/lib/tree'
import { closeItem, findItem, type Layouts } from './layout'

// Closing a running session asks whether it keeps running behind the closed tab or stops.
export async function askCloseSession(s: Session, state: YardbellState | null): Promise<'keep' | 'stop' | null> {
  const name = agentName(s, state?.agents || [])
  const folder = String(s.path || s.cwd || s.folder || '').split('/').filter(Boolean).pop() || s.machine
  const picked = await askChoice({
    title: `Close ${name}?`,
    body: `It runs in ${folder} on ${s.machine}. Keep it running and reopen it from the sidebar later, or stop the agent and its terminal. The worktree and branch stay either way.`,
    choices: [
      { value: 'keep', label: 'Keep it running', primary: true },
      { value: 'stop', label: 'Stop session', danger: true }
    ]
  })
  return picked === 'keep' || picked === 'stop' ? picked : null
}

export function closeSessionTab(l: Layouts, key: string): Layouts {
  const found = findItem(l, (i) => i.key === key)
  if (found) return closeItem(l, found.item.id)
  return l.hidden.includes(key) ? l : { ...l, hidden: [...l.hidden, key] }
}

// The whole flow, for a tab's close button and for the sidebar alike. True when something closed.
export async function closeSession(s: Session, state: YardbellState | null, update: (fn: (l: Layouts) => Layouts) => void): Promise<boolean> {
  if (s.stale) {
    update((l) => closeSessionTab(l, keyOf(s)))
    return true
  }
  const choice = await askCloseSession(s, state)
  if (!choice) return false
  if (choice === 'stop') await stopSession(s)
  update((l) => closeSessionTab(l, keyOf(s)))
  return true
}
