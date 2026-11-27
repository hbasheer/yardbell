import { describe, expect, test } from 'vitest'
import { agentLabel, moveCopy, short, stopCopy } from './extras'

const target = { folder: '/home/dev/Projects/sama', machine: 'hp', agent: 'claude', activity: 'idle' }
const agents = [{ name: 'claude', label: 'Claude Code' }]

describe('extras copy', () => {
  test('short replaces the home folder', () => {
    expect(short('/home/dev/Projects/sama')).toBe('~/Projects/sama')
    expect(short('sama')).toBe('sama')
  })

  test('agentLabel falls back to the name', () => {
    expect(agentLabel(agents, 'claude')).toBe('Claude Code')
    expect(agentLabel(agents, 'codex')).toBe('codex')
    expect(agentLabel(undefined, 'codex')).toBe('codex')
  })

  test('move wording names the folder, machine and agent', () => {
    const copy = moveCopy(target, agents)
    expect(copy.title).toBe('Move ~/Projects/sama on hp into tmux?')
    expect(copy.message.startsWith('Yardbell stops Claude Code')).toBe(true)
    expect(copy.confirm).toBe('Move to tmux')
  })

  test('a working agent is warned about', () => {
    expect(moveCopy({ ...target, activity: 'active' }, agents).message).toContain('will be interrupted')
    expect(stopCopy({ ...target, activity: 'active' }, agents).message).toContain('will be interrupted')
    expect(stopCopy(target, agents).message).not.toContain('interrupted')
  })

  test('stop wording', () => {
    expect(stopCopy(target, agents).title).toBe('Stop Claude Code in ~/Projects/sama on hp?')
  })
})
