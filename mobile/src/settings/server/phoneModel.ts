import type { PhoneSettings, PhoneSettingsChange } from '../serverApi'

export type PhoneKey = keyof PhoneSettingsChange

export const PHONE_MAIN: [PhoneKey, string][] = [
  ['session_ended', 'Session ended'],
  ['limit_reset', 'Usage limit reset'],
  ['machines', 'Machine down or back'],
  ['memory', 'Memory at 95%'],
  ['pipeline_waiting', 'Pipeline needs you'],
  ['pipeline_finished', 'Pipeline finished'],
  ['proposals', 'Proposals from MCP clients'],
  ['dispatch', 'Dispatch steps waiting for you']
]

export const PHONE_PULLS: [PhoneKey, string][] = [
  ['pull_ci_failed', 'CI failed'],
  ['pull_conflicts', 'Merge conflicts'],
  ['pull_ready', 'Ready to merge'],
  ['pull_merged', 'Merged'],
  ['pull_closed', 'Closed without merging']
]

export const PHONE_HELP = 'The Yardbell app for Android shows these while it is signed in to this server. Nothing else to install.'

export const MAX_WAIT_MINUTES = 60

export function parseMinutes(text: string): { value: number } | { error: string } {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return { error: `Enter a whole number of minutes from 0 to ${MAX_WAIT_MINUTES}` }
  const value = Number(trimmed)
  if (value > MAX_WAIT_MINUTES) return { error: `Enter a whole number of minutes from 0 to ${MAX_WAIT_MINUTES}` }
  return { value }
}

export const waitWord = (minutes: number) => (minutes === 0 ? 'At once' : minutes === 1 ? 'After 1 minute' : `After ${minutes} minutes`)

export function connectedNote(connected: boolean | undefined): string {
  return connected ? 'The Yardbell app is connected and gets these.' : 'No phone has the Yardbell app connected right now.'
}

export function shown(phone: PhoneSettings, pending: PhoneSettingsChange): PhoneSettings {
  return { ...phone, ...pending }
}
