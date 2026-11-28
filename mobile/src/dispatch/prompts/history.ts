import type { PromptDiff, PromptHistory, PromptVersion } from '../types'

export const HISTORY_HELP =
  'Every save keeps the text before it. Restoring a version saves it again as the newest, so nothing is lost. Triggers always run the current version.'

export const historyHref = (serverId: string, name: string) =>
  `/dispatch/${encodeURIComponent(serverId)}/history?name=${encodeURIComponent(name)}`

export function whenWord(stamp: string | undefined, now = new Date()): string {
  if (!stamp) return 'Comes with Yardbell'
  const at = new Date(stamp)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    year: at.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function versionNote(version: PromptVersion, builtin: boolean): string {
  if (!version.restored) return ''
  return version.restored === 1 && builtin ? 'The default again' : `Restored from version ${version.restored}`
}

export const versionLabel = (n: number, current: number) => `Version ${n}${n === current ? ' (current)' : ''}`

export function defaultCompare(history: PromptHistory): { from: number; to: number } {
  const numbers = history.versions.map((v) => v.n).sort((a, b) => a - b)
  return { from: numbers.length > 1 ? numbers[numbers.length - 2] : history.current, to: history.current }
}

export const newestFirst = (history: PromptHistory): PromptVersion[] => [...history.versions].sort((a, b) => b.n - a.n)

export const countLine = (count: number) => (count === 1 ? 'One version so far.' : `${count} versions kept.`)

export const sameVersions = (parts: PromptDiff['parts']) => !parts.some((part) => part.op !== 'same')

export const restoreConfirm = (name: string, version: number, builtin: boolean) =>
  version === 1 && builtin
    ? { title: `Reset "${name}" to the default?`, message: 'The default text is saved again as the newest version. Earlier versions stay in the history.', confirm: 'Reset to the default' }
    : { title: `Restore version ${version} of "${name}"?`, message: 'It is saved again as the newest version, so nothing is lost. Triggers will run it from now on.', confirm: 'Restore' }

export const restoredMessage = (name: string, version: number, builtin: boolean, current: number) =>
  version === 1 && builtin ? `Reset "${name}" to the default` : `Restored version ${version} of "${name}" as version ${current}`
