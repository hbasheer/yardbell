import { expect, test } from 'vitest'
import { diffToBytes, endsLine, graphemes, singleAddedChar } from './liveInput'

test('typing sends the new characters', () => {
  expect(diffToBytes('', 'l')).toBe('l')
  expect(diffToBytes('ls', 'ls -')).toBe(' -')
  expect(diffToBytes('', 'hello')).toBe('hello')
})

test('deleting sends one DEL per character removed', () => {
  expect(diffToBytes('ls -', 'ls')).toBe('\x7f\x7f')
  expect(diffToBytes('abc', '')).toBe('\x7f\x7f\x7f')
})

test('a replacement deletes then types', () => {
  expect(diffToBytes('git cmmit', 'git commit')).toBe('\x7f\x7f\x7f\x7fommit')
  expect(diffToBytes('cat', 'cut')).toBe('\x7f\x7fut')
})

test('no change sends nothing and emoji count as one character', () => {
  expect(diffToBytes('same', 'same')).toBe('')
  expect(diffToBytes('a😀', 'a')).toBe('\x7f')
})

test('singleAddedChar finds one typed character', () => {
  expect(singleAddedChar('ab', 'abc')).toBe('c')
  expect(singleAddedChar('ab', 'abcd')).toBeNull()
  expect(singleAddedChar('ab', 'a')).toBeNull()
  expect(singleAddedChar('ab', 'xb')).toBeNull()
})

test('combining marks, ZWJ sequences and flags are one character', () => {
  const ba = 'ب\u064e'
  const family = '👨\u200d👩\u200d👧'
  const flag = '🇸🇦'
  expect(graphemes(ba)).toEqual([ba])
  expect(graphemes(family)).toEqual([family])
  expect(graphemes(`${flag}${flag}`)).toEqual([flag, flag])
  expect(diffToBytes(ba, '')).toBe('\x7f')
  expect(diffToBytes(`x${family}`, 'x')).toBe('\x7f')
  expect(diffToBytes(flag, '')).toBe('\x7f')
  expect(diffToBytes('ب', ba)).toBe('\x7f' + ba)
  expect(singleAddedChar('a', `a${ba}`)).toBe(ba)
})

test('endsLine marks the bytes after which the field no longer matches the prompt', () => {
  for (const bytes of ['\r', '\x1b', '\x03', '\x15', '\x04', 'ls\r']) expect(endsLine(bytes)).toBe(true)
  for (const bytes of ['ls', '\x7f', 'a']) expect(endsLine(bytes)).toBe(false)
})
