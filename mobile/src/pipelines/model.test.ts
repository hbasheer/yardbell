import { describe, expect, it } from 'vitest'
import {
  ago,
  asksForYou,
  countsWord,
  describe as describeStep,
  flow,
  nodeState,
  splitRunItems,
  staying,
  stateWord,
  took,
  triggerWords,
  type ConnectorInfo,
  type Definition,
  type Run,
  type Step
} from './model'

const step = (id: string, name: string, next: Step['next'], extra: Record<string, unknown> = {}): Step => ({
  id,
  name,
  kind: 'agent',
  next,
  ...extra
})

const def: Definition = {
  id: 'p',
  name: 'P',
  version: 1,
  enabled: true,
  start: 'plan',
  trigger: { kind: 'manual' },
  steps: [
    step('plan', 'Plan', { pass: 'build' }),
    step('build', 'Build', { pass: 'review', fail: 'plan' }),
    step('review', 'Review', { pass: 'push', fail: 'build' }),
    step('push', 'Push', {}, { kind: 'push' }),
    step('orphan', 'Orphan', {})
  ]
}

const run = (over: Partial<Run>): Run => ({ id: 'r1', pipeline: 'p', state: 'running', step: 'build', started: '2026-11-01T10:00:00Z', ...over })

const NOW = Date.parse('2026-11-01T12:00:00Z')

describe('asksForYou', () => {
  it('is true for waiting runs and queued runs held with a told notice', () => {
    expect(asksForYou({ state: 'waiting' })).toBe(true)
    expect(asksForYou({ state: 'queued', held: { kind: 'memory', told: true } })).toBe(true)
  })

  it('is false for the rest', () => {
    expect(asksForYou({ state: 'queued', held: { kind: 'memory' } })).toBe(false)
    expect(asksForYou({ state: 'queued' })).toBe(false)
    expect(asksForYou({ state: 'running', held: { kind: 'memory', told: true } })).toBe(false)
    expect(asksForYou({ state: 'done' })).toBe(false)
  })
})

describe('flow', () => {
  it('follows the pass line and marks a fail line back to an earlier step as a loop', () => {
    expect(flow(def)).toEqual([
      { name: 'Plan', loop: '' },
      { name: 'Build', loop: 'Plan' },
      { name: 'Review', loop: 'Build' },
      { name: 'Push', loop: '' }
    ])
  })

  it('stops at a cycle and at a pass line to a step that is not there', () => {
    const cyclic: Definition = { ...def, steps: [step('a', 'A', { pass: 'b' }), step('b', 'B', { pass: 'a' })], start: 'a' }
    expect(flow(cyclic).map((s) => s.name)).toEqual(['A', 'B'])
    expect(flow({ ...def, start: 'missing' })).toEqual([])
  })
})

describe('time words', () => {
  it('ago counts minutes, hours and days', () => {
    expect(ago('2026-11-01T11:59:40Z', NOW)).toBe('just now')
    expect(ago('2026-11-01T11:15:00Z', NOW)).toBe('45 min')
    expect(ago('2026-11-01T09:00:00Z', NOW)).toBe('3 h')
    expect(ago('2026-10-29T12:00:00Z', NOW)).toBe('3 d')
    expect(ago(undefined, NOW)).toBe('')
    expect(ago('nonsense', NOW)).toBe('')
  })

  it('took spans seconds, minutes and hours', () => {
    expect(took('2026-11-01T10:00:00Z', '2026-11-01T10:00:42Z')).toBe('42 s')
    expect(took('2026-11-01T10:00:00Z', '2026-11-01T10:07:00Z')).toBe('7 min')
    expect(took('2026-11-01T10:00:00Z', '2026-11-01T12:05:00Z')).toBe('2 h 5 min')
    expect(took('2026-11-01T10:00:00Z', '2026-11-01T09:00:00Z')).toBe('')
  })
})

describe('stateWord', () => {
  const stamp = new Date(Date.now() - 5 * 60000).toISOString()

  it('says what a run is doing at its step', () => {
    expect(stateWord(run({ state: 'waiting', step_since: stamp }), def)).toBe('Waiting for you at Build · 5 min')
    expect(stateWord(run({ state: 'running', step_since: stamp }), def)).toBe('Build · 5 min')
    expect(stateWord(run({ state: 'queued' }), def)).toBe('Build, queued')
    expect(stateWord(run({ state: 'dropped' }), def)).toBe('Dropped')
  })

  it('names why a queued run is held', () => {
    expect(stateWord(run({ state: 'queued', held: { kind: 'memory', machine: 'hp' } }), def)).toBe('Build, held · hp is short of memory')
    expect(stateWord(run({ state: 'queued', held: { kind: 'settling', machine: 'hp' } }), def)).toBe(
      'Build, held · hp is back under its memory limit, waiting two minutes'
    )
    expect(stateWord(run({ state: 'queued', held: { kind: 'spacing' } }), def)).toBe(
      'Build, held · next start on this machine is within a minute'
    )
  })

  it('falls back to the step id and says Done with a time', () => {
    expect(stateWord(run({ state: 'queued', step: 'gone' }), def)).toBe('gone, queued')
    expect(stateWord(run({ state: 'done', history: [{ at: '2026-11-01T10:30:00Z' }] }), def)).toMatch(/^Done .+/)
  })
})

describe('nodeState', () => {
  it('shows nothing without a run', () => {
    expect(nodeState(null, def.steps[0])).toEqual({ cls: '', mark: '', note: '' })
  })

  it('marks the waiting step, trimming its own name from the reason', () => {
    const r = run({ state: 'waiting', waiting: { kind: 'unchanged', step: 'build', reason: 'Build did not change anything' } })
    expect(nodeState(r, def.steps[1])).toEqual({ cls: 'waiting', mark: '!', note: 'did not change anything' })
    const needs = run({ state: 'waiting', waiting: { kind: 'needs_you', step: 'build', reason: 'Build wants you' } })
    expect(nodeState(needs, def.steps[1]).note).toBe('needs you')
    expect(nodeState(run({ state: 'waiting' }), def.steps[1]).note).toBe('waiting')
  })

  it('marks the current step as running, queued or held, and shows a CI watch', () => {
    const stamp = new Date(Date.now() - 2 * 60000).toISOString()
    expect(nodeState(run({ step_since: stamp }), def.steps[1])).toEqual({ cls: 'now', mark: '', note: 'running · 2 min' })
    expect(nodeState(run({ state: 'queued' }), def.steps[1]).note).toBe('queued')
    expect(nodeState(run({ state: 'queued', held: { kind: 'memory' } }), def.steps[1]).note).toBe('held')
    const checks = step('ci', 'CI', {}, { kind: 'checks' })
    const watching = run({ step: 'ci', step_since: stamp, steps: { ci: { watch: { status: 'pending' } } } })
    expect(nodeState(watching, checks)).toEqual({ cls: 'now', mark: '', note: 'pending · 2 min' })
  })

  it('reports finished steps with their run count and a missing report', () => {
    const r = run({
      step: 'push',
      steps: {
        plan: { outcome: 'pass', report: 'planned' },
        build: { outcome: 'pass', runs: 3 },
        review: { outcome: 'fail' }
      }
    })
    expect(nodeState(r, def.steps[0])).toEqual({ cls: 'done', mark: '✓', note: 'passed' })
    expect(nodeState(r, def.steps[1])).toEqual({ cls: 'done', mark: '✓', note: 'passed · 3 runs · no report' })
    expect(nodeState(r, def.steps[2])).toEqual({ cls: 'failed', mark: '✗', note: 'failed' })
  })

  it('says a step the run has not reached is not reached', () => {
    expect(nodeState(run({}), def.steps[3])).toEqual({ cls: 'later', mark: '', note: 'not reached' })
  })
})

describe('triggerWords', () => {
  const connectors: ConnectorInfo[] = [
    { id: 'jira', name: 'Jira', params: [{ name: 'project', label: 'Project', filter: true }, { name: 'tag', filter: false }] }
  ]

  it('describes each trigger the web does', () => {
    expect(triggerWords(undefined)).toBe('By hand, from Run now')
    expect(triggerWords({ kind: 'manual' })).toBe('By hand, from Run now')
    expect(triggerWords({ kind: 'schedule', schedule: 'every weekday at 08:00' })).toBe('On the schedule every weekday at 08:00')
    expect(triggerWords({ kind: 'schedule' })).toBe('On the schedule (not set)')
    expect(triggerWords({ kind: 'schedule', schedule: 'daily', state: 'Todo' })).toBe('On the schedule daily, my open tickets in Todo')
    expect(triggerWords({ kind: 'webhook' })).toBe("When another system calls this pipeline's web address")
    expect(triggerWords({ kind: 'github_review' })).toBe('When someone asks me to review a GitHub pull request')
    expect(triggerWords({ kind: 'gitlab_reviewer', host: 'gitlab.acme.dev' })).toBe(
      'When a GitLab merge request on gitlab.acme.dev adds me as reviewer'
    )
    expect(triggerWords({ kind: 'gitlab_reviewer' })).toBe('When a GitLab merge request on a host you pick adds me as reviewer')
  })

  it('describes Linear triggers with states and filters', () => {
    expect(triggerWords({ kind: 'linear' })).toBe('When a Linear ticket is assigned to me')
    expect(triggerWords({ kind: 'linear', states: ['Todo', 'Doing'], assigned: true })).toBe(
      'When a Linear ticket of mine moves to Todo or Doing'
    )
    expect(triggerWords({ kind: 'linear', filter: { labels: ['bug'], teams: ['App'], projects: ['X', 'Y'] } })).toBe(
      'When a Linear ticket is assigned to me, label bug, team App, project X or Y'
    )
  })

  it('names connectors and their chosen filters', () => {
    expect(triggerWords({ kind: 'connector', connector: 'jira', params: { project: 'ENG', tag: 'x' }, states: ['Open'] }, connectors)).toBe(
      'When Jira has a new item in the states you picked, filtered by project'
    )
    expect(triggerWords({ kind: 'connector', connector: 'other' }, connectors)).toBe('When other has a new item')
    expect(triggerWords({ kind: 'connector' })).toBe('When a connected tool has a new item')
    expect(triggerWords({ kind: 'schedule', schedule: 'daily', state: 'Open', connector: 'jira' }, connectors)).toBe(
      'On the schedule daily, my open Jira items in Open'
    )
  })
})

describe('describe', () => {
  it('writes who, what and tags for each step kind', () => {
    expect(describeStep(step('a', 'A', {}, { instructions: 'Fix it', read_only: true, machine: { same_as: 'plan' }, workspace: { kind: 'copy', from: 'plan' } }))).toEqual({
      who: 'Agent · read only',
      does: 'Fix it',
      tags: ['same machine as plan', 'copy of plan']
    })
    expect(describeStep(step('a', 'A', {}))).toEqual({ who: 'Agent', does: 'No instructions yet', tags: ['any machine', 'new worktree'] })
    expect(describeStep(step('a', 'A', {}, { kind: 'plan', machines: ['hp', 'mini'] })).tags).toEqual(['hp or mini'])
    expect(describeStep(step('a', 'A', {}, { kind: 'checks', require_approval: true }))).toEqual({
      who: 'Yardbell',
      does: 'Waits for CI to pass and an approval, then follows pass or fail',
      tags: ['no agent', 'needs approval']
    })
    expect(describeStep(step('a', 'A', {}, { kind: 'update', action: 'move', state: 'Done' })).does).toBe('Moves the ticket to Done')
    expect(describeStep(step('a', 'A', {}, { kind: 'command', command: 'make', approved: 'other' })).tags).toEqual(['Not approved yet'])
    expect(describeStep(step('a', 'A', {}, { kind: 'command', command: 'make', approved: 'make' })).tags).toEqual(['Exit code decides'])
    expect(describeStep(step('a', 'A', {}, { kind: 'wait', message: 'Check the staging site' })).does).toBe('Check the staging site')
    expect(describeStep(step('a', 'A', {}, { kind: 'nothing' }))).toEqual({ who: '', does: '', tags: [] })
  })

  it('looks a connected call up in the connectors', () => {
    const connectors: ConnectorInfo[] = [{ id: 'jira', name: 'Jira', calls: [{ name: 'search', kind: 'lookup' }] }]
    expect(describeStep(step('a', 'A', {}, { kind: 'call', connector: 'jira', call: 'search' }), connectors)).toEqual({
      who: 'Yardbell · Jira',
      does: 'Calls search',
      tags: ['Reads']
    })
    expect(describeStep(step('a', 'A', {}, { kind: 'tool', server: 'fs', tool: 'write', call_kind: 'change' }))).toEqual({
      who: 'Yardbell · fs',
      does: 'Calls write',
      tags: ['Changes']
    })
  })
})

describe('countsWord', () => {
  it('lists the non-zero counts', () => {
    expect(countsWord({ running: 1, waiting: 2, held: 1, done: 9 })).toBe('1 running · 2 waiting · 1 held a long time · 9 done')
    expect(countsWord({})).toBe('No runs yet')
  })
})

describe('splitRunItems', () => {
  it('splits links into pull requests and the rest into tickets', () => {
    expect(splitRunItems('linear', 'ENG-1, ENG-2 https://github.com/a/b/pull/3')).toEqual({
      tickets: ['ENG-1', 'ENG-2'],
      prs: ['https://github.com/a/b/pull/3']
    })
    expect(splitRunItems('manual', '  ')).toEqual({ tickets: [], prs: [] })
  })

  it('sends everything as items for a connector pipeline', () => {
    expect(splitRunItems('connector', 'https://x/1 7')).toEqual({ tickets: ['https://x/1', '7'], prs: [] })
  })
})

describe('staying', () => {
  it('always says what stays and names worktrees and open sessions', () => {
    const text = staying([
      { steps: { build: { made: 'wt-1', machine: 'hp' } }, sessions_left: [{ name: 'yb-1', machine: 'hp' }] },
      { steps: { build: { made: 'wt-1', machine: 'hp' } } }
    ])
    expect(text).toContain('stay.')
    expect(text).toContain('This worktree stays on disk: wt-1 on hp.')
    expect(text).toContain('This session is still open and stays open: yb-1 on hp. Stop it from the dashboard')
    expect(staying([{}])).toBe('Branches, pushed commits, pull and merge requests, Dispatch conversations and the agents’ transcripts stay.')
  })
})
