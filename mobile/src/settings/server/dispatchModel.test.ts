import { describe, expect, it } from 'vitest'
import {
  agentNote,
  cleanRule,
  codexChoices,
  codexWarning,
  defaultAgentChoice,
  editRules,
  instructionsCounter,
  modelChoices,
  modelSummary,
  newSessionAgents,
  normalizeApproval,
  normalizeRule,
  ruleProblem,
  RuleGoneError,
  ruleSummary,
  savedNotice,
  withStep,
  withTyped
} from './dispatchModel'

const rule = (over = {}) => ({ action: 'start_session', machine: 'hp', folder: 'acme/web', approval: 'allow', ...over })

describe('rules', () => {
  it('fills the web defaults for a rule saved without every field', () => {
    expect(normalizeRule({ action: '', machine: '' })).toEqual({ action: 'any', machine: 'any', folder: '', approval: 'prompt' })
  })

  it('drops machine and folder when the step has no place', () => {
    expect(withStep(rule(), 'remember')).toEqual({ action: 'remember', machine: 'any', folder: '', approval: 'allow' })
    expect(withStep(rule(), 'stop_session')).toMatchObject({ machine: 'hp', folder: 'acme/web' })
  })

  it('trims the folder and clears the place of an unplaced step on save', () => {
    expect(cleanRule(rule({ folder: '  acme/web ' })).folder).toBe('acme/web')
    expect(cleanRule(rule({ action: 'run_trigger', folder: 'x' }))).toMatchObject({ machine: 'any', folder: '' })
  })

  it('names a step, a machine or an answer the server would refuse', () => {
    expect(ruleProblem(rule(), ['hp'])).toBeNull()
    expect(ruleProblem(rule({ action: 'fly' }), ['hp'])).toMatch('no step called fly')
    expect(ruleProblem(rule({ machine: 'ghost' }), ['hp'])).toMatch('no machine called ghost')
    expect(ruleProblem(rule({ approval: 'maybe' }), ['hp'])).toMatch('Allow, Ask or Deny')
    expect(ruleProblem(rule({ action: 'remember', machine: 'ghost' }), ['hp'])).toBeNull()
  })

  it('summarises a rule in words', () => {
    expect(ruleSummary(rule())).toEqual({ title: 'Start a session', detail: 'Allow · hp · acme/web' })
    expect(ruleSummary(rule({ machine: 'any', folder: '', approval: 'deny' }))).toEqual({ title: 'Start a session', detail: 'Deny · any machine · any folder' })
    expect(ruleSummary(rule({ action: 'remember', approval: 'prompt' }))).toEqual({ title: "Change Dispatch's memory", detail: 'Ask' })
  })
})

describe('editRules merges into the list the server has now', () => {
  const a = rule()
  const b = rule({ action: 'merge_pull', machine: 'any', folder: '', approval: 'deny' })

  it('keeps a rule the web added while the editor was open', () => {
    const fresh = [a, b, rule({ action: 'stop_session' })]
    expect(editRules(fresh, a, rule({ approval: 'deny' })).map((r) => `${r.action}:${r.approval}`)).toEqual(['start_session:deny', 'merge_pull:deny', 'stop_session:allow'])
  })

  it('adds to the end and removes only the matching rule', () => {
    expect(editRules([a], null, b)).toEqual([a, b])
    expect(editRules([a, b], a, null)).toEqual([b])
  })

  it('refuses to edit a rule the web changed or removed', () => {
    expect(() => editRules([b], a, rule({ approval: 'deny' }))).toThrow(RuleGoneError)
    expect(() => editRules(undefined, a, null)).toThrow('changed on the computer')
  })

  it('treats a missing list as empty when adding', () => {
    expect(editRules(undefined, null, a)).toEqual([a])
  })
})

describe('instructions counter', () => {
  it('counts and warns near and at the limit', () => {
    expect(instructionsCounter('abc')).toEqual({ text: '3 / 4000', tone: 'ok' })
    expect(instructionsCounter('x'.repeat(3600)).tone).toBe('near')
    expect(instructionsCounter('x'.repeat(4000))).toEqual({ text: '4000 / 4000', tone: 'full' })
  })
})

describe('models and agents', () => {
  const settings = { agents: [{ name: 'claude', label: 'Claude Code' }, { name: 'codex', label: 'Codex' }], default_agent: 'claude', codex_models: ['gpt-5.5', 'gpt-9'] }

  it('puts the default first and adds what Codex lists beyond the catalogue', () => {
    expect(modelChoices('claude', settings, 'Claude Code')[0]).toEqual({ id: '', label: 'Default', description: 'Whatever Claude Code picks on its own' })
    const codex = codexChoices(settings.codex_models)
    expect(codex.filter((c) => c.id === 'gpt-5.5')).toHaveLength(1)
    expect(codex.at(-1)).toMatchObject({ id: 'gpt-9', description: 'Listed by Codex for your account' })
  })

  it('shows a typed model that no list has', () => {
    expect(withTyped(modelChoices('codex', settings, 'Codex'), 'gpt-x').at(-1)).toEqual({ id: 'gpt-x', label: 'gpt-x', description: 'Typed in' })
    expect(withTyped([{ id: 'a', label: 'A' }], 'a')).toHaveLength(1)
  })

  it('warns when Codex does not list the typed model', () => {
    expect(codexWarning('codex', 'gpt-x', ['gpt-5.5'])).toMatch('does not list gpt-x')
    expect(codexWarning('codex', 'gpt-5.5', ['gpt-5.5'])).toBeNull()
    expect(codexWarning('claude', 'gpt-x', ['a'])).toBeNull()
    expect(codexWarning('codex', 'gpt-x', [])).toBeNull()
  })

  it('summarises the model', () => {
    expect(modelSummary({ ...settings, dispatch: { runs_on: 'claude', model: 'sonnet' } })).toBe('Sonnet 5.5')
    expect(modelSummary({ ...settings, dispatch: { runs_on: 'claude', model: '' } })).toBe("Claude Code's default model")
    expect(modelSummary({ ...settings, dispatch: { runs_on: 'codex', codex_model: 'custom' } })).toBe('custom')
  })

  it('says where an agent is installed', () => {
    expect(agentNote(null, 'codex')).toEqual({ text: 'Checking this machine...', missing: false })
    expect(agentNote({ here: 'hp', installed: ['claude'] }, 'claude')).toEqual({ text: 'Installed on hp', missing: false })
    expect(agentNote({ here: 'hp', installed: ['claude'] }, 'codex')).toEqual({ text: 'Not found on hp', missing: true })
  })

  it('lists agents for new sessions, hiding ones installed nowhere unless chosen', () => {
    const installed = { hp: ['claude'], mini: ['claude'] }
    expect(newSessionAgents(settings, installed, '')).toEqual([{ id: 'claude', label: 'Claude Code', description: 'Installed on hp, mini' }])
    expect(newSessionAgents(settings, installed, 'codex').map((a) => a.id)).toEqual(['claude', 'codex'])
    expect(newSessionAgents(settings, null, '').map((a) => a.description)).toEqual([undefined, undefined])
    expect(defaultAgentChoice(settings).label).toBe('Default agent (Claude Code)')
  })

  it('maps the old approval words', () => {
    expect(normalizeApproval('ask')).toBe('prompt')
    expect(normalizeApproval('auto')).toBe('allow')
    expect(normalizeApproval('deny')).toBe('deny')
    expect(normalizeApproval(undefined)).toBe('prompt')
  })

  it('tells a changed agent from an unchanged one', () => {
    expect(savedNotice('claude', 'claude', 'Claude Code')).toMatch('apply from the next message')
    expect(savedNotice(undefined, 'codex', 'Codex')).toBe('Dispatch settings saved. New conversations start on Codex, and open ones carry on where they started.')
  })
})
