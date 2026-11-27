import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { ServerError } from '../api/client'
import type { ActionEvent } from '../dispatch/types'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../ui/theme'
import { StepCard } from './StepCard'

export type StepGroup = 'pending' | 'tools' | 'receipts' | 'edit' | 'already' | 'error' | 'busy'

export const STEP_GROUPS: StepGroup[] = ['pending', 'tools', 'receipts', 'edit', 'already', 'error', 'busy']

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const longTask =
  'Fix the webhook dedup bug in the checkout flow. Start by reading the failing spec, then change the handler so a repeated delivery id is ignored, and add a regression test. Keep the change small and do not touch the billing code. When the tests pass, push the branch and open a pull request that explains the cause in two sentences.'

function step(id: string, tool: string, input: Record<string, unknown>, fields: Partial<ActionEvent> = {}): ActionEvent {
  return { role: 'action', id, tool, input, status: 'pending', by: 'dispatch', at: ago(4), ...fields }
}

const wideLine = '    let delivery_id = headers.get("x-webhook-delivery-id").and_then(|value| value.to_str().ok()).map(str::trim).unwrap_or_default();'

const settingsDiff = [
  { op: 'same', text: '{\n  "approval": "ask",\n  "agent": "claude",\n  "model": "default",\n  "runs_on": "hp",\n  "instructions": "Keep answers short.",\n  "rules": [' },
  { op: 'del', text: '    { "action": "start_session", "machine": "hp" }' },
  { op: 'add', text: '    { "action": "start_session", "machine": "any" }' },
  { op: 'add', text: wideLine },
  { op: 'same', text: '  ],\n  "speak": false,\n  "timeout": 300,\n  "retries": 2,\n  "notify": true\n}' }
]

const tools: ActionEvent[] = [
  step('t01', 'start_session', { machine: 'hp', folder: 'yardbell', agent: 'claude', branch: 'fix-webhook-dedup', new_branch: true, base: 'main', prompt: longTask }),
  step('t02', 'send_to_session', { machine: 'hp', name: 'yardbell-1', text: 'Stop waiting for CI and merge main into your branch instead.' }),
  step('t03', 'stop_session', { machine: 'hp', name: 'yardbell-9' }),
  step('t04', 'remove_worktree', { machine: 'hp', folder: 'yardbell-old', delete_branch: true }),
  step('t05', 'integrate_branches', { machine: 'hp', folder: 'yardbell', into: 'release', base: 'main', method: 'merge', branches: ['fix-webhook-dedup', 'fix-proposal-count', 'mobile-app'] }),
  step('t06', 'push_branch', { machine: 'hp', folder: 'yardbell', branch: 'fix-webhook-dedup' }),
  step('t07', 'move_session', { machine: 'hp', name: 'yardbell-3', to: 'mac-pro', stop_original: true, task: 'Carry on with the dedup fix and run the specs on this machine.' }),
  step('t08', 'call_connector', { connector: 'linear', call: 'create_issue' }),
  step('t09', 'save_connector', { host: 'mcp.linear.app', connector: { name: 'linear', base_url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer {{LINEAR_TOKEN}}' }, calls: [{ name: 'create_issue', path: '/issues', method: 'POST' }] } }),
  step('t10', 'remember', { change: 'replace', old: 'Prefers one big pull request per ticket.', entry: 'Prefers small pull requests, one concern each.', reason: 'You said so twice this week.' }),
  step('t11', 'remember', { change: 'forget', old: 'Uses the old staging server.' }),
  step('t12', 'change_settings', { area: 'dispatch', diff: settingsDiff, value: {} }),
  step('t13', 'save_task', { name: 'Release notes', text: 'Write release notes from the merged pull requests of the last week.', diff: [{ op: 'del', text: 'Write release notes.' }, { op: 'add', text: 'Write release notes from the merged pull requests of the last week.' }], before: { version: 1 } }, { by: 'client', from: 'Claude Code' }),
  step('t14', 'run_trigger', { name: 'Morning check' }, { by: 'client', from: 'Cursor' }),
  step('t15', 'save_pipeline', { before: { version: 2 }, definition: { name: 'Nightly import', steps: [{ name: 'Pull the data', kind: 'session' }, { name: 'Run the import', kind: 'command', command: 'bin/rails import:nightly RAILS_ENV=production --trace --verbose --batch-size=500' }, { name: 'Check the counts', kind: 'session' }] }, changes: { added: ['Check the counts'], changed: [{ step: 'Pull the data', fields: ['instructions'] }] } }, { by: 'client', from: 'Claude Code' }),
  step('t16', 'set_pipeline_enabled', { id: 'nightly-import', name: 'Nightly import', on: true }, { by: 'client', from: 'Codex' }),
  step('t17', 'run_pipeline', { id: 'nightly-import', name: 'Nightly import', tickets: ['COM-1234', 'https://linear.app/acme/issue/COM-1235'], prs: [] }, { by: 'client', from: 'Codex' }),
  step('t18', 'answer_run', { pipeline: 'Nightly import', subject: 'Run 14', action: 'answer', text: 'Yes, use the staging data.', waiting: { step: 'Run the import', reason: 'The import asks which database to use.', screen: 'Which database?\n  1. staging\n  2. production' } }, { by: 'client', from: 'Codex' }),
  step('t19', 'draw_diagram', { folder: 'yardbell' }),
  step('t20', 'start_session', { machine: 'hp', path: '/home/dev/Projects/yardbell', prompt: 'Review the branch. Run the tests, change no files.' }, { by: 'you', review: { name: 'yardbell-2', branch: 'fix-webhook-dedup', pull: { number: 412, base: 'main', forge: 'github' } } }),
  step('t21', 'start_session', { machine: 'hp', path: '/home/dev/Projects/yardbell', prompt: 'Look through all of the code for dead code.' }, { by: 'you', review: { scan: 'dead_code', path: '/home/dev/Projects/yardbell' } }),
  step('t22', 'a_connected_tool_with_an_extremely_long_name_that_has_to_be_cut_somewhere_before_the_buttons', { machine: 'a-machine-with-a-very-long-name-as-well', name: 'a-session-name-that-is-long-too' })
]

const receipts: ActionEvent[] = [
  step('r01', 'start_session', { machine: 'hp', folder: 'yardbell', agent: 'claude', prompt: longTask }, { status: 'approved', decided: ago(3), result: { ok: true, text: 'Started yardbell-3 on hp', session: { machine: 'hp', name: 'yardbell-3' } } }),
  step('r02', 'send_to_session', { machine: 'hp', name: 'yardbell-3', text: 'Also run the whole spec folder before you push.' }, { status: 'edited', decided: ago(3), original: { machine: 'hp', name: 'yardbell-3', text: 'Run the specs.' }, result: { ok: true, text: 'Sent', at: ago(3) } }),
  step('r03', 'stop_session', { machine: 'hp', name: 'yardbell-9' }, { status: 'rejected', by: 'you', decided: ago(2) }),
  step('r04', 'push_branch', { machine: 'hp', folder: 'yardbell', branch: 'fix-webhook-dedup' }, { status: 'withdrawn', decided: ago(2) }),
  step('r05', 'remove_worktree', { machine: 'hp', folder: 'yardbell-old' }, { status: 'auto', rule: { action: 'remove_worktree', machine: 'any' }, decided: ago(2), result: { ok: false, text: 'The worktree has uncommitted changes and commits no remote has. Only you can remove it, from the dashboard.', at: ago(2) } }),
  step('r06', 'integrate_branches', { machine: 'hp', folder: 'yardbell', into: 'release', base: 'main', branches: ['a', 'b'] }, { status: 'approved', decided: ago(1), result: { ok: true, text: JSON.stringify({ summary: 'Stopped at a conflict in src/webhooks.rs', integrated: { conflict: true } }) } }),
  step('r07', 'save_task', { name: 'Release notes', text: 'x' }, { by: 'client', from: 'Claude Code', status: 'approved', decided: ago(1), result: { ok: true, text: '{"version":2}' } }),
  step('r08', 'stop_session', { machine: 'hp', name: 'yardbell-4' }, { status: 'approved' })
]

const noop = () => Promise.resolve()
const approveOk = () => new Promise<void>((resolve) => setTimeout(resolve, 600))

function Group({ title, children }: { title: string; children: ReactNode }) {
  useColorScheme()
  return (
    <View style={styles.group}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </View>
  )
}

function Cards({ steps, onDecide = noop }: { steps: ActionEvent[]; onDecide?: () => Promise<void> }) {
  return (
    <>
      {steps.map((entry) => (
        <View key={entry.id} style={styles.slot}>
          <StepCard step={entry} onDecide={onDecide} onOpenSession={() => {}} machines={['hp', 'mac-pro', 'mac-mini']} agents={[{ name: 'claude', label: 'Claude Code' }, { name: 'codex', label: 'Codex' }]} />
        </View>
      ))}
    </>
  )
}

export function StepGallery({ group }: { group: StepGroup }) {
  useColorScheme()
  if (group === 'pending') {
    return (
      <Group title="Pending steps: start session (long task), send, stop, remove worktree, integrate, push">
        <Cards steps={tools.slice(0, 6)} onDecide={approveOk} />
      </Group>
    )
  }
  if (group === 'tools') {
    return (
      <>
        <Group title="Pending: move, connectors, memory, settings diff, saved task, trigger">
          <Cards steps={tools.slice(6, 14)} />
        </Group>
        <Group title="Pending: pipelines, runs, diagram, review, scan, long names">
          <Cards steps={tools.slice(14)} />
        </Group>
      </>
    )
  }
  if (group === 'receipts') {
    return (
      <Group title="Receipts: approved (tap to open), edited, cancelled, withdrawn, failed, conflict, saved, running">
        <Cards steps={receipts} />
      </Group>
    )
  }
  const settled = (error: unknown) => () => Promise.reject(error)
  if (group === 'edit') {
    return (
      <Group title="Edit drawer: tap Edit">
        <Cards steps={[tools[0]]} onDecide={approveOk} />
      </Group>
    )
  }
  if (group === 'already') {
    return (
      <Group title="Already decided: tap Approve">
        <Cards steps={[tools[2]]} onDecide={settled(new ServerError('this step was already approved', 409))} />
      </Group>
    )
  }
  if (group === 'error') {
    return (
      <Group title="Error from the server: tap Approve">
        <Cards steps={[tools[5]]} onDecide={settled(new ServerError('hp is not reachable. Check that its Yardbell is running.', 502))} />
      </Group>
    )
  }
  return (
    <Group title="In flight: tap Approve">
      <Cards steps={[tools[3]]} onDecide={() => new Promise<void>(() => {})} />
    </Group>
  )
}

const styles = themedStyleSheet(() => ({
  group: { marginBottom: spacing.lg },
  title: { color: colors.textMuted, fontSize: 11, paddingHorizontal: spacing.lg, marginBottom: spacing.xs },
  slot: { paddingHorizontal: spacing.sm, marginBottom: spacing.sm }
}))
