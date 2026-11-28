import { describe, expect, it } from 'vitest'
import type { PromptHistory } from '../types'
import { countLine, defaultCompare, historyHref, newestFirst, restoreConfirm, restoredMessage, sameVersions, versionLabel, versionNote, whenWord } from './history'

const history: PromptHistory = {
  name: 'Fix a bug',
  builtin: true,
  current: 3,
  versions: [
    { n: 1, text: 'a', at: '2026-01-01T10:00:00Z' },
    { n: 3, text: 'c', at: '2026-01-03T10:00:00Z', restored: 1 },
    { n: 2, text: 'b', at: '2026-01-02T10:00:00Z' }
  ]
}

describe('prompt history model', () => {
  it('builds an encoded href', () => {
    expect(historyHref('s 1', 'Fix a bug')).toBe('/dispatch/s%201/history?name=Fix%20a%20bug')
  })

  it('notes restored versions with the web wording', () => {
    expect(versionNote(history.versions[1], true)).toBe('The default again')
    expect(versionNote(history.versions[1], false)).toBe('Restored from version 1')
    expect(versionNote({ n: 4, text: '', at: '', restored: 2 }, true)).toBe('Restored from version 2')
    expect(versionNote(history.versions[0], true)).toBe('')
  })

  it('says when a version without a date comes with Yardbell', () => {
    expect(whenWord(undefined)).toBe('Comes with Yardbell')
    expect(whenWord('nonsense')).toBe('')
  })

  it('compares the last two versions by default', () => {
    expect(defaultCompare(history)).toEqual({ from: 2, to: 3 })
    expect(defaultCompare({ ...history, current: 1, versions: [history.versions[0]] })).toEqual({ from: 1, to: 1 })
  })

  it('sorts newest first without changing the input', () => {
    expect(newestFirst(history).map((v) => v.n)).toEqual([3, 2, 1])
    expect(history.versions.map((v) => v.n)).toEqual([1, 3, 2])
  })

  it('words counts and labels', () => {
    expect(countLine(1)).toBe('One version so far.')
    expect(countLine(4)).toBe('4 versions kept.')
    expect(versionLabel(3, 3)).toBe('Version 3 (current)')
    expect(versionLabel(2, 3)).toBe('Version 2')
  })

  it('detects identical versions', () => {
    expect(sameVersions([{ op: 'same', text: 'x' }])).toBe(true)
    expect(sameVersions([{ op: 'same', text: 'x' }, { op: 'add', text: 'y' }])).toBe(false)
  })

  it('words the restore confirm and result for the default and for other versions', () => {
    expect(restoreConfirm('Fix a bug', 1, true).confirm).toBe('Reset to the default')
    expect(restoreConfirm('Fix a bug', 2, true).confirm).toBe('Restore')
    expect(restoreConfirm('Mine', 1, false).title).toBe('Restore version 1 of "Mine"?')
    expect(restoredMessage('Fix a bug', 1, true, 4)).toBe('Reset "Fix a bug" to the default')
    expect(restoredMessage('Fix a bug', 2, true, 4)).toBe('Restored version 2 of "Fix a bug" as version 4')
  })
})
