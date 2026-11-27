import { describe, expect, test } from 'vitest'
import { comboOf, repliesFor } from './replies'

describe('repliesFor', () => {
  test('a permission prompt offers Yes, Always and No in that order', () => {
    const replies = repliesFor({
      agent: 'claude',
      state: 'permission',
      choices: [
        { number: 1, label: 'No, and tell Claude', keys: '3', role: 'no' },
        { number: 2, label: 'Yes', keys: '1', role: 'yes' },
        { number: 3, label: 'Something else', keys: '4' },
        { number: 4, label: 'Yes, always', keys: '2', role: 'always' }
      ]
    })
    expect(replies).toEqual([
      { word: 'Yes', keys: '1', primary: true },
      { word: 'Always', keys: '2', primary: false },
      { word: 'No', keys: '3', primary: false }
    ])
  })

  test('a question offers its numbered choices and Cancel last', () => {
    const replies = repliesFor({
      agent: 'claude',
      state: 'question',
      choices: [
        { number: 1, label: 'Red', keys: '1' },
        { number: 2, label: 'Blue', keys: '2' }
      ]
    })
    expect(replies).toEqual([
      { word: '1. Red', keys: '1' },
      { word: '2. Blue', keys: '2' },
      { word: 'Cancel', keys: null }
    ])
  })

  test('nothing to offer while working or without choices', () => {
    expect(repliesFor({ agent: 'claude', state: 'working', choices: [{ number: 1, label: 'x', keys: '1' }] })).toEqual([])
    expect(repliesFor({ agent: 'claude', state: 'question', choices: [] })).toEqual([])
  })
})

describe('comboOf', () => {
  test('names the keys a reply presses', () => {
    expect(comboOf('1')).toBe('1')
    expect(comboOf('\r')).toBe('Enter')
    expect(comboOf('2\r')).toBe('2 Enter')
    expect(comboOf(null)).toBe('Esc')
    expect(comboOf('\x1b')).toBe('Esc')
  })
})
