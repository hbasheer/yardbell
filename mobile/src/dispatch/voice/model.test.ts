import { describe, expect, it } from 'vitest'
import type { DispatchEvent } from '../types'
import { HOLD_MS, MIN_RECORDING_MS, eventKey, insertAtCursor, keysOf, micHint, micMode, onRelease, parseSpeak, speechFor, speechPieces, spokenText, takeNew, tooShort } from './model'

const assistant = (text: string): DispatchEvent => ({ role: 'assistant', text })
const user = (text: string): DispatchEvent => ({ role: 'user', text })
const blocked: DispatchEvent = { role: 'session', machine: 'hp', name: 'yardbell-3', state: 'blocked' }

describe('micMode', () => {
  it('follows the server and falls back to auto', () => {
    expect(micMode('hold')).toBe('hold')
    expect(micMode('toggle')).toBe('toggle')
    expect(micMode('auto')).toBe('auto')
    expect(micMode(undefined)).toBe('auto')
    expect(micMode('whatever')).toBe('auto')
  })

  it('hints at how to use it', () => {
    expect(micHint('hold')).toBe('Hold to dictate')
    expect(micHint('toggle')).toBe('Start dictation')
  })
})

describe('onRelease', () => {
  const held = (mode: 'hold' | 'auto' | 'toggle', heldMs: number, flags: { stopping?: boolean; starting?: boolean } = {}) =>
    onRelease({ mode, heldMs, stopping: false, starting: false, ...flags })

  it('hold stops on any release', () => {
    expect(held('hold', 50)).toBe('stop')
  })

  it('toggle never stops on release, except the tap that stops', () => {
    expect(held('toggle', 5000)).toBe('keep')
    expect(held('toggle', 50, { stopping: true })).toBe('stop')
  })

  it('auto keeps recording after a tap and stops after a hold', () => {
    expect(held('auto', HOLD_MS - 1)).toBe('keep')
    expect(held('auto', HOLD_MS)).toBe('stop')
    expect(held('auto', 10, { stopping: true })).toBe('stop')
  })

  it('a release before the recorder started stops it once it has', () => {
    expect(held('hold', 100, { starting: true })).toBe('stop-after-start')
    expect(held('auto', HOLD_MS + 1, { starting: true })).toBe('stop-after-start')
    expect(held('auto', 100, { starting: true })).toBe('keep')
    expect(held('toggle', 100, { starting: true })).toBe('keep')
  })
})

describe('insertAtCursor', () => {
  it('puts the words at the cursor with one space on each side', () => {
    expect(insertAtCursor('fix the test', { start: 3, end: 3 }, 'login')).toEqual({ text: 'fix login the test', cursor: 9 })
  })

  it('adds no space at the ends or next to a space', () => {
    expect(insertAtCursor('', { start: 0, end: 0 }, ' hello ')).toEqual({ text: 'hello', cursor: 5 })
    expect(insertAtCursor('go ', { start: 3, end: 3 }, 'now')).toEqual({ text: 'go now', cursor: 6 })
    expect(insertAtCursor('go', { start: 2, end: 2 }, 'now')).toEqual({ text: 'go now', cursor: 6 })
  })

  it('replaces a selection and keeps the text when nothing was heard', () => {
    expect(insertAtCursor('say old words', { start: 4, end: 7 }, 'new')).toEqual({ text: 'say new words', cursor: 7 })
    expect(insertAtCursor('abc', { start: 1, end: 1 }, '  ')).toEqual({ text: 'abc', cursor: 1 })
  })

  it('clamps a cursor past the end', () => {
    expect(insertAtCursor('abc', { start: 9, end: 9 }, 'd')).toEqual({ text: 'abc d', cursor: 5 })
  })
})

describe('spokenText', () => {
  it('reads prose only', () => {
    expect(spokenText('## Plan\n- **First**, read [the docs](https://x.dev)\n2. run `cargo test`')).toBe('Plan First, read the docs run cargo test')
  })

  it('names code blocks and tables instead of reading them', () => {
    expect(spokenText('Done.\n\n```\nrm -rf x\n```')).toBe('Done. The reply also holds a code block.')
    expect(spokenText('| a | b |\n|---|---|\n| 1 | 2 |\n\nText\n\n```a```\n```b```')).toBe('Text The reply also holds 2 code blocks and a table.')
  })

  it('counts an unfinished code block', () => {
    expect(spokenText('Look:\n```js\nlet x')).toBe('Look: The reply also holds a code block.')
  })

  it('cuts a long reply at a word', () => {
    const out = spokenText('word '.repeat(300))
    expect(out.endsWith(', and more.')).toBe(true)
    expect(out.length).toBeLessThan(520)
  })
})

describe('speechPieces', () => {
  it('splits at words into short utterances', () => {
    const pieces = speechPieces('word '.repeat(100))
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.every((p) => p.length <= 205)).toBe(true)
    expect(pieces.join(' ').split(' ')).toHaveLength(100)
  })

  it('has nothing for blank text', () => {
    expect(speechPieces('   ')).toEqual([])
  })
})

describe('speechFor', () => {
  it('reads assistant replies, errors and blocked sessions only', () => {
    expect(speechFor(assistant('Hello **there**'))).toBe('Hello there')
    expect(speechFor({ role: 'error', text: 'It broke.' })).toBe('Dispatch hit an error. It broke.')
    expect(speechFor(blocked)).toBe('Session yardbell-3 on hp is waiting for an answer.')
    expect(speechFor({ ...blocked, state: 'idle' })).toBeNull()
    expect(speechFor(user('hi'))).toBeNull()
    expect(speechFor({ role: 'tool', name: 'x', input: {} })).toBeNull()
    expect(speechFor(assistant('   '))).toBeNull()
  })
})

describe('takeNew', () => {
  it('speaks what arrived after the history, never the history', () => {
    const history = [user('a'), assistant('old reply')]
    const base = keysOf(history)
    expect(takeNew(history, base).say).toEqual([])
    const grown = [...history, user('b'), assistant('new reply'), blocked]
    expect(takeNew(grown, base).say).toEqual(['new reply', 'Session yardbell-3 on hp is waiting for an answer.'])
  })

  it('does not repeat when the list is replaced by an equal one', () => {
    const first = takeNew([user('a'), assistant('reply')], new Set())
    expect(takeNew([user('a'), assistant('reply')], first.seen).say).toEqual([])
  })

  it('neither repeats nor skips when a poll returns a shorter or reordered list', () => {
    const spoken = takeNew([user('a'), assistant('one'), assistant('two')], new Set())
    expect(spoken.say).toEqual(['one', 'two'])
    expect(takeNew([user('a'), assistant('one')], spoken.seen).say).toEqual([])
    expect(takeNew([user('a'), assistant('one'), assistant('two'), assistant('three')], spoken.seen).say).toEqual(['three'])
  })

  it('keys events with an id by role and id', () => {
    const a: DispatchEvent = { role: 'action', id: 'x1', tool: 't', input: {}, status: 'pending' }
    expect(eventKey(a, 3)).toBe(eventKey(a, 9))
  })

  it('starts from nothing for a new chat', () => {
    expect(takeNew([user('a'), assistant('hi')], new Set()).say).toEqual(['hi'])
  })
})

describe('tooShort', () => {
  it('discards a tap but keeps a real recording', () => {
    expect(tooShort(1000, 1000 + MIN_RECORDING_MS - 1)).toBe(true)
    expect(tooShort(1000, 1000 + MIN_RECORDING_MS)).toBe(false)
  })
})

describe('parseSpeak', () => {
  it('is on only for the stored 1', () => {
    expect(parseSpeak('1')).toBe(true)
    expect(parseSpeak(null)).toBe(false)
    expect(parseSpeak('0')).toBe(false)
  })
})
