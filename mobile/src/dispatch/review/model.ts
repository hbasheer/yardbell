import { fileHref } from '../../files/model'
import { pullRef } from '../cards/model'
import type { Finding, ReviewChanges, ReviewEvent, ReviewFileStat, ReviewShot, ReviewStanding } from '../types'

export type Place = { path: string; line: number | null }

export function placeOf(place: string): Place | null {
  const m = String(place)
    .trim()
    .match(/^(.+?)(?::(\d+)(?:[-:,]\d+)*)?$/)
  if (!m) return null
  return { path: m[1].replace(/^\.\//, ''), line: m[2] ? Number(m[2]) : null }
}

export const safePath = (path: string) =>
  Boolean(path) && !path.startsWith('/') && !/[\u0000-\u001f]/.test(path) && path.split('/').every((p) => p && p !== '.' && p !== '..')

export const reviewRoot = (e: ReviewEvent) => e.of?.path || e.path || ''

export function placeLink(e: ReviewEvent, serverId: string, finding: Finding): string | null {
  const at = finding.place ? placeOf(finding.place) : null
  const root = reviewRoot(e)
  if (!at || !root || !safePath(at.path)) return null
  return fileHref({ serverId, machine: e.machine, root, path: at.path, line: at.line ?? undefined })
}

export function scanFileCount(findings: Finding[] | undefined): number {
  const seen = new Set<string>()
  for (const f of findings ?? []) {
    const at = f.place ? placeOf(f.place) : null
    if (at && safePath(at.path)) seen.add(at.path)
  }
  return seen.size
}

const CHANGE: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged' }

export const changeWord = (file: Pick<ReviewFileStat, 'status' | 'untracked'>) => (file.untracked ? 'New, not committed' : (CHANGE[file.status] ?? file.status))

export const changeLetter = (file: Pick<ReviewFileStat, 'status' | 'untracked'>) => (file.untracked ? '?' : file.status)

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const fileWord = (n: number) => plural(n, 'file', 'files')

export const findingWord = (n: number) => plural(n, 'finding', 'findings')

export function changeTotals(files: ReviewFileStat[]) {
  return {
    files: files.length,
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    removed: files.reduce((n, f) => n + (f.removed ?? 0), 0)
  }
}

export function diffNote(list: Pick<ReviewChanges, 'base' | 'merge_base' | 'head'>): string {
  const base = list.base
  let first: string
  if (!base) first = 'Yardbell found no base branch, so these are the changes not yet committed.'
  else if (list.merge_base === list.head) first = `No commits beyond ${base}, so these are the changes not yet committed.`
  else first = `Against ${base} from ${list.merge_base.slice(0, 7)}, with changes not yet committed.`
  return `${first} Read from the folder as it is now.`
}

export const MOVED_WORDS = 'The branch has new commits since this review.'

export type StandingLine = { text: string; warn: boolean }

const DURING: Record<string, string> = {
  moved: 'The branch moved while this review ran, so it may have read either commit.',
  uncommitted: 'Files changed while this review ran, so it may not have read them all as they are here.'
}

export type StandingNow = { standing: ReviewStanding; head?: string; error?: string } | { failed: string } | null

export function standingLines(e: ReviewEvent, now: StandingNow): StandingLine[] {
  const read = e.of?.pin
  if (!read) return []
  if (read.error) return [{ text: `Yardbell could not read which commit this review started on: ${read.error}`, warn: false }]
  const head = read.head ?? ''
  let text = `Read ${head.slice(0, 7)}${read.changes ? ' with uncommitted changes' : ''}.`
  const during = e.read_changed ? DURING[e.read_changed] : undefined
  if (during) text += ` ${during}`
  let warn = false
  if (now && 'failed' in now) text += ` Yardbell could not check the branch now: ${now.failed}`
  else if (now?.standing === 'unknown') text += ` Yardbell could not check the branch now: ${now.error ?? 'it did not say why'}`
  else if (now?.standing === 'same') text += ' Nothing has changed since.'
  else if (now?.standing === 'moved') {
    warn = true
    text += ` The branch has moved on since this review: it is now at ${(now.head ?? '').slice(0, 7)}, so this verdict is about older code.`
  } else if (now?.standing === 'uncommitted') {
    warn = true
    text += ' It is still at this commit, but the uncommitted changes are different now, so this verdict may not hold.'
  }
  const lines = [{ text, warn }]
  const pull = e.of?.pull
  if (pull?.head && head && pull.head !== head) {
    lines.push({ text: `${pullRef(pull)} was at ${pull.head.slice(0, 7)}, a different commit, so this is not a review of exactly what is pushed.`, warn: true })
  }
  return lines
}

export function standingOf(reply: { standing: ReviewStanding; now: { head?: string; error?: string } } | undefined, failure?: string): StandingNow {
  if (failure) return { failed: failure }
  if (!reply) return null
  return { standing: reply.standing, head: reply.now.head, error: reply.now.error }
}

export function shotsOf(e: ReviewEvent, finding: number): { kept: ReviewShot[]; lost: ReviewShot[] } {
  const mine = (e.evidence ?? []).filter((s) => s.finding === finding)
  return { kept: mine.filter((s) => s.file), lost: mine.filter((s) => !s.file) }
}

export const shotSize = (s: ReviewShot) => (s.width && s.height ? `${s.width} x ${s.height}` : '')

