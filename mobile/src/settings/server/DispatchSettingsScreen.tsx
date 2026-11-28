import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Bot, Brain, Plus } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { NoticeBanner } from '../../changes/NoticeBanner'
import { ModelSheet } from '../../dispatch/composer/ModelSheet'
import { type ModelChoice } from '../../dispatch/composer/models'
import type { PairedServer } from '../../servers/store'
import { ActionButton } from '../../ui/ActionButton'
import { ConfirmModal } from '../../ui/ConfirmModal'
import { ListGroup } from '../../ui/ListGroup'
import { ListRow } from '../../ui/ListRow'
import { PageField } from '../../ui/PageField'
import { SectionHeader } from '../../ui/SectionHeader'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../../ui/theme'
import { SettingsScreen } from '../SettingsScreen'
import { installedAgents, setDispatchSettings, type DispatchRule, type DispatchSettings } from '../serverApi'
import {
  agentName,
  agentNote,
  AGENT_HELP,
  APPROVAL_CHOICES,
  choiceLabel,
  codexWarning,
  defaultAgentChoice,
  editRules,
  INSTRUCTIONS_HELP,
  INSTRUCTIONS_LIMIT,
  instructionsCounter,
  instructionsDirty,
  modelChoices,
  modelSummary,
  newSessionAgents,
  normalizeApproval,
  normalizeRule,
  RULES_HELP,
  ruleSummary,
  savedNotice,
  withTyped
} from './dispatchModel'
import { memoryHref } from './hrefs'
import { useMemory, useServerSettings, useSettingsTask } from './queries'
import { capBar } from './memoryModel'
import { Failed, Help, Loading, messageOf } from './parts'
import { RuleSheet } from './RuleSheet'

type Sheet = 'model' | 'agent' | null

export function DispatchSettingsScreen({ server, serverCount }: { server: PairedServer; serverCount: number }) {
  useColorScheme()
  const router = useRouter()
  const query = useServerSettings(server)
  const memory = useMemory(server)
  const settings = query.data
  const { busy: running, notice, setNotice, run, adopt } = useSettingsTask(server)
  const busy = running !== null
  const [pending, setPending] = useState<Partial<DispatchSettings>>({})
  const [sheet, setSheet] = useState<Sheet>(null)
  const [editing, setEditing] = useState<{ rule: DispatchRule | null } | null>(null)
  const [deleting, setDeleting] = useState<DispatchRule | null>(null)

  const saved = settings?.dispatch ?? {}
  const d: DispatchSettings = { ...saved, ...pending }
  const runsOn = d.runs_on || 'claude'
  const machines = (settings?.machines ?? []).map((m) => m.name)
  const here = settings?.machines?.find((m) => m.local)

  const found = useQuery({
    queryKey: ['server-agents', server.id, machines.join(',')],
    queryFn: async () => {
      const entries = await Promise.all(
        machines.map((name) =>
          installedAgents(server, name).then(
            (list): [string, string[]] => [name, list],
            () => null
          )
        )
      )
      return Object.fromEntries(entries.filter((e): e is [string, string[]] => e !== null))
    },
    enabled: machines.length > 0,
    meta: { serverId: server.id }
  })
  const installed = found.data && Object.keys(found.data).length > 0 ? found.data : null
  const footprint = here && installed?.[here.name] ? { here: here.name, installed: installed[here.name] } : null

  const [draft, setDraft] = useState('')
  const savedInstructions = saved.instructions
  const [draftTouched, setDraftTouched] = useState(false)
  useEffect(() => {
    if (!draftTouched) setDraft(savedInstructions ?? '')
  }, [savedInstructions, draftTouched])

  const save = (name: string, change: Parameters<typeof setDispatchSettings>[1]) =>
    run(name, async () => {
      if (typeof change !== 'function') setPending(change)
      try {
        const next = await setDispatchSettings(server, change)
        adopt(next)
        const label = agentName(next, next.dispatch?.runs_on)
        setNotice({ kind: 'info', text: savedNotice(saved.runs_on, next.dispatch?.runs_on, label) })
        return next
      } finally {
        setPending({})
      }
    })

  const saveRule = async (before: DispatchRule | null, after: DispatchRule) => {
    const out = await save('rule', (current) => ({ rules: editRules(current.rules, before, after) }))
    if (out) setEditing(null)
  }

  const removeRule = async (rule: DispatchRule) => {
    setDeleting(null)
    const out = await save('rule', (current) => ({ rules: editRules(current.rules, rule, null) }))
    if (out) setEditing(null)
  }

  const saveInstructions = async () => {
    const out = await save('instructions', { instructions: draft })
    if (out) setDraftTouched(false)
  }

  const label = agentName(settings, runsOn)
  const modelId = (runsOn === 'codex' ? d.codex_model : d.model) ?? ''
  const claudeChoices = withTyped(modelChoices(runsOn, settings, label), modelId)
  const agentChoices: ModelChoice[] = [defaultAgentChoice(settings), ...newSessionAgents(settings, installed, d.agent ?? '')]
  const approval = normalizeApproval(d.approval)
  const rules = (d.rules ?? []).map(normalizeRule)
  const warning = codexWarning(runsOn, modelId, settings?.codex_models)
  const missing = footprint && !footprint.installed.includes(runsOn)
  const counter = instructionsCounter(draft)
  const dirty = instructionsDirty(draft, savedInstructions)
  const approvalWord = APPROVAL_CHOICES.find((x) => x.id === approval) ?? APPROVAL_CHOICES[0]
  const memoryBar = memory.data ? capBar(memory.data) : null

  let body
  if (query.isPending) body = <Loading title="Loading Dispatch settings" />
  else if (!settings) body = <Failed message={messageOf(query.error, 'Could not read the Dispatch settings.')} onRetry={() => void query.refetch()} />
  else
    body = (
      <>
        {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}
        {serverCount > 1 ? <SectionHeader title={server.machine} first /> : null}
        <View style={styles.summary}>
          <View style={styles.summaryIcon}>
            <Bot size={20} color={colors.textSecondary} strokeWidth={1.9} />
          </View>
          <View style={styles.summaryText}>
            <Text style={styles.summaryTitle} numberOfLines={1}>
              {label}
              <Text style={styles.summaryModel}>{` · ${modelSummary({ ...settings, dispatch: d })}`}</Text>
            </Text>
            <Text style={styles.summaryMeta}>
              {`${approvalWord.label}: ${approvalWord.detail}${rules.length ? ` · ${rules.length === 1 ? '1 rule' : `${rules.length} rules`}` : ''}`}
            </Text>
            {missing ? <Text style={styles.summaryWarn}>{`${label} is not installed on ${footprint.here}, where Dispatch runs, so it cannot answer until it is.`}</Text> : null}
          </View>
        </View>

        <SectionHeader title="Agent" />
        <ListGroup>
          {(settings.dispatch_runs_on ?? ['claude']).map((name) => {
            const note = agentNote(footprint, name)
            return (
              <ListRow
                key={name}
                title={agentName(settings, name)}
                subtitle={note.text}
                subtitleColor={note.missing ? colors.statusRed : undefined}
                selected={runsOn === name}
                disabled={busy}
                onPress={() => void save('agent', { runs_on: name })}
              />
            )
          })}
        </ListGroup>
        <ListGroup style={styles.gap}>
          <ListRow key="model" title="Model" value={choiceLabel(claudeChoices, modelId)} navigates disabled={busy} onPress={() => setSheet('model')} />
          <ListRow
            key="new"
            title="Agent for new sessions"
            value={choiceLabel(agentChoices, d.agent ?? '')}
            navigates
            disabled={busy}
            onPress={() => setSheet('agent')}
          />
        </ListGroup>
        {warning ? <Help tone="warn">{warning}</Help> : null}
        <Help>{AGENT_HELP}</Help>

        <SectionHeader title="Approvals" />
        <ListGroup>
          {APPROVAL_CHOICES.map((x) => (
            <ListRow key={x.id} title={x.label} subtitle={x.detail} selected={approval === x.id} disabled={busy} onPress={() => void save('approval', { approval: x.id })} />
          ))}
        </ListGroup>

        <SectionHeader title="Rules" />
        <ListGroup>
          {rules.map((rule, at) => {
            const words = ruleSummary(rule)
            return <ListRow key={`rule-${at}`} title={words.title} subtitle={words.detail} navigates disabled={busy} onPress={() => setEditing({ rule })} />
          })}
          <ListRow
            key="add"
            title="Add rule"
            leading={<Plus size={18} color={colors.accentBlue} strokeWidth={2.2} />}
            accent
            disabled={busy}
            onPress={() => setEditing({ rule: null })}
          />
        </ListGroup>
        <Help>{rules.length ? RULES_HELP : `No rules. Every step follows the approval above. ${RULES_HELP}`}</Help>

        <SectionHeader title="Instructions" />
        <PageField
          value={draft}
          onChangeText={(text) => {
            setDraftTouched(true)
            setDraft(text)
          }}
          multiline
          maxLength={INSTRUCTIONS_LIMIT}
          placeholder={'acme/web work goes to devbox unless it is down.\nStart frontend tasks with codex.'}
          autoCapitalize="sentences"
          accessibilityLabel="Instructions"
          style={styles.area}
        />
        <View style={styles.counterRow}>
          <Text style={styles.counterHelp}>{INSTRUCTIONS_HELP}</Text>
          <Text style={[styles.counter, counter.tone === 'near' && styles.counterNear, counter.tone === 'full' && styles.counterFull]} accessibilityLabel={`${draft.length} of ${INSTRUCTIONS_LIMIT} characters`}>
            {counter.text}
          </Text>
        </View>
        {dirty ? (
          <View style={styles.actions}>
            <ActionButton
              label="Discard"
              variant="ghost"
              disabled={busy}
              onPress={() => {
                setDraft(savedInstructions ?? '')
                setDraftTouched(false)
              }}
            />
            <ActionButton label="Save instructions" busy={running === 'instructions'} onPress={() => void saveInstructions()} />
          </View>
        ) : null}

        <SectionHeader title="Memory" />
        <ListGroup>
          <ListRow
            key="memory"
            title="Memory"
            leading={<Brain size={18} color={colors.textSecondary} strokeWidth={2} />}
            value={memoryBar ? `${memoryBar.percent}% used` : undefined}
            navigates
            onPress={() => router.push(memoryHref(server.id) as never)}
          />
        </ListGroup>
        <Help>What Dispatch has learned about where repositories live, conventions and your corrections.</Help>

        <ModelSheet
          visible={sheet === 'model'}
          models={claudeChoices}
          current={modelId}
          agentLabel={label}
          allowCustom={runsOn === 'codex'}
          note={runsOn === 'codex' ? 'Pick one Codex lists for your account, or type another.' : 'The model Dispatch thinks with. Sessions it starts pick their own.'}
          onPick={(id) => void save('model', runsOn === 'codex' ? { codex_model: id.trim() } : { model: id })}
          onClose={() => setSheet(null)}
        />
        <ModelSheet
          visible={sheet === 'agent'}
          models={agentChoices}
          current={d.agent ?? ''}
          agentLabel={server.machine}
          title="Agent for new sessions"
          searchLabel="agents"
          note="What Dispatch starts when you don't name an agent."
          onPick={(id) => void save('new-agent', { agent: id })}
          onClose={() => setSheet(null)}
        />
        <RuleSheet
          visible={editing !== null}
          rule={editing?.rule ?? null}
          machines={machines}
          busy={busy}
          onSave={(before, after) => void saveRule(before, after)}
          onDelete={setDeleting}
          onClose={() => setEditing(null)}
        />
        <ConfirmModal
          visible={deleting !== null}
          title="Delete this rule?"
          message={deleting ? `${ruleSummary(deleting).title}: ${ruleSummary(deleting).detail}. Steps then follow the approval above.` : undefined}
          confirmLabel="Delete"
          destructive
          onConfirm={() => deleting && void removeRule(deleting)}
          onCancel={() => setDeleting(null)}
        />
      </>
    )

  return <SettingsScreen title="Dispatch">{body}</SettingsScreen>
}

const styles = themedStyleSheet(() => ({
  summary: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup
  },
  summaryIcon: { width: 40, height: 40, borderRadius: radii.control, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgRaised },
  summaryText: { flex: 1, minWidth: 0, gap: 2 },
  summaryTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  summaryModel: { fontWeight: '400', color: colors.textSecondary },
  summaryMeta: { fontSize: 12, lineHeight: 17, color: colors.textSecondary },
  summaryWarn: { fontSize: 12, lineHeight: 17, color: colors.statusRed, marginTop: 2 },
  gap: { marginTop: spacing.md },
  area: { minHeight: 140, paddingTop: spacing.md, textAlignVertical: 'top', fontFamily: typography.monoFamily, fontSize: 13, lineHeight: 19 },
  counterRow: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.xs, paddingTop: spacing.sm },
  counterHelp: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  counter: { fontSize: 13, fontVariant: ['tabular-nums'], color: colors.textMuted },
  counterNear: { color: colors.statusAmber },
  counterFull: { color: colors.statusRed },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, paddingTop: spacing.md }
}))
