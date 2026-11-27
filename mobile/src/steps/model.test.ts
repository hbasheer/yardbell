import { describe, expect, it } from 'vitest'
import type { ActionEvent } from '../dispatch/types'
import {
  StepEditError,
  approveLabel,
  badge,
  bodyBlocks,
  canEdit,
  diffRows,
  editNote,
  editedInput,
  isLong,
  memoryRows,
  outcomeOf,
  rejectLabel,
  startDraft,
  stepState,
  stepTitle,
  trail,
  whereLine
} from './model'

const step = (tool: string, input: Record<string, unknown>, fields: Partial<ActionEvent> = {}): ActionEvent => ({
  role: 'action',
  id: 'a1',
  tool,
  input,
  status: 'pending',
  by: 'dispatch',
  ...fields
})

describe('titles', () => {
  it.each([
    ['start_session', {}, 'Start a session'],
    ['send_to_session', {}, 'Type into a session'],
    ['stop_session', {}, 'Stop a session'],
    ['remove_worktree', {}, 'Remove a worktree'],
    ['integrate_branches', {}, 'Integrate branches'],
    ['push_branch', {}, 'Push a branch'],
    ['move_session', {}, 'Move a session'],
    ['call_connector', {}, 'Call a connected tool'],
    ['save_connector', {}, 'Save a connection'],
    ['remember', { change: 'add' }, 'Remember this'],
    ['remember', { change: 'replace' }, 'Change a memory'],
    ['remember', { change: 'forget' }, 'Forget a memory'],
    ['change_settings', { area: 'worktree_setup' }, 'Change Settings: Worktree setup'],
    ['change_settings', { area: 'unknown_area' }, 'Change Settings: unknown_area'],
    ['save_task', { name: 'Release notes' }, 'Save the task Release notes'],
    ['run_trigger', { name: 'Morning check' }, 'Run the trigger Morning check'],
    ['save_pipeline', { definition: { name: 'Nightly' } }, 'New pipeline: Nightly'],
    ['save_pipeline', { before: { version: 2 }, definition: { name: 'Nightly' } }, 'Change the pipeline Nightly'],
    ['set_pipeline_enabled', { on: true, name: 'Nightly' }, 'Turn on Nightly'],
    ['set_pipeline_enabled', { on: false, name: 'Nightly' }, 'Turn off Nightly'],
    ['run_pipeline', { name: 'Nightly' }, 'Run Nightly'],
    ['draw_diagram', { folder: 'app' }, 'Draw a diagram in app'],
    ['draw_diagram', {}, 'Draw a diagram in a folder'],
    ['answer_run', { action: 'retry', subject: 'PR 4' }, 'Retry PR 4'],
    ['answer_run', { action: 'continue_fail', subject: 'PR 4' }, 'Continue PR 4 as failed'],
    ['answer_run', { action: 'continue_pass', subject: 'PR 4' }, 'Continue PR 4 as passed'],
    ['something_new', {}, 'something_new']
  ])('%s %j is "%s"', (tool, input, title) => {
    expect(stepTitle(step(tool, input))).toBe(title)
  })

  it('names reviews and scans', () => {
    expect(stepTitle(step('start_session', {}, { review: { name: 'yardbell-2' } }))).toBe('Start a review')
    expect(stepTitle(step('start_session', {}, { review: { scan: 'security' } }))).toBe('Start a security scan')
    expect(stepTitle(step('start_session', {}, { review: { scan: 'dead_code' } }))).toBe('Start a dead code scan')
  })

  it('does not break on a missing input', () => {
    const bare = { ...step('save_task', {}), input: undefined } as unknown as ActionEvent
    expect(stepTitle(bare)).toBe('Save the task')
  })
})

describe('what can be edited', () => {
  it.each([
    ['start_session', {}, true],
    ['send_to_session', {}, true],
    ['save_task', {}, true],
    ['remember', { change: 'add' }, true],
    ['remember', { change: 'replace' }, true],
    ['remember', { change: 'forget' }, false],
    ['change_settings', {}, false],
    ['save_pipeline', {}, false],
    ['stop_session', {}, false],
    ['push_branch', {}, false],
    ['save_connector', {}, false],
    ['run_trigger', {}, false]
  ])('%s %j editable is %s', (tool, input, editable) => {
    expect(canEdit(step(tool, input))).toBe(editable)
  })
})

describe('buttons and badges', () => {
  it('labels the steps the person asked for in their own words', () => {
    expect(approveLabel(step('start_session', {}))).toBe('Approve')
    expect(approveLabel(step('start_session', {}, { by: 'you' }))).toBe('Start session')
    expect(approveLabel(step('send_to_session', {}, { by: 'you' }))).toBe('Send')
    expect(approveLabel(step('start_session', {}, { by: 'you', review: { name: 'x' } }))).toBe('Start review')
    expect(approveLabel(step('start_session', {}, { by: 'you', review: { scan: 'security' } }))).toBe('Start scan')
    expect(approveLabel(step('start_session', {}, { by: 'you', already: { text: 'Reviewed 10:02.' } }))).toBe('Review again')
    expect(rejectLabel(step('start_session', {}))).toBe('Reject')
    expect(rejectLabel(step('start_session', {}, { by: 'you' }))).toBe('Cancel')
  })

  it('maps status and result to a state and a badge', () => {
    expect(stepState(step('stop_session', {}))).toBe('pending')
    expect(stepState(step('stop_session', {}), 'approve')).toBe('running')
    expect(stepState(step('stop_session', {}, { status: 'approved' }))).toBe('running')
    expect(stepState(step('stop_session', {}, { status: 'approved', result: { ok: true, text: 'x' } }))).toBe('done')
    expect(stepState(step('stop_session', {}, { status: 'auto', result: { ok: false, text: 'x' } }))).toBe('failed')
    expect(stepState(step('stop_session', {}, { status: 'rejected' }))).toBe('rejected')
    expect(stepState(step('stop_session', {}, { status: 'withdrawn' }))).toBe('withdrawn')
    expect(badge(step('stop_session', {}), 'pending').label).toBe('Waiting for you')
    expect(badge(step('stop_session', {}, { by: 'you' }), 'pending').label).toBe('Not started')
    expect(badge(step('send_to_session', {}, { by: 'you' }), 'pending').label).toBe('Not sent')
    expect(badge(step('stop_session', {}, { by: 'you' }), 'rejected').label).toBe('Cancelled')
    expect(badge(step('stop_session', {}), 'rejected').label).toBe('Rejected')
    expect(badge(step('stop_session', {}), 'withdrawn').label).toBe('Withdrawn')
    expect(badge(step('stop_session', {}), 'failed')).toEqual({ label: 'Failed', tone: 'error' })
  })
})

describe('edited input', () => {
  it('rebuilds a start_session from the draft and drops what the step never had', () => {
    const original = step('start_session', { machine: 'hp', folder: 'yardbell', agent: 'claude', prompt: 'Fix it' })
    const draft = { ...startDraft(original), prompt: 'Fix it carefully', branch: '', new_branch: false, base: 'main' }
    expect(editedInput(original, draft)).toEqual({ machine: 'hp', folder: 'yardbell', agent: 'claude', prompt: 'Fix it carefully' })
  })

  it('keeps the base only when the branch is new', () => {
    const original = step('start_session', { machine: 'hp', folder: 'yardbell', prompt: 'x' })
    const next = editedInput(original, { ...startDraft(original), branch: 'fix', new_branch: true, base: 'main' })
    expect(next).toMatchObject({ branch: 'fix', new_branch: true, base: 'main' })
  })

  it('keeps an emptied field that the step had, so the server sees the change', () => {
    const original = step('start_session', { machine: 'hp', folder: 'yardbell', agent: 'codex', prompt: 'x' })
    expect(editedInput(original, { ...startDraft(original), agent: '' })).toMatchObject({ agent: '' })
  })

  it('edits only the text of send_to_session', () => {
    const original = step('send_to_session', { machine: 'hp', name: 'a-1', text: 'Run the specs.' })
    expect(startDraft(original)).toEqual({ text: 'Run the specs.' })
    expect(editedInput(original, { text: 'Run all of them.' })).toEqual({ machine: 'hp', name: 'a-1', text: 'Run all of them.' })
    expect(() => editedInput(original, { text: '  ' })).toThrow(StepEditError)
  })

  it('sends a saved task back without the old diff', () => {
    const original = step('save_task', { name: 'Fix', text: 'old', diff: [{ op: 'same', text: 'old' }], before: { version: 1 } })
    expect(editedInput(original, { text: 'new' })).toEqual({ name: 'Fix', text: 'new', before: { version: 1 } })
    expect(() => editedInput(original, { text: '' })).toThrow('A saved task needs some text.')
  })

  it('checks the memory entry length', () => {
    const original = step('remember', { change: 'add', entry: 'Prefers small PRs' })
    expect(editedInput(original, { entry: ' Prefers tiny PRs ' })).toEqual({ change: 'add', entry: 'Prefers tiny PRs' })
    expect(() => editedInput(original, { entry: 'x'.repeat(501) })).toThrow('at most 500 characters. This one is 501')
    expect(() => editedInput(original, { entry: '' })).toThrow(StepEditError)
  })
})

describe('what an edit changed', () => {
  it('names the fields against what was proposed', () => {
    const edited = step(
      'start_session',
      { machine: 'hp', folder: 'yardbell', agent: 'codex', prompt: 'new' },
      { status: 'edited', original: { machine: 'hp', folder: 'yardbell', agent: 'claude', prompt: 'old' } }
    )
    expect(editNote(edited)).toEqual({
      text: 'Edited before it ran: you changed the agent (was claude) and task.',
      proposed: 'old',
      proposedLabel: 'What Dispatch proposed'
    })
  })

  it('says nothing for a step that was not edited', () => {
    expect(editNote(step('send_to_session', { text: 'x' }))).toBeNull()
  })
})

describe('diff data', () => {
  it('turns parts into one row per line', () => {
    expect(diffRows([{ op: 'same', text: 'a' }, { op: 'del', text: 'b\nc' }, { op: 'add', text: 'd' }])).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'del', text: 'c' },
      { op: 'add', text: 'd' }
    ])
  })

  it('shrinks a long unchanged stretch to three lines either side of a change', () => {
    const long = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n')
    const rows = diffRows([{ op: 'same', text: long }, { op: 'add', text: 'new' }, { op: 'same', text: long }])
    expect(rows.map((r) => r.text)).toEqual(['…', '6', '7', '8', 'new', '1', '2', '3', '…'])
    expect(rows[0].op).toBe('gap')
    expect(rows.at(-1)?.op).toBe('gap')
  })

  it('keeps the lead of a first stretch off and the tail of a last stretch off', () => {
    const long = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n')
    expect(diffRows([{ op: 'same', text: long }, { op: 'del', text: 'x' }]).map((r) => r.text)).toEqual(['…', '6', '7', '8', 'x'])
    expect(diffRows([{ op: 'del', text: 'x' }, { op: 'same', text: long }]).map((r) => r.text)).toEqual(['x', '1', '2', '3', '…'])
  })

  it('builds a memory change as the removed and the added entry', () => {
    expect(memoryRows({ change: 'replace', old: 'a', entry: 'b' })).toEqual([{ op: 'del', text: 'a' }, { op: 'add', text: 'b' }])
    expect(memoryRows({ change: 'add', entry: 'b' })).toEqual([{ op: 'add', text: 'b' }])
    expect(memoryRows({ change: 'forget', old: 'a' })).toEqual([{ op: 'del', text: 'a' }])
  })

  it('shows a diff for settings and saved tasks, and says when nothing changes', () => {
    const changed = step('change_settings', { area: 'dispatch', diff: [{ op: 'del', text: '"ask"' }, { op: 'add', text: '"allow"' }] })
    expect(bodyBlocks(changed)[0]).toEqual({ kind: 'diff', rows: [{ op: 'del', text: '"ask"' }, { op: 'add', text: '"allow"' }] })
    const same = step('save_task', { name: 'x', text: 'y', diff: [{ op: 'same', text: 'y' }] })
    expect(bodyBlocks(same)[0]).toEqual({ kind: 'nochange' })
    const plain = step('save_task', { name: 'x', text: 'the text' })
    expect(bodyBlocks(plain)[0]).toEqual({ kind: 'mono', text: 'the text' })
  })

  it('treats a long task as long', () => {
    expect(isLong('short')).toBe(false)
    expect(isLong('x'.repeat(421))).toBe(true)
    expect(isLong('1\n2\n3\n4\n5\n6\n7')).toBe(true)
  })
})

describe('bodies', () => {
  it('summarises a pipeline by its steps and says it always waits', () => {
    const blocks = bodyBlocks(step('save_pipeline', { definition: { name: 'Nightly', steps: [{ name: 'Pull', kind: 'session' }, { name: 'Test', kind: 'command', command: 'cargo test' }] }, changes: { added: ['Test'] } }))
    expect(blocks).toContainEqual({ kind: 'list', items: ['Pull (session)', 'Test (command)'] })
    expect(blocks).toContainEqual({ kind: 'list', items: ['Steps added: Test.'] })
    expect(blocks).toContainEqual({ kind: 'code', text: 'cargo test' })
    expect(blocks.some((b) => b.kind === 'text' && b.text.includes('always waits'))).toBe(true)
  })

  it('shows the instructions of a review folded and the pull request it reads', () => {
    const blocks = bodyBlocks(step('start_session', { path: '/p', prompt: 'Look hard' }, { review: { name: 'a-1', pull: { number: 7, base: 'main' } } }))
    expect(blocks[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('pull request #7 against main') })
    expect(blocks[1]).toEqual({ kind: 'fold', summary: 'Instructions for the reviewer', text: 'Look hard' })
  })

  it('lists the branches of an integration in order', () => {
    const blocks = bodyBlocks(step('integrate_branches', { base: 'main', method: 'rebase', branches: ['a', 'b'] }))
    expect(blocks[0]).toEqual({ kind: 'label', text: 'Rebased in this order onto a new branch from main' })
    expect(blocks[1]).toEqual({ kind: 'list', items: ['a', 'b'] })
  })
})

describe('where, trail and outcome', () => {
  it('describes where a session starts', () => {
    expect(whereLine(step('start_session', { machine: 'hp', folder: 'yardbell', branch: 'fix', new_branch: true, base: 'main', agent: 'claude' }))).toBe(
      'hp · yardbell · fix new from main · claude'
    )
    expect(whereLine(step('start_session', { machine: 'hp', path: '/p' }))).toBe('hp · /p · the default agent')
  })

  it('builds the trail from who proposed it and what happened', () => {
    const waiting = trail(step('stop_session', {}, { by: 'client', from: 'Claude Code', rule: { action: 'stop_session' } }), 'pending')
    expect(waiting).toBe('Proposed by Claude Code · Your rule: stop sessions on any machine')
    expect(trail(step('stop_session', {}, { status: 'rejected', by: 'you' }), 'rejected')).toBe('You asked for this · Cancelled')
    expect(trail(step('stop_session', {}, { status: 'withdrawn' }), 'withdrawn')).toBe('Proposed by Dispatch · Withdrawn when you sent a new message')
    expect(trail(step('stop_session', {}, { status: 'auto' }), 'done')).toBe('Ran without asking')
    expect(trail(step('stop_session', {}, { rule: { action: 'start_session', machine: 'any', folder: 'app' } }), 'pending')).toContain('start sessions on any machine in app')
  })

  it('says what the step did', () => {
    const done = (tool: string, text: string, input: Record<string, unknown> = {}, extra: Partial<ActionEvent> = {}) =>
      step(tool, input, { status: 'approved', result: { ok: true, text }, ...extra })
    expect(outcomeOf(done('start_session', 'x', {}, { result: { ok: true, text: 'x', session: { machine: 'hp', name: 'a-3' } } }), 'done')).toEqual({
      tone: 'ok',
      text: 'Started a-3 on hp',
      session: { machine: 'hp', name: 'a-3' }
    })
    expect(outcomeOf(done('push_branch', '{"pushed":{"branch":"fix","remote":"origin"}}'), 'done')?.text).toBe('Pushed fix to origin')
    expect(outcomeOf(done('integrate_branches', '{"summary":"Stopped on a.rs","integrated":{"conflict":true}}'), 'done')).toEqual({ tone: 'warn', text: 'Stopped on a.rs' })
    expect(badge(done('integrate_branches', '{"integrated":{"conflict":true}}'), 'done').label).toBe('Stopped at a conflict')
    expect(outcomeOf(done('save_task', '{"version":3}'), 'done')?.text).toBe('Saved as version 3')
    expect(outcomeOf(done('remember', '', { change: 'forget' }), 'done')?.text).toBe('Forgotten')
    expect(outcomeOf(done('send_to_session', ''), 'done')?.text).toBe('Sent')
    expect(outcomeOf(done('stop_session', ''), 'done')?.text).toBe('Stopped')
    expect(outcomeOf(done('answer_run', '{"state":"waiting"}'), 'done')?.text).toBe('Still waiting')
    const failed = step('remove_worktree', {}, { status: 'auto', result: { ok: false, text: 'Uncommitted changes' } })
    expect(outcomeOf(failed, 'failed')).toEqual({ tone: 'error', text: 'Uncommitted changes' })
    expect(outcomeOf(step('stop_session', {}), 'pending')).toBeNull()
  })
})
