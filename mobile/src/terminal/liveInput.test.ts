import { expect, test } from 'vitest'
import { diffToBytes, singleAddedChar } from './liveInput'

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
