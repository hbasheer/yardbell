import { describe, expect, it } from 'vitest'
import { blocks, chipState, runState, runTitle, stepsOf, toolLabel } from './blocks'
import type { ActionEvent, DispatchEvent } from './types'

const tool = (name: string, input: unknown = {}): DispatchEvent => ({ role: 'tool', name, input })
const result = (name: string, text = 'ok', is_error = false): DispatchEvent => ({ role: 'tool_result', name, text, is_error })
const action = (id: string, group?: string): ActionEvent => ({ role: 'action', id, tool: 'start_session', input: {}, status: 'pending', group })

describe('blocks', () => {
  it('puts consecutive tool events in one run and pairs a result with its call', () => {
    const out = blocks([tool('list_machines'), result('list_machines', 'hp'), tool('list_sessions'), result('list_sessions', 'none')])
    expect(out).toHaveLength(1)
    const run = out[0]
    if (run.kind !== 'tools') throw new Error('tools')
    expect(run.chips.map((c) => [c.name, c.result?.text])).toEqual([['list_machines', 'hp'], ['list_sessions', 'none']])
  })

  it('pairs a result with the first chip of its name that is still waiting', () => {
    const out = blocks([tool('read_session', { name: 'a' }), tool('read_session', { name: 'b' }), result('read_session', 'first'), result('read_session', 'second')])
    const run = out[0]
    if (run.kind !== 'tools') throw new Error('tools')
    expect(run.chips.map((c) => [(c.input as { name: string }).name, c.result?.text])).toEqual([['a', 'first'], ['b', 'second']])
  })

  it('starts a chip for a result that has no call before it', () => {
    const run = blocks([result('list_folders', 'x')])[0]
    if (run.kind !== 'tools') throw new Error('tools')
    expect(run.chips).toHaveLength(1)
    expect(run.chips[0].result?.text).toBe('x')
  })

  it('starts a new run after any other event and keeps keys as stored indexes', () => {
    const out = blocks([tool('list_machines'), { role: 'assistant', text: 'hi' }, tool('list_sessions'), result('list_sessions')])
    expect(out.map((b) => [b.kind, b.key])).toEqual([['tools', 0], ['event', 1], ['tools', 2]])
  })

  it('lets a late result land on its waiting chip in an earlier run, as the web does', () => {
    const out = blocks([tool('list_machines'), { role: 'assistant', text: 'hi' }, result('list_machines', 'late')])
    expect(out.map((b) => b.kind)).toEqual(['tools', 'event'])
    const first = out[0]
    if (first.kind !== 'tools') throw new Error('tools')
    expect(first.chips[0].result?.text).toBe('late')
  })

  it('leaves out steps that belong to a group but keeps the stored index of what follows', () => {
    const out = blocks([{ role: 'user', text: 'go' }, action('a', 'g1'), { role: 'group', id: 'g1', title: 'T', children: [], status: 'waiting' }, action('b')])
    expect(out.map((b) => b.key)).toEqual([0, 2, 3])
  })

  it('keeps unknown tool names as they are', () => {
    expect(toolLabel('list_machines')).toBe('Checked machines')
    expect(toolLabel('weird_tool')).toBe('weird_tool')
  })

  it('summarises a run and its state', () => {
    const run = blocks([tool('list_machines'), tool('read_session'), tool('read_session'), result('list_machines', 'hp'), result('read_session', 'boom', true)])[0]
    if (run.kind !== 'tools') throw new Error('tools')
    expect(runTitle(run.chips)).toBe('Checked machines, read a session')
    expect(runState(run.chips, true)).toBe('error')
    expect(chipState(run.chips[2], true)).toBe('running')
    expect(chipState(run.chips[2], false)).toBe('idle')
    expect(chipState(run.chips[0], false)).toBe('ok')
  })

  it('reports running only while something is waiting and the turn is live', () => {
    const run = blocks([tool('list_machines')])[0]
    if (run.kind !== 'tools') throw new Error('tools')
    expect(runState(run.chips, true)).toBe('running')
    expect(runState(run.chips, false)).toBe('ok')
  })

  it('indexes steps by id over the whole event list', () => {
    const map = stepsOf([{ role: 'assistant', text: 'x' }, action('a'), action('b', 'g')])
    expect([...map.keys()]).toEqual(['a', 'b'])
  })
})
