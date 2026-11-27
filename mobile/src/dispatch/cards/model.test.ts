import { describe, expect, it } from 'vitest'
import type { ActionEvent, GroupEvent, PullEvent, ResultsEvent, ReviewEvent, SessionEvent } from '../types'
import {
  childNote,
  childState,
  decidedWords,
  defaultPicked,
  findingGroups,
  firstError,
  groupBadge,
  groupGather,
  isLate,
  optionLabel,
  pendingSteps,
  pickedOf,
  pullKind,
  readable,
  resultBadge,
  resultsHead,
  screenView,
  sentNote,
  serverTime,
  sessionBadge,
  settleAction,
  triggerLine,
  triggerStanding
} from './model'

const step = (fields: Partial<ActionEvent> = {}): ActionEvent => ({ role: 'action', id: 's1', tool: 'start_session', input: {}, status: 'pending', ...fields })
const pull = (fields: Partial<PullEvent> = {}): PullEvent => ({ role: 'pull', kind: 'ci', machine: 'hp', name: 'a', ...fields })

describe('session text', () => {
  it('cuts an option label at the preview box', () => {
    expect(optionLabel('1. Yes   ┌──────┐ preview')).toBe('1. Yes')
    expect(optionLabel('Plain label')).toBe('Plain label')
  })

  it('drops rules and the common left margin', () => {
    const screen = '────────\n   │ Do you want to proceed? │\n   │   1. Yes │\n────────'
    expect(readable(screen)).toBe('│ Do you want to proceed?\n│   1. Yes')
  })

  it('shows the last four lines until opened', () => {
    const screen = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n')
    expect(screenView(screen, false)).toEqual({ text: 'c\nd\ne\nf', total: 6, long: true })
    expect(screenView(screen, true).text).toBe('a\nb\nc\nd\ne\nf')
    expect(screenView('a\nb', false).long).toBe(false)
  })

  it('badges a blocked, answered and ended session', () => {
    const base: SessionEvent = { role: 'session', machine: 'hp', name: 'a', state: 'blocked' }
    expect(sessionBadge(base).label).toBe('Waiting for you')
    expect(sessionBadge({ ...base, answer: { key: '1', label: 'Yes' } }).label).toBe('Answered')
    expect(sessionBadge({ ...base, state: 'ended' }).label).toBe('Ended')
  })
})

describe('pull cards', () => {
  it('names each kind', () => {
    expect(pullKind(pull()).label).toBe('CI failed')
    expect(pullKind(pull({ kind: 'conflict' })).label).toBe('Merge conflicts')
    expect(pullKind(pull({ kind: 'limit' })).label).toBe('Limit reset')
    expect(pullKind(pull({ kind: 'comments', notes: [{ kind: 'changes_requested' }] })).label).toBe('Changes requested')
    expect(pullKind(pull({ kind: 'comments', notes: [{ kind: 'inline' }] })).label).toBe('New comments')
  })

  it('finds the line of a log that says what broke', () => {
    expect(firstError('compiling\nerror[E0425]: cannot find value\nmore')).toBe('error[E0425]: cannot find value')
    expect(firstError('one\ntwo')).toBe('one')
  })

  it('tracks what happened to the step that was sent', () => {
    const card = pull({ sent: { step: 's1' } })
    expect(sentNote(card, null, true)?.text).toBe('Sending…')
    expect(sentNote(pull(), null, false)).toBeNull()
    expect(sentNote(card, undefined, false)?.text).toBe('Sent to the session.')
    expect(sentNote(card, step(), false)?.text).toBe('Waiting for your approval below.')
    expect(sentNote(card, step({ status: 'rejected' }), false)).toMatchObject({ text: '', again: true })
    expect(sentNote(card, step({ status: 'withdrawn' }), false)?.again).toBe(true)
    expect(sentNote(card, step({ status: 'approved', result: { ok: false, text: 'hp is down' } }), false)).toMatchObject({ text: 'Not sent: hp is down', tone: 'error' })
    expect(sentNote(card, step({ status: 'approved', result: { ok: true, text: 'Sent' } }), false)?.text).toBe('Sent.')
  })
})

describe('group cards', () => {
  const group: GroupEvent = { role: 'group', id: 'g', title: 'T', status: 'running', children: [{ label: 'a', step: 's1' }, { label: 'b', step: 's2' }] }
  const live = (activity: 'active' | 'blocked' | 'idle' | null) => () => activity

  it('classifies a child by its step', () => {
    expect(childState({ label: 'x', refused: 'no rule' }, undefined, false).key).toBe('refused')
    expect(childState({ label: 'x' }, undefined, false).key).toBe('lost')
    expect(childState({ label: 'x', step: 's' }, step(), false).key).toBe('pending')
    expect(childState({ label: 'x', step: 's' }, step(), true).key).toBe('starting')
    expect(childState({ label: 'x', step: 's' }, step({ status: 'approved' }), false).key).toBe('starting')
    expect(childState({ label: 'x', step: 's' }, step({ status: 'rejected' }), false).key).toBe('rejected')
    expect(childState({ label: 'x', step: 's' }, step({ status: 'withdrawn' }), false).key).toBe('withdrawn')
    expect(childState({ label: 'x', step: 's' }, step({ status: 'approved', result: { ok: false, text: 'boom' } }), false).key).toBe('failed')
  })

  it('reads a started child from the live session, then from what the server last saw', () => {
    const started = step({ status: 'approved', result: { ok: true, text: 'ok', session: { machine: 'hp', name: 'a-1' } } })
    expect(childState({ label: 'x' }, started, false, live('active')).badge.label).toBe('Working')
    expect(childState({ label: 'x' }, started, false, live('blocked')).badge.label).toBe('Needs you')
    expect(childState({ label: 'x', worked: true }, started, false, live('idle')).badge.label).toBe('Done')
    expect(childState({ label: 'x' }, started, false, live('idle')).badge.label).toBe('Idle')
    expect(childState({ label: 'x', state: 'ended' }, started, false, live(null)).key).toBe('ended')
    expect(childState({ label: 'x' }, started, false).badge.label).toBe('Started')
  })

  it('explains a refused or failed child', () => {
    const refused = { label: 'x', refused: 'your rule refuses it' }
    expect(childNote(refused, childState(refused, undefined, false))?.text).toBe('Not started: your rule refuses it.')
    const failed = step({ status: 'approved', result: { ok: false, text: 'no room' } })
    expect(childNote({ label: 'x' }, childState({ label: 'x' }, failed, false))).toEqual({ text: 'no room', tone: 'error' })
  })

  it('summarises the group', () => {
    const waiting = group.children.map(() => childState({ label: 'x' }, step(), false))
    expect(groupBadge(group, waiting).label).toBe('Waiting for you')
    expect(groupBadge(group, [waiting[0], childState({ label: 'x' }, undefined, false)]).label).toBe('1 wait for you')
    expect(groupBadge({ ...group, status: 'gathered' }, []).label).toBe('Results below')
    expect(groupBadge({ ...group, status: 'dropped' }, []).label).toBe('Nothing started')
    expect(groupBadge(group, []).label).toBe('Starting')
    expect(pendingSteps(waiting)).toHaveLength(2)
  })

  it('says when Dispatch hears the results', () => {
    expect(groupGather(group)).toBe('Dispatch hears the results with your next message.')
    expect(groupGather({ ...group, gather: 'merge them' })).toBe('Dispatch hears the results with your next message, then: merge them.')
    expect(groupGather({ ...group, gather: 'merge them', follow: true })).toBe('Then Dispatch acts on the results: merge them.')
  })
})

describe('results cards', () => {
  it('badges each child', () => {
    expect(resultBadge({ label: 'x' }).label).toBe('Did not start')
    expect(resultBadge({ label: 'x', started: true, result: { status: 'done' } }).label).toBe('Done')
    expect(resultBadge({ label: 'x', started: true, result: { status: 'partial' } }).label).toBe('Partly done')
    expect(resultBadge({ label: 'x', started: true, state: 'needs input' }).label).toBe('Needs you')
    expect(resultBadge({ label: 'x', started: true, state: 'still working' }).label).toBe('Still working')
    expect(resultBadge({ label: 'x', started: true }).label).toBe('No result')
  })

  it('heads a finished and a timed out card', () => {
    const done: ResultsEvent = { role: 'results', group: 'g', title: 'Fix', children: [{ label: 'a', started: true }, { label: 'b', started: true }] }
    expect(resultsHead(done)).toMatchObject({ title: 'Results of Fix', summary: 'Both sessions are done', timedOut: false })
    const late: ResultsEvent = { ...done, why: 'timeout', minutes: 120, children: [{ label: 'a', started: true, result: { status: 'done' } }, { label: 'b', started: true }, { label: 'c' }] }
    expect(resultsHead(late).summary).toBe('Gathered after 2 hours, 1 of 2 sessions finished')
    expect(resultsHead(late).badge.label).toBe('Timed out')
  })
})

describe('review cards', () => {
  const findings = [
    { severity: 'low', text: 'nit' },
    { severity: 'high', text: 'leak' },
    { severity: 'medium', text: 'slow' },
    { severity: 'info', text: 'other' }
  ]
  const review: ReviewEvent = { role: 'review', machine: 'hp', name: 'rev-1', of: { name: 'work-1', branch: 'fix' }, verdict: 'changes', findings }

  it('groups findings worst first and keeps their stored positions', () => {
    const groups = findingGroups(findings)
    expect(groups.map((g) => g.label)).toEqual(['High', 'Medium', 'Low', 'Other'])
    expect(groups[0].items[0]).toMatchObject({ index: 1, finding: { text: 'leak' } })
  })

  it('starts with everything but the low findings ticked', () => {
    expect(defaultPicked(findings)).toEqual([1, 2, 3])
    expect(pickedOf(review, undefined)).toEqual([1, 2, 3])
    expect(pickedOf(review, [0])).toEqual([0])
    expect(pickedOf({ ...review, outcome: { decision: 'sent', findings: [2] } }, [0])).toEqual([2])
  })

  it('sends a review to its own session and a scan to the picked session or a new one', () => {
    expect(settleAction(review, [2, 1], '')).toEqual({ label: 'Send 2 findings', body: { decision: 'send', findings: [1, 2] } })
    const scan: ReviewEvent = { ...review, of: { scan: 'dead_code', path: '/home/dev/app' } }
    expect(settleAction(scan, [1], 'work-1')).toEqual({ label: 'Send 1 finding', body: { decision: 'send', findings: [1], to: 'work-1' } })
    expect(settleAction(scan, [3, 1], '')).toEqual({ label: 'Fix 2 in a new session', body: { decision: 'start', findings: [1, 3] } })
  })

  it('words what was decided', () => {
    expect(decidedWords(review, { decision: 'sent', findings: [1], to: 'work-1' })).toMatch(/^Sent 1 finding to work-1/)
    expect(decidedWords(review, { decision: 'started', findings: [1, 2] })).toMatch(/^Asked for a new session to fix 2 findings/)
    expect(decidedWords(review, { decision: 'dismissed' })).toMatch(/^Dismissed/)
  })
})

describe('trigger header', () => {
  const trigger = { name: 'Morning', task: 'Standup', version: 2, what: 'Every weekday at 08:00', at: '2026-11-27T08:03:10+03:00', slot: '2026-11-27T08:00:00+03:00' }

  it('reads the stamp as written, without the time zone', () => {
        expect(serverTime('2026-11-27T08:03:10+03:00')).toContain('08:03')
    expect(serverTime(undefined)).toBe('')
  })

  it('is late from two minutes behind its slot', () => {
    expect(isLate(trigger)).toBe(true)
    expect(isLate({ ...trigger, at: '2026-11-27T08:01:59+03:00' })).toBe(false)
    expect(isLate({ name: 'x' })).toBe(false)
  })

  it('describes the run and the state of the trigger', () => {
    const line = triggerLine(trigger, { known: true, enabled: false })
    expect(line).toContain('Task Standup, version 2')
    expect(line).toContain('Every weekday at 08:00')
    expect(line).toContain('late for 08:00')
    expect(line).toContain('The trigger is off')
    expect(triggerLine(trigger, 'deleted')).toContain('The trigger was deleted')
    expect(triggerLine(trigger, { known: true, enabled: true })).not.toContain('is off')
  })

  it('finds the trigger in the list, or reports it deleted, or unknown before the list loads', () => {
    const list = { triggers: [{ trigger: { name: 'Morning', enabled: true } }] }
    expect(triggerStanding(list, 'Morning')).toEqual({ known: true, enabled: true })
    expect(triggerStanding(list, 'Gone')).toBe('deleted')
    expect(triggerStanding(null, 'Morning')).toBeNull()
  })
})
