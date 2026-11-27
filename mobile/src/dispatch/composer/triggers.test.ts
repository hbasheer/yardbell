import { describe, expect, it } from 'vitest'
import type { StateView } from '../../state/types'
import type { SavedPrompt } from '../types'
import { MENU_LIMIT, applyToken, findTrigger, nameItems, pickedTask, rank, taskItems } from './triggers'
import { draftKey } from './drafts'
import { approvalOf, currentModel, filterModels, modelChange, modelsFor } from './models'

describe('findTrigger', () => {
  it('opens at the start of a word', () => {
    expect(findTrigger('@', 1)).toEqual({ kind: 'names', query: '', from: 0, to: 1 })
    expect(findTrigger('look at @Yard', 13)).toEqual({ kind: 'names', query: 'yard', from: 8, to: 13 })
    expect(findTrigger('run /rel', 8)).toEqual({ kind: 'tasks', query: 'rel', from: 4, to: 8 })
    expect(findTrigger('line one\n/', 10)).toEqual({ kind: 'tasks', query: '', from: 9, to: 10 })
  })

  it('stays closed inside a word, a path or an email address', () => {
    expect(findTrigger('mail me@host', 12)).toBeNull()
    expect(findTrigger('open src/dispatch', 17)).toBeNull()
    expect(findTrigger('see /usr/bin', 12)).toBeNull()
    expect(findTrigger('@yard done', 10)).toBeNull()
  })

  it('reads only up to the cursor', () => {
    expect(findTrigger('go @ya and more', 6)).toEqual({ kind: 'names', query: 'ya', from: 3, to: 6 })
  })
})

describe('rank', () => {
  it('orders prefix, word prefix, contains, other fields', () => {
    expect(rank('yard', 'yardbell')).toBe(0)
    expect(rank('', 'anything')).toBe(0)
    expect(rank('bell', 'yard-bell')).toBe(1)
    expect(rank('dbe', 'yardbell')).toBe(2)
    expect(rank('main', 'yardbell', 'hp', undefined, 'main')).toBe(3)
    expect(rank('zzz', 'yardbell', 'hp')).toBeNull()
  })
})

const state: Pick<StateView, 'machines' | 'sessions' | 'folders'> = {
  machines: [
    { name: 'hp', up: true, reason: null, local: true },
    { name: 'mac-pro', up: false, reason: 'offline', local: false }
  ],
  sessions: [
    { id: '1', machine: 'hp', agent: 'claude', folder: '/home/dev/Projects/yardbell', branch: 'main', activity: 'idle', attachable: true, tmux: 'yardbell-1', stale: false },
    { id: '2', machine: 'mac-pro', agent: 'codex', folder: '/Users/dev/yardbell', branch: 'fix', activity: 'idle', attachable: true, tmux: 'yardbell-1', stale: false },
    { id: '3', machine: 'hp', agent: 'claude', folder: '/x', branch: '', activity: 'idle', attachable: false, tmux: null, stale: false },
    { id: '4', machine: 'hp', agent: 'claude', folder: '/x', branch: '', activity: 'idle', attachable: true, tmux: 'old', stale: true }
  ],
  folders: [
    { machine: 'hp', label: 'yardbell', path: '/home/dev/Projects/yardbell', branch: 'main' },
    { machine: 'hp', label: '/srv/outside/site', path: '/srv/outside/site', branch: 'main' }
  ]
}

describe('nameItems', () => {
  it('lists machines, live named sessions and folders', () => {
    const items = nameItems(state, '')
    expect(items.map((i) => `${i.group}:${i.label}`)).toEqual([
      'Machines:hp',
      'Machines:mac-pro',
      'Sessions:yardbell-1',
      'Sessions:yardbell-1',
      'Folders:yardbell',
      'Folders:site'
    ])
    expect(items[1].detail).toBe('down')
  })

  it('adds the machine to a session name that exists twice', () => {
    const tokens = nameItems(state, 'yardbell-1').map((i) => i.token)
    expect(tokens).toEqual(['yardbell-1 on hp', 'yardbell-1 on mac-pro'])
  })

  it('shortens the home folder in the detail and names an outside folder by its last part', () => {
    const [session] = nameItems(state, 'yardbell-1')
    expect(session.detail).toBe('claude on hp · ~/Projects/yardbell · main')
    const site = nameItems(state, 'site')[0]
    expect(site).toMatchObject({ label: 'site', token: '/srv/outside/site', detail: 'on hp · main · /srv/outside/site' })
  })

  it('ranks best matches first and matches other fields last', () => {
    const items = nameItems(state, 'fix')
    expect(items.map((i) => i.label)).toEqual(['yardbell-1'])
    expect(items[0].rank).toBe(3)
    const ranked = nameItems(state, 'yard')
    expect(ranked.every((i, at) => at === 0 || ranked[at - 1].rank <= i.rank)).toBe(true)
  })

  it('stops at 40 items', () => {
    const many = { ...state, sessions: [], folders: Array.from({ length: 70 }, (_, i) => ({ machine: 'hp', label: `app-${i}`, path: `/p/${i}`, branch: '' })) }
    expect(nameItems(many, '')).toHaveLength(MENU_LIMIT)
  })
})

describe('taskItems', () => {
  const prompts: SavedPrompt[] = [
    { name: 'Release notes', text: 'Write release notes', version: 2 },
    { name: 'Standup', text: 'Summarise the release work', version: 1 },
    { name: 'Hidden', text: 'release', version: 1, hidden: true }
  ]

  it('ranks on the name then the text and drops hidden prompts', () => {
    const items = taskItems(prompts, 'release')
    expect(items.map((i) => [i.label, i.rank])).toEqual([['Release notes', 0], ['Standup', 3]])
    expect(items[0].token).toBe('Write release notes')
  })
})

describe('applyToken', () => {
  it('replaces the trigger with the token and a space', () => {
    const trigger = findTrigger('check @ya', 9)!
    expect(applyToken('check @ya', trigger, 'yardbell-1')).toEqual({ text: 'check yardbell-1 ', cursor: 17 })
  })

  it('keeps the text after the cursor', () => {
    const trigger = findTrigger('a @ya tail', 5)!
    expect(applyToken('a @ya tail', trigger, 'x')).toEqual({ text: 'a x tail', cursor: 4 })
  })
})

describe('pickedTask', () => {
  const prompt: SavedPrompt = { name: 'Release notes', text: 'Write release notes', version: 2 }
  it('marks the message while the prompt text is still in it', () => {
    expect(pickedTask('Write release notes now', [prompt])).toEqual({ name: 'Release notes', version: 2 })
    expect(pickedTask('Something else', [prompt])).toBeUndefined()
  })
})

describe('draftKey', () => {
  it('is one key per server and conversation, with its own key for a new chat', () => {
    expect(draftKey('a', 'c1')).not.toBe(draftKey('b', 'c1'))
    expect(draftKey('a', 'c1')).not.toBe(draftKey('a', 'c2'))
    expect(draftKey('a', null)).toBe('yardbell:dispatch-draft:a:new')
  })
})

describe('settings helpers', () => {
  it('maps legacy approval names', () => {
    expect(approvalOf({ approval: 'auto' })).toBe('allow')
    expect(approvalOf({ approval: 'ask' })).toBe('prompt')
    expect(approvalOf({ approval: 'deny' })).toBe('deny')
    expect(approvalOf(undefined)).toBe('prompt')
  })

  it('saves the model into the field of the running agent', () => {
    expect(modelChange({ runs_on: 'claude' }, 'opus')).toEqual({ model: 'opus' })
    expect(modelChange({ runs_on: 'codex' }, 'gpt-5.5')).toEqual({ codex_model: 'gpt-5.5' })
    expect(currentModel({ runs_on: 'codex', model: 'opus', codex_model: 'gpt-5.5' })).toBe('gpt-5.5')
    expect(modelsFor('codex')[0].id).toBe('gpt-5.6-sol')
  })

  it('filters the picker by label or id', () => {
    expect(filterModels(modelsFor('claude'), 'son').map((m) => m.id)).toEqual(['sonnet'])
    expect(filterModels(modelsFor('claude'), '')).toHaveLength(4)
  })
})
