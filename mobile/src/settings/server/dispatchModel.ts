import { CLAUDE_MODELS, CODEX_MODELS, type ModelChoice } from '../../dispatch/composer/models'
import type { DispatchRule, DispatchSettings, ServerSettings } from '../serverApi'

export const INSTRUCTIONS_LIMIT = 4000

export const RULE_STEPS: [string, string][] = [
  ['any', 'Any step'],
  ['call_connector', 'Call a connected tool'],
  ['call_tool', 'Call an MCP tool'],
  ['run_command', 'Run a command'],
  ['save_connector', 'Save a connection'],
  ['start_session', 'Start a session'],
  ['stop_session', 'Stop a session'],
  ['send_to_session', 'Type into a session'],
  ['review_session', 'Start a review'],
  ['scan_folder', 'Start a scan'],
  ['remove_worktree', 'Remove a worktree'],
  ['integrate_branches', 'Integrate branches'],
  ['push_branch', 'Push a branch'],
  ['merge_pull', 'Merge a pull request'],
  ['move_session', 'Move a session'],
  ['change_settings', 'Change settings'],
  ['save_task', 'Save a prompt'],
  ['run_trigger', 'Run a trigger'],
  ['save_pipeline', 'Save a pipeline'],
  ['set_pipeline_enabled', 'Turn a pipeline on or off'],
  ['run_pipeline', 'Run a pipeline'],
  ['answer_run', 'Answer a run'],
  ['remember', "Change Dispatch's memory"]
]

const UNPLACED = new Set([
  'save_connector',
  'call_connector',
  'call_tool',
  'remember',
  'change_settings',
  'save_task',
  'run_trigger',
  'save_pipeline',
  'set_pipeline_enabled',
  'run_pipeline',
  'answer_run'
])

export const RULE_THEN: { id: string; label: string }[] = [
  { id: 'allow', label: 'Allow' },
  { id: 'prompt', label: 'Ask' },
  { id: 'deny', label: 'Deny' }
]

export const APPROVAL_CHOICES = [
  { id: 'prompt', label: 'Ask first', detail: 'Each step waits as a card you approve, edit or reject.' },
  { id: 'allow', label: 'Go ahead', detail: 'Steps run at once. Memory changes still ask.' },
  { id: 'deny', label: 'Refuse', detail: 'Every step is refused unless a rule allows it.' }
]

export const RULES_HELP =
  'Exceptions to the approval above, for particular steps, machines or folders. Deny always wins; otherwise the most specific rule wins. A folder is a name from the folder list, like acme/web, or a path, and * matches any part of a name.'

export const INSTRUCTIONS_HELP = "Added to Dispatch's prompt for every conversation, and followed before its own defaults."

export const AGENT_HELP =
  "Dispatch only uses Yardbell's own tools, whichever agent it runs on. A conversation stays on the agent it started on; a new model applies from the next message."

export const stepLabel = (action: string) => RULE_STEPS.find(([id]) => id === action)?.[1] ?? action

export const isPlaced = (action: string) => !UNPLACED.has(action)

export const newRule = (): DispatchRule => ({ action: 'stop_session', machine: 'any', folder: '', approval: 'deny' })

export function normalizeRule(rule: Partial<DispatchRule>): DispatchRule {
  return { approval: 'prompt', ...rule, action: rule.action || 'any', machine: rule.machine || 'any', folder: rule.folder || '' }
}

export function withStep(rule: DispatchRule, action: string): DispatchRule {
  return isPlaced(action) ? { ...rule, action } : { ...rule, action, machine: 'any', folder: '' }
}

export function cleanRule(rule: DispatchRule): DispatchRule {
  const folder = rule.folder.trim()
  return isPlaced(rule.action) ? { ...rule, folder } : { ...rule, machine: 'any', folder: '' }
}

export function ruleProblem(rule: DispatchRule, machines: string[]): string | null {
  if (!RULE_STEPS.some(([id]) => id === rule.action)) return `Dispatch has no step called ${rule.action}`
  if (!RULE_THEN.some((x) => x.id === rule.approval)) return 'Choose Allow, Ask or Deny'
  if (isPlaced(rule.action) && rule.machine !== 'any' && !machines.includes(rule.machine)) return `This server has no machine called ${rule.machine}`
  return null
}

export function ruleSummary(rule: DispatchRule): { title: string; detail: string } {
  const then = RULE_THEN.find((x) => x.id === rule.approval)?.label ?? rule.approval
  if (!isPlaced(rule.action)) return { title: stepLabel(rule.action), detail: then }
  const where = [rule.machine === 'any' ? 'any machine' : rule.machine, rule.folder || 'any folder']
  return { title: stepLabel(rule.action), detail: `${then} · ${where.join(' · ')}` }
}

const same = (a: DispatchRule, b: DispatchRule) => a.action === b.action && a.machine === b.machine && a.folder === b.folder && a.approval === b.approval

export class RuleGoneError extends Error {
  constructor() {
    super('That rule was changed on the computer in the meantime. Close this and open it again.')
    this.name = 'RuleGoneError'
  }
}

export function editRules(fresh: DispatchRule[] | undefined, before: DispatchRule | null, after: DispatchRule | null): DispatchRule[] {
  const list = (fresh ?? []).map(normalizeRule)
  if (!before) return after ? [...list, after] : list
  const at = list.findIndex((r) => same(r, before))
  if (at < 0) throw new RuleGoneError()
  return after ? list.map((r, i) => (i === at ? after : r)) : list.filter((_, i) => i !== at)
}

const APPROVAL_ALIASES: Record<string, string> = { ask: 'prompt', auto: 'allow' }

export const normalizeApproval = (raw: string | undefined) => (raw && APPROVAL_ALIASES[raw]) || raw || 'prompt'

export type InstructionsCounter = { text: string; tone: 'ok' | 'near' | 'full' }

export function instructionsCounter(text: string, limit = INSTRUCTIONS_LIMIT): InstructionsCounter {
  const tone = text.length >= limit ? 'full' : text.length >= limit * 0.9 ? 'near' : 'ok'
  return { text: `${text.length} / ${limit}`, tone }
}

export const instructionsDirty = (draft: string, saved: string | undefined) => draft !== (saved ?? '')

export function codexChoices(listed: string[] | undefined): ModelChoice[] {
  const known = new Set(CODEX_MODELS.map((m) => m.id))
  const extra = (listed ?? []).filter((id) => !known.has(id)).map((id) => ({ id, label: id, description: 'Listed by Codex for your account' }))
  return [...CODEX_MODELS, ...extra]
}

export function modelChoices(runsOn: string | undefined, settings: ServerSettings | undefined, agentName: string): ModelChoice[] {
  const base = runsOn === 'codex' ? codexChoices(settings?.codex_models) : CLAUDE_MODELS
  return [{ id: '', label: 'Default', description: `Whatever ${agentName} picks on its own` }, ...base]
}

export function withTyped(choices: ModelChoice[], value: string): ModelChoice[] {
  return value && !choices.some((c) => c.id === value) ? [...choices, { id: value, label: value, description: 'Typed in' }] : choices
}

export function choiceLabel(choices: ModelChoice[], value: string): string {
  return (choices.find((c) => c.id === value) ?? choices[0])?.label ?? value
}

export function codexWarning(runsOn: string | undefined, model: string | undefined, listed: string[] | undefined): string | null {
  const typed = (model ?? '').trim()
  if (runsOn !== 'codex' || !typed || !listed?.length || listed.includes(typed)) return null
  return `Codex does not list ${typed} for your account, so it may refuse it.`
}

export const agentName = (settings: ServerSettings | undefined, runsOn: string | undefined) =>
  settings?.agents?.find((a) => a.name === runsOn)?.label ?? (runsOn === 'codex' ? 'Codex' : runsOn === 'claude' || !runsOn ? 'Claude Code' : runsOn)

export function modelSummary(settings: ServerSettings | undefined): string {
  const d: DispatchSettings = settings?.dispatch ?? {}
  const codex = d.runs_on === 'codex'
  const id = (codex ? d.codex_model : d.model)?.trim() ?? ''
  const choices = modelChoices(d.runs_on, settings, agentName(settings, d.runs_on))
  if (!id) return codex ? "Codex's default model" : "Claude Code's default model"
  return choices.find((c) => c.id === id)?.label ?? id
}

export type AgentFootprint = { here: string; installed: string[] } | null

export function agentNote(footprint: AgentFootprint, agent: string): { text: string; missing: boolean } {
  if (!footprint) return { text: 'Checking this machine...', missing: false }
  return footprint.installed.includes(agent)
    ? { text: `Installed on ${footprint.here}`, missing: false }
    : { text: `Not found on ${footprint.here}`, missing: true }
}

export function newSessionAgents(
  settings: ServerSettings | undefined,
  installed: Record<string, string[]> | null,
  current: string
): { id: string; label: string; description?: string }[] {
  const where = (name: string) => (installed ? Object.keys(installed).filter((m) => installed[m].includes(name)) : [])
  return (settings?.agents ?? [])
    .filter((a) => !installed || where(a.name).length > 0 || a.name === current)
    .map((a) => {
      const on = where(a.name)
      return { id: a.name, label: a.label, description: !installed ? undefined : on.length ? `Installed on ${on.join(', ')}` : 'Not installed anywhere' }
    })
}

export function defaultAgentChoice(settings: ServerSettings | undefined): { id: string; label: string; description: string } {
  const fallback = settings?.agents?.find((a) => a.name === settings.default_agent)
  return { id: '', label: `Default agent${fallback ? ` (${fallback.label})` : ''}`, description: "Yardbell's default for new sessions" }
}

export function savedNotice(before: string | undefined, after: string | undefined, afterLabel: string): string {
  const was = before || 'claude'
  const now = after || 'claude'
  return was === now
    ? 'Dispatch settings saved. They apply from the next message.'
    : `Dispatch settings saved. New conversations start on ${afterLabel}, and open ones carry on where they started.`
}
