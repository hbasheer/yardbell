import { describe, expect, it } from 'vitest'
import type { SavedPrompt } from '../types'
import {
  canSave,
  clampName,
  clash,
  deleteNote,
  emptyForm,
  filterPrompts,
  formOf,
  hasHiddenDefaults,
  hasUnsavedEdits,
  promptToRun,
  runHref,
  versionLine
} from './model'

const p = (name: string, extra: Partial<SavedPrompt> = {}): SavedPrompt => ({ name, text: `${name} text`, version: 1, ...extra })

describe('saved prompt model', () => {
  const list = [p('Fix a bug', { builtin: true }), p('Review', { text: 'Review the diff' }), p('Gone', { builtin: true, hidden: true })]

  it('hides deleted defaults and reports them', () => {
    expect(filterPrompts(list, '').map((x) => x.name)).toEqual(['Fix a bug', 'Review'])
    expect(hasHiddenDefaults(list)).toBe(true)
    expect(hasHiddenDefaults(list.slice(0, 2))).toBe(false)
  })

  it('searches name and text, ignoring case', () => {
    expect(filterPrompts(list, ' DIFF ').map((x) => x.name)).toEqual(['Review'])
    expect(filterPrompts(list, 'gone')).toEqual([])
  })

  it('needs a name and text', () => {
    expect(canSave(emptyForm())).toBe(false)
    expect(canSave({ editing: null, name: '  ', text: 'x' })).toBe(false)
    expect(canSave({ editing: null, name: 'a', text: ' ' })).toBe(false)
    expect(canSave({ editing: null, name: 'a', text: 'b' })).toBe(true)
  })

  it('sees unsaved edits to the prompt being edited', () => {
    expect(hasUnsavedEdits(list, formOf(list[1]))).toBe(false)
    expect(hasUnsavedEdits(list, { ...formOf(list[1]), text: 'Review it' })).toBe(true)
    expect(hasUnsavedEdits(list, { ...formOf(list[1]), name: 'Review 2' })).toBe(true)
    expect(hasUnsavedEdits(list, emptyForm())).toBe(true)
  })

  it('limits the name to 60 characters', () => {
    expect(clampName('x'.repeat(80))).toHaveLength(60)
  })

  it('flags a name that another prompt already uses, but not the one being edited', () => {
    expect(clash(list, { editing: null, name: ' review ', text: 't' })).toContain('"Review"')
    expect(clash(list, { editing: 'Review', name: 'Review', text: 't' })).toBeNull()
    expect(clash(list, { editing: 'Review', name: 'Fix a bug', text: 't' })).toContain('"Fix a bug"')
    expect(clash(list, { editing: null, name: 'Gone', text: 't' })).toBeNull()
  })

  it('opens an existing prompt for editing', () => {
    expect(formOf(list[1])).toEqual({ editing: 'Review', name: 'Review', text: 'Review the diff' })
  })

  it('words the delete note and version line as the web does', () => {
    expect(deleteNote(list[0])).toContain('Restore default prompts')
    expect(deleteNote(list[1])).toBe('Conversations it started are kept.')
    expect(versionLine(p('a', { version: 3 }))).toBe('Version 3')
    expect(versionLine(p('a', { builtin: true }))).toBe('Version 1, the default')
    expect(versionLine(p('a', { builtin: true, customised: true, version: 2 }))).toBe('Version 2, changed from the default')
  })

  it('builds the run route and finds the prompt to run', () => {
    expect(runHref('s 1', 'Fix & go')).toBe('/dispatch/s%201/new?run=Fix%20%26%20go')
    expect(promptToRun(list, 'Review')?.version).toBe(1)
    expect(promptToRun(list, 'Gone')).toBeUndefined()
  })
})
