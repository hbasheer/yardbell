import type { StateView } from '../../state/types'
import type { SavedPrompt } from '../types'

export const MENU_LIMIT = 40

export type MenuKind = 'names' | 'tasks'
export type Trigger = { kind: MenuKind; query: string; from: number; to: number }
export type ItemKind = 'machine' | 'session' | 'folder' | 'task'
export type MenuItem = { group: string; kind: ItemKind; label: string; detail: string; token: string; rank: number }

const TRIGGER = /(?:^|\s)(?:\/([^\s/]*)|@([^\s@]*))$/

export function findTrigger(text: string, cursor: number): Trigger | null {
  const before = text.slice(0, cursor)
  const match = TRIGGER.exec(before)
  if (!match) return null
  const raw = match[1] ?? match[2] ?? ''
  return { kind: match[1] !== undefined ? 'tasks' : 'names', query: raw.toLowerCase(), from: cursor - raw.length - 1, to: cursor }
}

export function rank(query: string, label: string, ...more: unknown[]): number | null {
  const name = label.toLowerCase()
  if (!query || name.startsWith(query)) return 0
  if (name.split(/[\s/._-]+/).some((word) => word.startsWith(query))) return 1
  if (name.includes(query)) return 2
  return more.some((field) => String(field ?? '').toLowerCase().includes(query)) ? 3 : null
}

const home = (path: string) => path.replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~')

const repeated = (list: string[]) => new Set(list.filter((name, at) => list.indexOf(name) !== at))

export function nameItems(state: Pick<StateView, 'machines' | 'sessions' | 'folders'>, query: string): MenuItem[] {
  const sessions = state.sessions.filter((session) => session.tmux && !session.stale)
  const folders = state.folders ?? []
  const sameSession = repeated(sessions.map((session) => String(session.tmux)))
  const sameFolder = repeated(folders.map((folder) => folder.label))
  const items: (MenuItem | null)[] = [
    ...state.machines.map((machine) => {
      const at = rank(query, machine.name)
      return at === null ? null : { group: 'Machines', kind: 'machine' as const, label: machine.name, detail: machine.up ? 'up' : 'down', token: machine.name, rank: at }
    }),
    ...sessions.map((session) => {
      const tmux = String(session.tmux)
      const at = rank(query, tmux, session.machine, session.folder, session.branch)
      if (at === null) return null
      return {
        group: 'Sessions',
        kind: 'session' as const,
        label: tmux,
        detail: [`${session.agent} on ${session.machine}`, home(session.folder || ''), session.branch].filter(Boolean).join(' · '),
        token: sameSession.has(tmux) ? `${tmux} on ${session.machine}` : tmux,
        rank: at
      }
    }),
    ...folders.map((folder) => {
      const outside = folder.label.startsWith('/')
      const label = outside ? folder.label.split('/').filter(Boolean).pop() || folder.label : folder.label
      const at = rank(query, label, folder.machine, folder.path)
      if (at === null) return null
      return {
        group: 'Folders',
        kind: 'folder' as const,
        label,
        detail: [`on ${folder.machine}`, folder.branch, outside && home(folder.path)].filter(Boolean).join(' · '),
        token: sameFolder.has(folder.label) ? `${folder.label} on ${folder.machine}` : folder.label,
        rank: at
      }
    })
  ]
  return (items.filter((item): item is MenuItem => item !== null)).sort((a, b) => a.rank - b.rank).slice(0, MENU_LIMIT)
}

export function taskItems(prompts: SavedPrompt[], query: string): MenuItem[] {
  const items: (MenuItem | null)[] = prompts
    .filter((prompt) => !prompt.hidden)
    .map((prompt) => {
      const at = rank(query, prompt.name, prompt.text)
      return at === null ? null : { group: 'Saved prompts', kind: 'task' as const, label: prompt.name, detail: prompt.text, token: prompt.text, rank: at }
    })
  return items.filter((item): item is MenuItem => item !== null).sort((a, b) => a.rank - b.rank).slice(0, MENU_LIMIT)
}

export function applyToken(text: string, trigger: Trigger, token: string): { text: string; cursor: number } {
  const after = text.slice(trigger.to)
  const gap = /^\s/.test(after) ? '' : ' '
  return { text: `${text.slice(0, trigger.from)}${token}${gap}${after}`, cursor: trigger.from + token.length + 1 }
}

export function pickedTask(text: string, picked: SavedPrompt[]): { name: string; version: number } | undefined {
  const found = picked.find((prompt) => text.includes(prompt.text))
  return found ? { name: found.name, version: found.version } : undefined
}
