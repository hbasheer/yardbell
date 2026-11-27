import { useMemo, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { ServerError } from '../../api/client'
import { Markdown } from '../../markdown'
import { colors, spacing, themedStyleSheet, useColorScheme } from '../../ui/theme'
import { blocks } from '../blocks'
import type { ActionEvent, DispatchEvent, GroupEvent, PullEvent, ResultsEvent, ReviewEvent, SessionEvent, Trigger } from '../types'
import { ErrorCard } from './ErrorCard'
import { GroupCard } from './GroupCard'
import { PullCard } from './PullCard'
import { ResultsCard } from './ResultsCard'
import { ReviewCard } from './ReviewCard'
import { SessionCard } from './SessionCard'
import { ToolRun } from './ToolRun'
import { TriggerHeader } from './TriggerHeader'

export type CardGroup = 'markdown' | 'tools' | 'session' | 'pull' | 'group' | 'results' | 'review' | 'misc'

export const CARD_GROUPS: CardGroup[] = ['markdown', 'tools', 'session', 'pull', 'group', 'results', 'review', 'misc']

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const later = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms))
const refuse = (error: unknown) => () => Promise.reject(error)
const never = () => new Promise<never>(() => {})

const LONG_MARKDOWN = `# Release plan

Dispatch looked at **three** machines and found the *repository* on \`hp\`. Here is what it suggests, with a [link to the notes](https://example.com/release-notes) and a bare address https://example.org/very/long/path/that/keeps/going/and/going/for/a/while/until/it/must/wrap.

## Steps

1. Start a session on \`hp\` for the webhook fix
2. Start a second one on \`mac-pro\` for the proposal count
   - it needs the **same** branch base
   - and a clean worktree
3. Gather both results, then review them

### Why this order

- The webhook fix is small and safe
- The proposal count touches the Inbox badge
- ~~Skipping the review~~ is not an option

> Dispatch asks before it changes anything. Nothing runs until you approve the cards below.

\`\`\`rust
fn handle(headers: &HeaderMap, body: &Bytes) -> Result<Response, ApiError> {
    let delivery_id = headers.get("x-webhook-delivery-id").and_then(|value| value.to_str().ok()).map(str::trim).unwrap_or_default();
    if seen.contains(delivery_id) { return Ok(Response::ok()); }
    Ok(process(body)?)
}
\`\`\`

| Machine | Branch | Sessions | Notes |
|:--|:-:|--:|--|
| hp | fix-webhook-dedup | 2 | Docker, the test box |
| mac-pro | fix-proposal-count | 1 | Runs natively |
| mac-mini | none | 0 | Edit only |

---

Last line, after a rule.`

const PARTIAL = 'The branch is ready, but **two of the'
const PARTIAL_FENCE = 'Run this next:\n\n```bash\ncargo test -p yardbell --lib dispatch'

const sessionBlocked: SessionEvent = {
  role: 'session',
  machine: 'hp',
  name: 'yardbell-3',
  path: '/home/dev/Projects/yardbell',
  state: 'blocked',
  screen: '────────────────\n   Do you want to run the migration?\n   cargo run -- migrate --up\n   This will change the database schema on hp.\n   It cannot be undone without a backup.\n   │ 1. Yes   ┌ preview ┐\n   │ 2. Yes, and do not ask again for cargo commands in this project\n   │ 3. No, and tell Claude what to do differently\n────────────────',
  options: [
    { key: '1', label: '1. Yes' },
    { key: '2', label: '2. Yes, and do not ask again for cargo commands in this project' },
    { key: '3', label: '3. No, and tell Claude what to do differently' }
  ]
}
const sessionIdle: SessionEvent = { role: 'session', machine: 'hp', name: 'yardbell-4', path: '/home/dev/Projects/yardbell', state: 'idle', screen: 'All tests pass.\nPushed fix-webhook-dedup.' }
const sessionAnswered: SessionEvent = { ...sessionBlocked, name: 'yardbell-5', state: 'idle', answer: { key: '1', label: '1. Yes', at: ago(3) } }
const sessionEnded: SessionEvent = { role: 'session', machine: 'mac-pro', name: 'a-session-with-a-name-that-is-much-too-long-to-fit-on-one-line', path: '/Users/dev/RailsProjects/a-folder-with-a-long-name', state: 'ended' }

const step = (id: string, fields: Partial<ActionEvent> = {}): ActionEvent => ({
  role: 'action',
  id,
  tool: 'start_session',
  input: { machine: 'hp', folder: 'yardbell', agent: 'claude', prompt: 'Fix the webhook dedup bug in the checkout flow. Read the failing spec first, then change the handler so a repeated delivery id is ignored, and add a regression test.' },
  status: 'pending',
  by: 'dispatch',
  at: ago(4),
  ...fields
})

const pullCi: PullEvent = {
  role: 'pull',
  kind: 'ci',
  machine: 'hp',
  name: 'yardbell-3',
  branch: 'fix-webhook-dedup',
  pull: { number: 412, url: 'https://github.com/acme/yardbell/pull/412', title: 'Ignore repeated webhook deliveries', base: 'main' },
  checks: [
    { name: 'rust / test (ubuntu)', url: 'https://github.com/acme/yardbell/actions/runs/1', log: 'running 412 tests\ntest dispatch::tests::decides_group ... ok\nerror[E0308]: mismatched types in src/dispatch/group.rs:88:14 expected `&str`, found `String`\nerror: could not compile `yardbell` (lib test) due to 1 previous error' },
    { name: 'web / typecheck', log: 'src/dispatch/Composer.tsx(88,5): error TS2322: Type string is not assignable to type number.' },
    { name: 'lint' }
  ],
  instruction: 'The checks on #412 failed. Read the failing logs, fix the cause, run the tests and push the branch.',
  at: ago(6)
}
const pullConflict: PullEvent = { ...pullCi, kind: 'conflict', checks: undefined, instruction: 'Merge main into the branch, resolve the conflicts and push.', pull: { number: 87, forge: 'gitlab', title: 'Move session', base: 'release/2026-11' } }
const pullNotes: PullEvent = {
  ...pullCi,
  kind: 'comments',
  checks: undefined,
  notes: [
    { kind: 'changes_requested', author: 'maryam', body: 'The retry loop never backs off, so a failing endpoint gets hammered. Please add a delay between attempts, cap the number of retries, and log the final failure with the delivery id so we can find it later in the dashboard.\nAlso please add a test for the cap.', url: 'https://github.com/acme/yardbell/pull/412#r1' },
    { kind: 'inline', author: 'omar', place: 'src/dispatch/group.rs:88', body: 'Typo here.', url: 'https://github.com/acme/yardbell/pull/412#r2' }
  ],
  more: 3
}
const pullLimit: PullEvent = { role: 'pull', kind: 'limit', machine: 'hp', name: 'yardbell-6', folder: 'yardbell', error: 'usage limit reached for this window', resets: new Date(Date.now() - 20 * 60_000).toISOString(), instruction: 'Carry on where you stopped.', at: ago(10) }
const pullSent: PullEvent = { ...pullConflict, sent: { step: 'p1' } }

const group: GroupEvent = {
  role: 'group',
  id: 'g1',
  title: 'Fix the webhook dedup and the proposal count',
  gather: 'Merge both branches into release and tell me if the specs pass',
  follow: true,
  minutes: 90,
  at: ago(5),
  status: 'waiting',
  children: [{ label: 'Webhook dedup', step: 'c1' }, { label: 'Proposal count', step: 'c2' }, { label: 'Billing cleanup', refused: 'your rule allows no sessions on mac-mini' }]
}
const groupSteps = new Map<string, ActionEvent>([
  ['c1', step('c1', { group: 'g1' })],
  ['c2', step('c2', { group: 'g1', input: { machine: 'mac-pro', folder: 'yardbell', agent: 'codex', branch: 'fix-proposal-count', new_branch: true, prompt: 'Make the Inbox badge count only waiting proposals.' } })]
])
const groupRunning: GroupEvent = { ...group, id: 'g2', status: 'running', gather: undefined, follow: undefined, started: ago(2), children: [{ label: 'Webhook dedup', step: 'd1' }, { label: 'Proposal count', step: 'd2' }, { label: 'Docs', step: 'd3' }] }
const started = (name: string, machine = 'hp') => ({ ok: true, text: `Started ${name}`, session: { machine, name } })
const groupRunningSteps = new Map<string, ActionEvent>([
  ['d1', step('d1', { group: 'g2', status: 'approved', result: started('yardbell-3') })],
  ['d2', step('d2', { group: 'g2', status: 'approved', result: started('yardbell-4', 'mac-pro') })],
  ['d3', step('d3', { group: 'g2', status: 'approved', result: { ok: false, text: 'mac-mini is not reachable. Check that its Yardbell is running.' } })]
])
const liveAll = (_machine: string, name: string) => (name === 'yardbell-3' ? ('active' as const) : ('blocked' as const))

const results: ResultsEvent = {
  role: 'results',
  group: 'g2',
  title: 'the webhook dedup and the proposal count',
  at: ago(1),
  follow: true,
  gather: 'merge both into release',
  children: [
    { label: 'Webhook dedup', started: true, name: 'yardbell-3', machine: 'hp', branch: 'fix-webhook-dedup', state: 'ended', result: { status: 'done', summary: 'The handler now ignores a repeated delivery id. A regression spec covers it and the whole spec folder passes.', details: ['src/webhooks.rs: ignore seen ids', 'spec/webhooks_spec.rb: repeated delivery', 'Pushed fix-webhook-dedup'] } },
    { label: 'Proposal count', started: true, name: 'yardbell-4', machine: 'mac-pro', branch: 'fix-proposal-count', state: 'ended', result: { status: 'partial', summary: 'The badge is right, the Inbox list still counts decided ones.' } }
  ]
}
const resultsLate: ResultsEvent = {
  ...results,
  group: 'g3',
  why: 'timeout',
  minutes: 60,
  gather: undefined,
  follow: undefined,
  children: [
    { label: 'Webhook dedup', started: true, name: 'yardbell-3', machine: 'hp', branch: 'fix-webhook-dedup', state: 'needs input', screen: 'Do you want to run the migration?\n1. Yes\n2. No' },
    { label: 'Proposal count', started: true, name: 'yardbell-4', machine: 'mac-pro', state: 'still working' },
    { label: 'Billing cleanup', note: 'refused by your rule', started: false }
  ]
}

const findings = [
  { severity: 'high', place: 'src/dispatch/group.rs:88', text: 'A group decided twice starts its sessions twice. The second call should return the first decision.' },
  { severity: 'high', place: 'src/web/mod.rs:2036', text: 'The outcome is written after the step runs, so a crash in between loses it.' },
  { severity: 'medium', text: 'The retry loop never backs off.' },
  { severity: 'low', place: 'README.md:12', text: 'The example names the old flag.' },
  { severity: 'low', text: 'Two functions share a name in different modules.' }
]
const review: ReviewEvent = { role: 'review', machine: 'hp', name: 'yardbell-rev-1', of: { name: 'yardbell-3', branch: 'fix-webhook-dedup', path: '/home/dev/Projects/yardbell', pull: { number: 412, url: 'https://github.com/acme/yardbell/pull/412' } }, verdict: 'changes', summary: 'The fix is right for the case it targets. Two things can still go wrong when a delivery arrives twice at the same moment, and the retry loop needs a back off.', findings, at: ago(2) }
const reviewReady: ReviewEvent = { ...review, name: 'yardbell-rev-2', verdict: 'ready', summary: 'Nothing needs changing.', findings: [] }
const reviewDone: ReviewEvent = { ...review, name: 'yardbell-rev-3', outcome: { decision: 'sent', findings: [0, 2], to: 'yardbell-3', at: ago(1) } }
const scan: ReviewEvent = { role: 'review', machine: 'hp', name: 'yardbell-scan-1', of: { scan: 'dead_code', name: 'yardbell-3', path: '/home/dev/Projects/yardbell', branch: 'main' }, verdict: 'issues', summary: 'Three items look unused.', findings: findings.slice(1, 4), at: ago(2) }

const triggerBase: Trigger = { name: 'Morning check', task: 'Standup report', version: 3, what: 'Every weekday at 08:00', at: '2026-11-27T08:03:10+03:00', slot: '2026-11-27T08:00:00+03:00', url: 'https://linear.app/acme/issue/COM-1234' }

function Group({ title, children }: { title: string; children: ReactNode }) {
  useColorScheme()
  return (
    <View style={styles.group}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </View>
  )
}

const Slot = ({ children }: { children: ReactNode }) => <View style={styles.slot}>{children}</View>

const open = () => {}

export function CardsGallery({ group: which }: { group: CardGroup }) {
  useColorScheme()
  const transcript = useMemo<DispatchEvent[]>(
    () => [
      { role: 'tool', name: 'list_machines', input: {} },
      { role: 'tool_result', name: 'list_machines', text: '[\n  { "name": "hp", "reachable": true, "sessions": 2 },\n  { "name": "mac-pro", "reachable": true, "sessions": 1 }\n]' },
      { role: 'tool', name: 'list_folders', input: { machine: 'hp', folder: 'yardbell' } },
      { role: 'tool_result', name: 'list_folders', text: '/home/dev/Projects/yardbell' },
      { role: 'tool', name: 'read_session', input: { machine: 'hp', name: 'yardbell-9' } },
      { role: 'tool_result', name: 'read_session', text: 'no such session yardbell-9', is_error: true },
      { role: 'assistant', text: 'Found it.' },
      { role: 'tool', name: 'list_sessions', input: { machine: 'a-machine-with-a-very-long-name-as-well-so-it-must-be-cut' } },
      { role: 'tool', name: 'a_connected_tool_with_an_extremely_long_name_that_has_to_be_cut_somewhere', input: { machine: 'hp' } },
      { role: 'tool_result', name: 'a_connected_tool_with_an_extremely_long_name_that_has_to_be_cut_somewhere', text: 'ok' }
    ],
    []
  )

  if (which === 'markdown') {
    return (
      <>
        <Group title="Markdown: headings, lists, quote, wide code (scroll sideways), table, links, rule">
          <Slot>
            <Markdown text={LONG_MARKDOWN} />
          </Slot>
        </Group>
        <Group title="Partial text while streaming: unfinished bold, then an open code fence">
          <Slot>
            <Markdown text={PARTIAL} streaming />
          </Slot>
          <Slot>
            <Markdown text={PARTIAL_FENCE} streaming />
          </Slot>
        </Group>
      </>
    )
  }
  if (which === 'tools') {
    const list = blocks(transcript)
    return (
      <Group title="Tool runs: ok, error, long names, running (last one, while the turn is live)">
        {list.map((block) =>
          block.kind === 'tools' ? (
            <Slot key={block.key}>
              <ToolRun chips={block.chips} running={block.key === 7} />
            </Slot>
          ) : (
            <Slot key={block.key}>
              <Markdown text={block.event.role === 'assistant' ? block.event.text : ''} />
            </Slot>
          )
        )}
      </Group>
    )
  }
  if (which === 'session') {
    return (
      <Group title="Session cards: blocked with choices (tap one), idle with Review and Scan, answered, ended and long names">
        <Slot>
          <SessionCard event={sessionBlocked} onAnswer={later(700)} onOpen={open} />
        </Slot>
        <Slot>
          <SessionCard event={{ ...sessionBlocked, name: 'yardbell-7' }} onAnswer={refuse(new ServerError('it was already answered with 1', 409))} onOpen={open} />
        </Slot>
        <Slot>
          <SessionCard event={sessionIdle} onAnswer={later(1)} onOpen={open} onReview={later(700)} onScan={later(700)} />
        </Slot>
        <Slot>
          <SessionCard event={sessionAnswered} onAnswer={later(1)} onOpen={open} />
        </Slot>
        <Slot>
          <SessionCard event={sessionEnded} onAnswer={later(1)} onOpen={open} onReview={refuse(new ServerError('hp is not reachable. Check that its Yardbell is running.', 502))} onScan={later(1)} />
        </Slot>
      </Group>
    )
  }
  if (which === 'pull') {
    return (
      <Group title="Pull cards: CI failed (tap a check), conflict on GitLab, comments, limit reset, sent and waiting, already sent">
        <Slot>
          <PullCard event={pullCi} onSend={later(700)} onOpen={open} />
        </Slot>
        <Slot>
          <PullCard event={pullConflict} onSend={refuse(new ServerError('this card was already sent', 409))} onOpen={open} />
        </Slot>
        <Slot>
          <PullCard event={pullNotes} onSend={later(500)} onOpen={open} />
        </Slot>
        <Slot>
          <PullCard event={pullLimit} onSend={refuse(new ServerError('Not sent: your Dispatch rule "send to any session" refuses it.', 403))} onOpen={open} />
        </Slot>
        <Slot>
          <PullCard event={pullSent} step={step('p1', { tool: 'send_to_session' })} onSend={later(1)} onOpen={open} />
        </Slot>
        <Slot>
          <PullCard event={pullSent} step={step('p1', { tool: 'send_to_session', status: 'rejected' })} onSend={later(1)} onOpen={open} />
        </Slot>
      </Group>
    )
  }
  if (which === 'group') {
    return (
      <Group title="Group cards: two waiting and one refused (Approve all), running with a failed child, one child in flight, already decided">
        <Slot>
          <GroupCard group={group} steps={groupSteps} onDecideAll={() => later(700)().then(() => [])} onDecideStep={later(700)} onOpenSession={open} />
        </Slot>
        <Slot>
          <GroupCard group={groupRunning} steps={groupRunningSteps} live={liveAll} onDecideAll={() => Promise.resolve([])} onDecideStep={later(1)} onOpenSession={open} />
        </Slot>
        <Slot>
          <GroupCard group={{ ...group, id: 'g4' }} steps={groupSteps} onDecideAll={() => never()} onDecideStep={never} onOpenSession={open} />
        </Slot>
        <Slot>
          <GroupCard group={{ ...group, id: 'g5' }} steps={groupSteps} onDecideAll={() => Promise.reject(new ServerError('this group was already approved', 409))} onDecideStep={refuse(new ServerError('already approved', 409))} onOpenSession={open} />
        </Slot>
      </Group>
    )
  }
  if (which === 'results') {
    return (
      <Group title="Results cards: all done with details, timed out with a screen and a child that never started">
        <Slot>
          <ResultsCard event={results} live={liveAll} onReview={later(700)} onOpen={open} />
        </Slot>
        <Slot>
          <ResultsCard event={resultsLate} onReview={refuse(new ServerError('hp is not reachable. Check that its Yardbell is running.', 502))} onOpen={open} />
        </Slot>
      </Group>
    )
  }
  if (which === 'review') {
    const targets = () => later(300)().then(() => [{ machine: 'hp', name: 'yardbell-3' }, { machine: 'hp', name: 'yardbell-4' }])
    return (
      <Group title="Review summaries: findings (tick or untick, tap Low), ready, sent, dead code scan with targets">
        <Slot>
          <ReviewCard event={review} onSettle={later(700)} />
        </Slot>
        <Slot>
          <ReviewCard event={reviewReady} onSettle={later(1)} />
        </Slot>
        <Slot>
          <ReviewCard event={reviewDone} onSettle={later(1)} />
        </Slot>
        <Slot>
          <ReviewCard event={scan} onSettle={refuse(new ServerError('this scan was already sent', 409))} loadTargets={targets} />
        </Slot>
      </Group>
    )
  }
  return (
    <Group title="Trigger header (on, off, deleted, late, toggle fails), error">
      <Slot>
        <TriggerHeader trigger={triggerBase} standing={{ known: true, enabled: true }} onToggle={later(600)} />
      </Slot>
      <Slot>
        <TriggerHeader trigger={{ ...triggerBase, url: undefined, at: '2026-11-27T08:00:20+03:00' }} standing={{ known: true, enabled: false }} onToggle={refuse(new ServerError('the trigger could not be saved', 500))} />
      </Slot>
      <Slot>
        <TriggerHeader trigger={{ ...triggerBase, name: 'A trigger with an extremely long name that does not fit' }} standing="deleted" />
      </Slot>
      <Slot>
        <ErrorCard text="claude exited with status 1: the session could not start because the account has reached its limit for this window. Try again after 14:00." />
      </Slot>
    </Group>
  )
}


const styles = themedStyleSheet(() => ({
  group: { marginBottom: spacing.lg },
  title: { color: colors.textMuted, fontSize: 11, paddingHorizontal: spacing.lg, marginBottom: spacing.xs },
  slot: { paddingHorizontal: spacing.md, marginBottom: spacing.sm }
}))
