import { expect, test } from 'vitest'
import { agentGlyphKind, agentGlyphLabel } from './agentGlyph'

test('an active session shows the working ring', () => {
  expect(agentGlyphKind({ activity: 'active' })).toBe('working')
})

test('a blocked session shows the question icon', () => {
  expect(agentGlyphKind({ activity: 'blocked' })).toBe('question')
})

test('an idle session shows the idle dot', () => {
  expect(agentGlyphKind({ activity: 'idle' })).toBe('idle')
  expect(agentGlyphKind({ activity: 'idle', stopped: null })).toBe('idle')
})

test('a stopped session is red whatever its last activity was', () => {
  expect(agentGlyphKind({ activity: 'active', stopped: 'exited' })).toBe('stopped')
  expect(agentGlyphKind({ activity: 'blocked', stopped: 'killed' })).toBe('stopped')
})

test('every kind has a label for screen readers', () => {
  expect(agentGlyphLabel('question')).toBe('Needs you')
  expect(agentGlyphLabel('stopped')).toBe('Stopped')
})
