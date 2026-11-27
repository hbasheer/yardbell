import { describe, expect, test } from 'vitest'
import { machineSubtitle, previewParts } from './presentation'
import type { MachineRow } from '@/state/views'

const row = (fields: Partial<MachineRow>): MachineRow => ({
  key: 'a:hp',
  serverId: 'a',
  machine: 'hp',
  status: 'up',
  reason: null,
  sessions: 3,
  needsYou: 0,
  ...fields
})

describe('machineSubtitle', () => {
  test('connected with counts', () => {
    expect(machineSubtitle(row({ needsYou: 1 }))).toBe('Connected · 3 sessions, 1 needs you')
    expect(machineSubtitle(row({ sessions: 1 }))).toBe('Connected · 1 session')
    expect(machineSubtitle(row({ sessions: 0 }))).toBe('Connected · 0 sessions')
    expect(machineSubtitle(row({ needsYou: 2 }))).toBe('Connected · 3 sessions, 2 need you')
  })

  test('names the server when there are several', () => {
    expect(machineSubtitle(row({ serverLabel: 'mac-mini' }))).toBe('Connected on mac-mini · 3 sessions')
    expect(machineSubtitle(row({ serverLabel: 'hp' }))).toBe('Connected · 3 sessions')
  })

  test('a problem shows its reason and the server', () => {
    const down = row({ status: 'unreachable', reason: 'Cannot reach http://x:1', serverLabel: 'laptop' })
    expect(machineSubtitle(down)).toBe('Cannot reach http://x:1 · laptop')
    expect(machineSubtitle(row({ status: 'down', reason: null }))).toBe('Not connected')
  })
})

describe('previewParts', () => {
  test('joins ticket and branch, skipping blanks and dashes', () => {
    expect(previewParts({ ticket: 'YB-1', branch: 'main' })).toBe('YB-1 · main')
    expect(previewParts({ ticket: '', branch: '-' })).toBe('')
    expect(previewParts({ branch: 'dev' })).toBe('dev')
  })
})
