import { describe, expect, it } from 'vitest'
import type { ListedPipeline } from './api'
import { clock, type Definition, type Run, type Step } from './model'
import {
  addItem,
  briefLabel,
  canStart,
  clearEndedConfirm,
  deleteRunConfirm,
  diagramLabel,
  dropConfirm,
  heldText,
  historyRows,
  markRun,
  needBox,
  nextWords,
  nodeOrder,
  parseLimit,
  pipelineFeedRows,
  pipelineFeedSubtitle,
  reportParts,
  runChips,
  runHref,
  runNowForm,
  runPollMs,
  runStartBody,
  runTone,
  sortPipelines,
  stepFacts,
  stopSessionConfirm,
  tokenBar,
  transcriptParts,
  triggerIcon,
  waitingReason,
  waitingRuns
} from './screenModel'

const step = (id: string, name: string, next: Step['next'], extra: Record<string, unknown> = {}): Step => ({ id, name, kind: 'agent', next, ...extra })

const def: Definition = {
  id: 'p',
  name: 'P',
  version: 1,
  enabled: true,
  start: 'plan',
  trigger: { kind: 'manual' },
  steps: [
    step('orphan', 'Orphan', {}),
    step('plan', 'Plan', { pass: 'build' }),
    step('build', 'Build', { pass: 'cmd', fail: 'plan' }),
    step('cmd', 'Lint', { pass: 'wait', fail: 'build' }, { kind: 'command', command: 'make lint', approved: 'make lint' }),
    step('wait', 'Wait', { needs_you: 'plan' }, { kind: 'wait' })
  ]
}

const run = (fields: Partial<Run>): Run => ({ id: 'r', pipeline: 'p', state: 'running', step: 'plan', started: '2026-11-28T10:00:00Z', ...fields })

describe('runTone and polling', () => {
  it('names the tone from the state and a told hold', () => {
    expect(runTone({ state: 'waiting' })).toBe('wait')
    expect(runTone({ state: 'queued', held: { kind: 'memory', told: true } })).toBe('wait')
    expect(runTone({ state: 'queued', held: { kind: 'memory', told: false } })).toBe('run')
    expect(runTone({ state: 'done' })).toBe('ok')
    expect(runTone({ state: 'dropped' })).toBe('off')
  })

  it('polls a live run fast and an ended one slowly', () => {
    expect(runPollMs(undefined)).toBe(4000)
    expect(runPollMs({ state: 'running' })).toBe(4000)
    expect(runPollMs({ state: 'queued' })).toBe(4000)
    expect(runPollMs({ state: 'waiting' })).toBe(8000)
    expect(runPollMs({ state: 'done' })).toBe(30000)
  })
})

describe('lists', () => {
  const listed = (name: string, waiting = 0): ListedPipeline => ({ definition: { ...def, id: name, name }, runs: { waiting } })

  it('puts pipelines with waiting runs first, then by name', () => {
    expect(sortPipelines([listed('b'), listed('c', 1), listed('a')]).map((p) => p.definition.name)).toEqual(['c', 'a', 'b'])
  })

  it('maps trigger kinds to icons', () => {
    expect(triggerIcon(undefined)).toBe('manual')
    expect(triggerIcon('schedule')).toBe('schedule')
    expect(triggerIcon('gitlab_reviewer')).toBe('pull')
    expect(triggerIcon('github_review')).toBe('pull')
    expect(triggerIcon('linear')).toBe('ticket')
    expect(triggerIcon('connector')).toBe('ticket')
  })

  it('keeps runs that ask for the person and words their reason', () => {
    const runs = [run({ id: 'a', state: 'waiting', waiting: { kind: 'x', step: 'plan', reason: 'Plan needs you' } }), run({ id: 'b' }), run({ id: 'c', state: 'queued', held: { kind: 'memory', told: true, reason: 'hp is short of memory' } })]
    const waiting = waitingRuns(runs)
    expect(waiting.map((r) => r.id)).toEqual(['a', 'c'])
    expect(waiting.map(waitingReason)).toEqual(['Plan needs you', 'hp is short of memory'])
    expect(waitingReason({})).toBe('Waiting')
  })

  it('labels a brief run by its subject', () => {
    expect(briefLabel({ subject: { ticket: { id: 'YB-1', title: 'Fix it' } } })).toBe('YB-1 Fix it')
    expect(briefLabel({ subject: { pr: { number: 3, url: 'u', forge: 'gitlab' } } })).toBe('!3')
    expect(briefLabel({})).toBe('Run with no ticket or link')
  })

  it('takes marks from the newest live run, else the newest run', () => {
    expect(markRun([run({ id: 'a', state: 'done' }), run({ id: 'b', state: 'waiting' })])?.id).toBe('b')
    expect(markRun([run({ id: 'a', state: 'done' }), run({ id: 'b', state: 'dropped' })])?.id).toBe('a')
    expect(markRun([])).toBeNull()
  })

  it('orders nodes along the pass path, then the rest', () => {
    expect(nodeOrder(def).map((s) => s.id)).toEqual(['plan', 'build', 'cmd', 'wait', 'orphan'])
    expect(nextWords(def, def.steps[2])).toEqual(['On pass, Lint', 'On fail, Plan'])
    expect(nextWords(def, def.steps[4])).toEqual(['When it needs you, Plan'])
  })

  it('builds one Feed row per server with waiting runs', () => {
    const rows = pipelineFeedRows([
      { server: { id: 'a', machine: 'hp' }, state: { runs_waiting: 2 } },
      { server: { id: 'b', machine: 'mini' }, state: { runs_waiting: 0 } },
      { server: { id: 'c', machine: 'pro' } }
    ])
    expect(rows).toEqual([{ serverId: 'a', machine: 'hp', waiting: 2 }])
    expect(pipelineFeedSubtitle(rows[0], 1)).toBe('2 runs wait for you')
    expect(pipelineFeedSubtitle({ ...rows[0], waiting: 1 }, 2)).toBe('1 run waits for you · hp')
  })

  it('builds hrefs with the pipeline as a hint', () => {
    expect(runHref('http://h:1', 'r 1', 'p')).toBe('/pipelines/http%3A%2F%2Fh%3A1/run/r%201?p=p')
    expect(runHref('s', 'r')).toBe('/pipelines/s/run/r')
  })
})

describe('needBox', () => {
  it('offers an answer and every outcome for questions', () => {
    const box = needBox(
      run({ state: 'waiting', step: 'build', waiting: { kind: 'questions', step: 'build', reason: 'Build has questions for you' }, questions: [{ asked: 'Q1' }, { asked: 'Q2', answer: 'A' }] }),
      def
    )
    expect(box).toMatchObject({ title: 'Build has questions for you', reason: '', questions: ['Q1'], answerable: true, fail: true, pass: true, raise: null })
    expect(box.primary).toEqual({ action: 'retry', label: 'Retry step' })
  })

  it('puts the step name first when the reason does not start with it', () => {
    const box = needBox(run({ state: 'waiting', waiting: { kind: 'needs_you', step: 'plan', reason: 'pick a folder' } }), def)
    expect(box.title).toBe('Plan')
    expect(box.reason).toBe('pick a folder')
  })

  it('offers raising the limit and no outcomes for a token wait', () => {
    const box = needBox(run({ state: 'waiting', tokens_used: 5000, waiting: { kind: 'token_limit', step: 'build' } }), def)
    expect(box.raise).toEqual({ placeholder: '10,000' })
    expect(box.primary.label).toBe('Start this step anyway')
    expect(box.fail).toBe(false)
    expect(box.pass).toBe(false)
    expect(box.answerable).toBe(false)
    expect(needBox(run({ state: 'waiting', waiting: { kind: 'token_unknown', step: 'build' } }), def).raise).toBeNull()
  })

  it('accepts a changed tool and runs an unchanged step again', () => {
    expect(needBox(run({ state: 'waiting', waiting: { kind: 'tool_changed', step: 'build' } }), def).primary).toEqual({ action: 'accept-tool', label: 'Accept and run' })
    const unchanged = needBox(run({ state: 'waiting', waiting: { kind: 'unchanged', step: 'build' } }), def)
    expect(unchanged.primary.label).toBe('Run it again')
    expect(unchanged.help).toMatch(/^Yardbell did not start this step/)
  })

  it('hides continue on pass for a command that has not run', () => {
    const box = needBox(run({ state: 'waiting', waiting: { kind: 'failed', step: 'cmd' } }), def)
    expect(box.pass).toBe(false)
    expect(box.fail).toBe(true)
    expect(box.commandNote).toMatch(/has not run in this attempt/)
  })

  it('warns that continuing on pass overrides a failed command', () => {
    const box = needBox(run({ state: 'waiting', waiting: { kind: 'failed', step: 'cmd' }, steps: { cmd: { ran: { command: 'make lint', passed: false } } } }), def)
    expect(box.pass).toBe(true)
    expect(box.commandNote).toMatch(/records that you overrode it/)
  })

  it('reads a token limit typed with separators', () => {
    expect(parseLimit('500,000')).toBe(500000)
    expect(parseLimit('0')).toBeNull()
    expect(parseLimit('abc')).toBeNull()
  })
})

describe('tokenBar', () => {
  it('shows nothing when there is no use, unknown or limit', () => {
    expect(tokenBar(run({}))).toBeNull()
  })

  it('colours the bar by how much of the limit is used', () => {
    expect(tokenBar(run({ tokens: { limit: 1000 }, tokens_used: 500 }))).toMatchObject({ total: '500 tokens', limit: 'Limit 1,000', pct: 50, tone: 'ok', pastLimit: false })
    expect(tokenBar(run({ tokens: { limit: 1000 }, tokens_used: 850 }))?.tone).toBe('warn')
    expect(tokenBar(run({ tokens: { limit: 1000 }, tokens_used: 1200 }))).toMatchObject({ pct: 100, tone: 'over', pastLimit: true })
    expect(tokenBar(run({ state: 'done', tokens: { limit: 1000 }, tokens_used: 1200 }))?.pastLimit).toBe(false)
  })

  it('says when the total is a floor and what came from cache', () => {
    const bar = tokenBar(run({ tokens: { unknown: { build: 'Codex does not report tokens' } }, tokens_used: 10, tokens_from_cache: 2000 }))
    expect(bar).toMatchObject({ total: 'At least 10 tokens', limit: 'No limit', pct: null, unknown: ['Codex does not report tokens, so the real total may be higher.'], cache: '2,000 more were read from cache and are not counted.' })
    expect(tokenBar(run({ tokens: { unknown: { a: 'x' } } }))?.total).toBe('Not known')
  })
})

describe('run detail', () => {
  it('words a hold', () => {
    expect(heldText(run({}))).toBeNull()
    expect(heldText(run({ held: { kind: 'spacing', reason: 'next start soon' } }))).toEqual({ reason: 'next start soon', help: null, plain: true })
    const told = heldText(run({ held: { kind: 'memory', machine: 'hp', reason: 'hp is short of memory', since: '2026-11-28T09:00:00Z', told: true } }))
    expect(told?.help).toBe(`Held since ${clock('2026-11-28T09:00:00Z')}. It still starts by itself. To start it sooner, free memory on hp or raise the limit in the Pipelines settings, or stop this run.`)
  })

  it('lists chips for the ticket, pull request, draft, conversation and place', () => {
    const chips = runChips(
      run({
        subject: { ticket: { id: 'YB-1', url: 'https://t/1' }, pr: { number: 9, url: 'https://g/9', forge: 'gitlab' } },
        pull: { number: 4, url: 'https://p/4' },
        conversation: 'c1',
        place: { machine: 'hp', branch: 'b' }
      })
    )
    expect(chips).toEqual([
      { kind: 'ticket', label: 'YB-1', url: 'https://t/1' },
      { kind: 'pr', label: '!9', url: 'https://g/9' },
      { kind: 'draft', label: 'Draft #4', url: 'https://p/4' },
      { kind: 'conversation', label: 'Conversation', id: 'c1' },
      { kind: 'place', label: 'hp · b' }
    ])
  })

  it('folds a report longer than three lines after two', () => {
    expect(reportParts('a\nb\nc')).toEqual({ head: 'a\nb\nc', rest: '' })
    expect(reportParts('a\nb\nc\nd')).toEqual({ head: 'a\nb', rest: 'c\nd' })
  })

  it('words history entries as the web does', () => {
    const rows = historyRows(
      run({
        state: 'waiting',
        history: [
          { at: '1', note: 'started by you' },
          { at: '2', step: 'plan', outcome: 'pass' },
          { at: '3', step: 'build', outcome: 'fail', note: 'tests failed' },
          { at: '4', step: 'plan' },
          { at: '5', step: 'build' }
        ]
      }),
      def
    )
    expect(rows.map((r) => [r.tone, r.name, r.word, r.note])).toEqual([
      ['run', 'Run', 'started by you', ''],
      ['ok', 'Plan', 'passed', ''],
      ['fail', 'Build', 'failed', 'tests failed'],
      ['step', 'Plan', 'ended without a result', ''],
      ['step', 'Build', 'waiting for you', '']
    ])
    expect(historyRows(run({ history: [{ at: '1', step: 'plan', outcome: 'pass' }, { at: '2', step: 'build' }] }), def, 'plan')).toEqual([{ at: '1', tone: 'ok', name: '', word: 'passed', note: '' }])
  })

  it('lists the facts a step has', () => {
    const r = run({ steps: { plan: { outcome: 'pass', started: '2026-11-28T10:00:00Z', ended: '2026-11-28T10:05:00Z', runs: 2, machine: 'hp', session: 'plan-1' } } })
    const facts = stepFacts(r, def.steps[1], { note: '', cls: 'done' })
    expect(facts.map((f) => f.name)).toEqual(['Outcome', 'Last started', 'Last ended', 'Took', 'Ran', 'Machine', 'Session'])
    expect(facts.find((f) => f.name === 'Took')?.value).toBe('5 min')
    expect(facts.find((f) => f.name === 'Ran')?.value).toBe('2 times')
    expect(stepFacts(r, def.steps[2], { note: '', cls: '' })).toEqual([])
  })

  it('groups tool calls that follow each other', () => {
    const parts = transcriptParts([
      { kind: 'prompt', text: 'go' },
      { kind: 'tool', name: 'a' },
      { kind: 'tool', name: 'b' },
      { kind: 'agent', text: 'done' },
      { kind: 'tool', name: 'c' }
    ])
    expect(parts.map((p) => (p.kind === 'tools' ? p.list.map((t) => t.name).join('+') : p.kind))).toEqual(['prompt', 'a+b', 'agent', 'c'])
  })
})

describe('confirms', () => {
  it('uses the web wording for delete, clear and stop session', () => {
    const r = run({ state: 'done', sessions_left: [{ name: 'impl-1', machine: 'hp' }] })
    const del = deleteRunConfirm(r)
    expect(del.title).toBe('Delete this run?')
    expect(del.body).toMatch(/^Its record goes: the step results, reports and history shown here\.\nBranches/)
    expect(del.body).toContain('impl-1 on hp')
    expect(clearEndedConfirm([r]).title).toBe('Delete 1 finished run?')
    expect(clearEndedConfirm([r, r]).body).toMatch(/^Their records go/)
    expect(stopSessionConfirm({ name: 's', current: true })).toEqual({ title: 'Stop s?', body: 'The agent in it stops. The step then waits for you.', confirm: 'Stop session' })
    expect(stopSessionConfirm({ name: 's' }).body).toBe('The agent in it stops.')
  })

  it('says drop for a waiting run and stop for a live one', () => {
    expect(dropConfirm({ state: 'waiting' }).confirm).toBe('Drop')
    expect(dropConfirm({ state: 'running' }).title).toBe('Stop this run?')
  })
})

describe('run now', () => {
  it('asks for what the trigger needs', () => {
    expect(runNowForm('schedule').kind).toBe('none')
    expect(runNowForm('webhook')).toEqual({ kind: 'none', message: 'Starts one run with no item.' })
    expect(runNowForm('manual')).toMatchObject({ kind: 'items', required: false, diagrams: true })
    expect(runNowForm('linear')).toMatchObject({ label: 'Ticket ids', required: true, tickets: true })
    expect(runNowForm('connector')).toMatchObject({ label: 'Item ids or links' })
    expect(runNowForm('gitlab_reviewer')).toMatchObject({ label: 'Merge or pull request links', required: true })
  })

  it('needs items only when the trigger needs them', () => {
    expect(canStart(runNowForm('linear'), ' ')).toBe(false)
    expect(canStart(runNowForm('linear'), 'YB-1')).toBe(true)
    expect(canStart(runNowForm('manual'), '')).toBe(true)
    expect(canStart(runNowForm('schedule'), '')).toBe(true)
  })

  it('splits tickets from links and adds a diagram', () => {
    expect(runStartBody('schedule', 'x', null)).toEqual({})
    expect(runStartBody('linear', 'YB-1, https://github.com/a/b/pull/2', null)).toEqual({ tickets: ['YB-1'], prs: ['https://github.com/a/b/pull/2'] })
    const diagram = { machine: 'hp', folder: 'app', dir: 'login-flow-20261101-101010' }
    expect(runStartBody('manual', '', diagram)).toEqual({ tickets: [], prs: [], diagram })
    expect(diagramLabel(diagram)).toBe('login flow, app on hp')
  })

  it('adds a picked ticket once', () => {
    expect(addItem('', 'YB-1')).toBe('YB-1')
    expect(addItem('YB-1, YB-2', 'YB-3')).toBe('YB-1 YB-2 YB-3')
    expect(addItem('yb-1', 'YB-1')).toBe('yb-1')
  })
})
