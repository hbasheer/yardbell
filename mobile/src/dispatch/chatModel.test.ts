import { describe, expect, it } from 'vitest'
import type { StateView } from '../state/types'
import {
  backendNote,
  dockOf,
  elapsed,
  hasNews,
  liveLookup,
  mergeStreamed,
  pendingSteps,
  promptSave,
  proposedPrompt,
  replaceAt,
  replaceSteps,
  runsOnText,
  sentEvent,
  settledText,
  shownPending,
  starters,
  trackedRows,
  userCaption,
  waitingText,
  withdrawnCount,
  withdrawnText
} from './chatModel'
import type { ActionEvent, DispatchEvent, RunsOn, SavedPrompt } from './types'

const step = (id: string, status: ActionEvent['status'] = 'pending'): ActionEvent => ({ role: 'action', id, tool: 'start_session', input: {}, status })
const user = (text: string): DispatchEvent => ({ role: 'user', text })
const said = (text: string): DispatchEvent => ({ role: 'assistant', text })

describe('mergeStreamed', () => {
  it('appends a new event', () => {
    const list = [user('hi')]
    expect(mergeStreamed(list, said('hello'))).toEqual([user('hi'), said('hello')])
  })

  it('replaces a step the server sends again instead of drawing it twice', () => {
    const list = [user('hi'), step('a'), said('x')]
    const out = mergeStreamed(list, step('a', 'approved'))
    expect(out).toHaveLength(3)
    expect(out[1]).toEqual(step('a', 'approved'))
  })
})

describe('replaceSteps', () => {
  it('takes each step from the server by id and leaves other events alone', () => {
    const local = [user('hi'), step('a'), step('b'), said('streamed')]
    const out = replaceSteps(local, [step('a', 'withdrawn'), step('b', 'withdrawn'), user('server only')])
    expect(out.map((e) => (e.role === 'action' ? e.status : e.role))).toEqual(['user', 'withdrawn', 'withdrawn', 'assistant'])
    expect(out).toHaveLength(4)
  })

  it('returns the same list when nothing changed', () => {
    const local = [step('a')]
    expect(replaceSteps(local, [step('a')])).toBe(local)
  })
})

describe('replaceAt', () => {
  it('replaces the event at the stored index', () => {
    const list = [user('a'), said('b')]
    expect(replaceAt(list, 1, said('c'))[1]).toEqual(said('c'))
  })

  it('ignores an index that now holds another kind of event', () => {
    const list = [user('a'), said('b')]
    expect(replaceAt(list, 0, said('c'))).toBe(list)
  })
})

describe('pending steps', () => {
  it('lists the steps that wait, in order, and shows the chosen one or the first', () => {
    const list = [step('a', 'approved'), step('b'), user('x'), step('c')]
    const pending = pendingSteps(list)
    expect(pending.map((s) => s.id)).toEqual(['b', 'c'])
    expect(shownPending(pending, null)?.id).toBe('b')
    expect(shownPending(pending, 'c')?.id).toBe('c')
    expect(shownPending(pending, 'gone')?.id).toBe('b')
    expect(shownPending([], null)).toBeNull()
  })

  it('says how many steps wait', () => {
    expect(waitingText(1)).toBe('1 step waits for your approval. Sending a new message withdraws it, so Dispatch can propose again.')
    expect(waitingText(2)).toBe('2 steps wait for your approval. Sending a new message withdraws them, so Dispatch can propose again.')
  })
})

describe('dockOf', () => {
  it('leaves grouped steps to the group card and offers Approve all only without them', () => {
    const grouped = { ...step('g'), group: 'g1' }
    expect(dockOf([step('a'), step('b')])).toEqual({ steps: [step('a'), step('b')], all: true })
    expect(dockOf([step('a'), step('b'), grouped])).toEqual({ steps: [step('a'), step('b')], all: false })
    expect(dockOf([step('a')]).all).toBe(false)
    expect(dockOf([grouped]).steps).toEqual([])
  })
})

describe('withdrawnCount', () => {
  it('counts steps that waited before and the server now marks withdrawn', () => {
    const before = [user('go'), step('a'), step('b'), step('c', 'approved')]
    const after = [user('go'), step('a', 'withdrawn'), step('b', 'withdrawn'), step('c', 'approved'), user('next')]
    expect(withdrawnCount(before, after)).toBe(2)
    expect(withdrawnText(2)).toBe('The 2 steps that waited were withdrawn because you sent a new message.')
    expect(withdrawnText(1)).toBe('The step that waited was withdrawn because you sent a new message.')
  })

  it('does not count a step that was already withdrawn', () => {
    expect(withdrawnCount([step('a', 'withdrawn')], [step('a', 'withdrawn')])).toBe(0)
  })
})

describe('hasNews', () => {
  it('is true when the stamp changed or the list grew', () => {
    expect(hasNews({ updated: 't1', count: 2 }, { updated: 't1', events: [user('a'), user('b')] })).toBe(false)
    expect(hasNews({ updated: 't1', count: 2 }, { updated: 't2', events: [user('a'), user('b')] })).toBe(true)
    expect(hasNews({ updated: 't1', count: 1 }, { updated: 't1', events: [user('a'), user('b')] })).toBe(true)
  })
})

describe('sentEvent and captions', () => {
  it('builds the message shown while it is sent', () => {
    expect(sentEvent('hi', [], { name: 'Fix a bug', version: 2 })).toEqual({ role: 'user', text: 'hi', task: { name: 'Fix a bug', version: 2 } })
    expect(sentEvent('', [{ name: 'a.txt', data: 'aGVsbG8h' }]).attachments).toEqual([{ file: '', name: 'a.txt', kind: 'file', size: 6 }])
  })

  it('captions messages that came from Yardbell, a saved prompt or a prompt suggestion', () => {
    expect(userCaption({ role: 'user', text: '', by: 'yardbell' })).toBe('Sent by Yardbell once the results were in')
    expect(userCaption({ role: 'user', text: '', task: { name: 'Fix', version: 3 } })).toBe('Saved prompt Fix · version 3')
    expect(userCaption({ role: 'user', text: '', improve: { machine: 'hp', name: 'app-1' } })).toBe('Suggest a better prompt for app-1 on hp')
    expect(userCaption({ role: 'user', text: 'plain' })).toBe('')
  })
})

describe('prompt suggestions', () => {
  const prompts: SavedPrompt[] = [{ name: 'Fix a bug', text: 'old', version: 2 }]
  const reply = 'Try this:\n\n```prompt\nFind the failing test first.\n```'

  it('finds the last proposed prompt in a reply', () => {
    expect(proposedPrompt(`${reply}\n\n\`\`\`prompt\nSecond.\n\`\`\``)).toBe('Second.')
    expect(proposedPrompt('no prompt')).toBe('')
  })

  it('offers to save it as the next version of the prompt it improves', () => {
    const events: DispatchEvent[] = [{ role: 'user', text: 'x', improve: { machine: 'hp', name: 'a', task: { name: 'Fix a bug', version: 2 } } }, said(reply)]
    expect(promptSave(events, 1, prompts)).toEqual({ text: 'Find the failing test first.', from: prompts[0] })
    expect(promptSave([user('x'), said(reply)], 1, prompts)).toBeNull()
  })
})

describe('runs on', () => {
  const runsOn: RunsOn = {
    runs_on: 'claude',
    label: 'Claude Code',
    model: 'sonnet',
    agents: { claude: { label: 'Claude Code', model: 'sonnet' }, codex: { label: 'Codex', model: 'gpt-5' } },
    voice_input: true,
    voice_mode: 'hold'
  }

  it('names the agent and model', () => {
    expect(runsOnText(runsOn, 'claude')).toBe('Claude Code (Sonnet 5.5)')
    expect(runsOnText(runsOn, 'codex')).toBe('Codex (gpt-5)')
    expect(runsOnText(null, 'claude')).toBe('Claude Code (default model)')
  })

  it('notes a conversation that runs on another backend than the default', () => {
    expect(backendNote(runsOn, 'claude')).toBeNull()
    expect(backendNote(runsOn, 'codex')).toBe(
      'This conversation runs on Codex (gpt-5), so it carries on there. New conversations start on Claude Code (Sonnet 5.5). To switch, start a new conversation.'
    )
  })
})

describe('starters', () => {
  it('shows up to six prompts that are not hidden', () => {
    const list = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, text: '', version: 1, hidden: i === 0 }))
    expect(starters(list).map((p) => p.name)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
  })
})

describe('tracked sessions and live lookup', () => {
  const session = (tmux: string, activity: 'active' | 'idle' | 'blocked', stopped?: string) => ({
    id: tmux,
    machine: 'hp',
    agent: 'claude',
    folder: 'app',
    branch: 'main',
    activity,
    attachable: true,
    tmux,
    stale: false,
    stopped
  })
  const state = { machines: [], sessions: [session('a', 'blocked'), session('b', 'active'), session('c', 'idle', 'error'), session('d', 'idle')] } as StateView

  it('words each tracked session from the live state', () => {
    const rows = trackedRows(['a', 'b', 'c', 'd', 'e'].map((name) => ({ machine: 'hp', name })), state)
    expect(rows.map((r) => [r.word, r.tone, r.live])).toEqual([
      ['needs you', 'blocked', true],
      ['working', 'active', true],
      ['stopped on an error', 'stopped', true],
      ['idle', 'idle', true],
      ['ended', 'ended', false]
    ])
  })

  it('looks sessions up for the cards, or leaves them to the stored state', () => {
    expect(liveLookup(undefined)).toBeUndefined()
    const lookup = liveLookup(state)
    expect(lookup?.('hp', 'b')).toBe('active')
    expect(lookup?.('hp', 'zz')).toBeNull()
  })
})

describe('words', () => {
  it('formats the elapsed time of a turn', () => {
    expect(elapsed(4200)).toBe('4s')
    expect(elapsed(72_000)).toBe('1m 12s')
  })

  it('turns the server refusal into a sentence', () => {
    expect(settledText('this step was already approved')).toBe('This step was already approved.')
    expect(settledText('')).toBe('Already decided.')
  })
})
