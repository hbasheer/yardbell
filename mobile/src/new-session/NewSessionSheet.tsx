import { useQueries, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { ArrowUp, Folder, FolderGit2, GitBranch, GitBranchPlus, Server } from 'lucide-react-native'
import { browseFolder, folderBranches, installedAgents, newSession } from '../api/client'
import type { PairedServer } from '../servers/store'
import type { StateView } from '../state/types'
import { stateQuery } from '../state/useServerState'
import type { ServerSession } from '../state/views'
import { BottomDrawer } from '../ui/BottomDrawer'
import { ListGroup } from '../ui/ListGroup'
import { ListRow } from '../ui/ListRow'
import { SearchField } from '../ui/SearchField'
import { SectionHeader } from '../ui/SectionHeader'
import { SheetHeader } from '../ui/SheetHeader'
import { LoadErrorState, StateView as EmptyState } from '../ui/StateView'
import { triggerError, triggerSuccess } from '../ui/haptics'
import { colors, feedback, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { AgentTiles } from './AgentTiles'
import {
  buildNewSessionBody,
  folderLabel,
  isValidBranchName,
  joinPath,
  makeGate,
  setupWarning,
  startingNote,
  parentPath,
  projectFolders,
  startBlocker,
  type Branches,
  type BranchChoice,
  type NewSessionOpen,
  type Started
} from './request'

type Page = 'main' | 'machine' | 'folder' | 'branch' | 'new-branch'
type Target = { serverId: string; machine: string }

type Props = {
  visible: boolean
  request: NewSessionOpen
  servers: PairedServer[]
  onClose: () => void
  onAfterClose: () => void
  onStarted: (server: PairedServer, started: Started) => void
}

function machinesOf(state: StateView | undefined): string[] {
  if (!state) return []
  return state.machines.filter((machine) => machine.up).map((machine) => machine.name)
}

function sessionsOf(server: PairedServer, state: StateView | undefined): ServerSession[] {
  return (state?.sessions ?? []).map((session) => ({ ...session, serverId: server.id }))
}

export function NewSessionSheet({ visible, request, servers, onClose, onAfterClose, onStarted }: Props) {
  useColorScheme()
  const states = useQueries({ queries: servers.map(stateQuery) })
  const stateOf = (serverId: string) => states[servers.findIndex((server) => server.id === serverId)]?.data

  const options = useMemo(
    () =>
      servers.flatMap((server, index) =>
        machinesOf(states[index]?.data).map((machine) => ({ serverId: server.id, machine }))
      ),
    [servers, states]
  )

  const preset = useMemo<Target | null>(() => {
    if (!request.machine) return null
    const match = options.find(
      (option) => option.machine === request.machine && (!request.serverId || option.serverId === request.serverId)
    )
    return match ?? null
  }, [options, request.machine, request.serverId])

  const [picked, setPicked] = useState<Target | null>(null)
  const target = picked ?? preset ?? options[0] ?? null
  const server = target ? servers.find((s) => s.id === target.serverId) : undefined
  const state = target ? stateOf(target.serverId) : undefined

  const [page, setPage] = useState<Page>('main')
  const [folder, setFolder] = useState<string | null>(request.folder ?? null)
  const [branch, setBranch] = useState<BranchChoice>({ kind: 'stay' })
  const [agent, setAgent] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warned, setWarned] = useState<{ server: PairedServer; started: Started; warning: string } | null>(null)
  const gate = useRef(makeGate()).current

  const machine = target?.machine ?? ''
  const root = useQuery({
    queryKey: ['new-session', 'browse', server?.id, machine, ''],
    queryFn: () => browseFolder(server!, machine, ''),
    enabled: visible && !!server
  })

  const projects = useMemo(
    () => (server ? projectFolders(sessionsOf(server, state), machine) : []),
    [server, state, machine]
  )
  const recent = root.data?.recent ?? []
  const path = folder ?? projects[0] ?? recent[0] ?? root.data?.path ?? ''

  const listing = useQuery({
    queryKey: ['new-session', 'browse', server?.id, machine, path],
    queryFn: () => browseFolder(server!, machine, path),
    enabled: visible && !!server && !!path
  })
  const isGit = listing.data?.git === true
  const branches = useQuery({
    queryKey: ['new-session', 'branches', server?.id, machine, path],
    queryFn: () => folderBranches(server!, machine, path),
    enabled: visible && !!server && !!path && isGit
  })

  const installed = useQuery({
    queryKey: ['new-session', 'agents', server?.id, machine],
    queryFn: () => installedAgents(server!, machine),
    enabled: visible && !!server
  })
  const agents = useMemo(() => {
    const all = state?.agents ?? []
    const list = installed.data ? all.filter((a) => installed.data.installed.includes(a.name)) : all
    return list.length ? list : all
  }, [state?.agents, installed.data])
  const chosenAgent =
    agent && agents.some((a) => a.name === agent)
      ? agent
      : (agents.find((a) => a.name === state?.default_agent) ?? agents[0])?.name ?? ''

  useEffect(() => {
    setBranch({ kind: 'stay' })
  }, [path, machine])

  const effectiveBranch: BranchChoice = isGit ? branch : { kind: 'stay' }
  const choice = { machine, path, agent: chosenAgent, branch: effectiveBranch }
  const blocker = startBlocker(choice)

  const pickMachine = (next: Target) => {
    if (next.serverId !== target?.serverId || next.machine !== machine) {
      setPicked(next)
      setFolder(null)
      setAgent(null)
    }
    setPage('main')
  }

  const start = async () => {
    if (warned) return onStarted(warned.server, warned.started)
    if (!server || blocker || !gate.enter()) return
    setSending(true)
    setError(null)
    try {
      const started = await newSession(server, buildNewSessionBody(choice))
      triggerSuccess()
      const warning = setupWarning(started)
      if (warning) {
        setWarned({ server, started, warning })
        setSending(false)
        gate.leave()
        return
      }
      onStarted(server, started)
    } catch (e) {
      triggerError()
      setError(e instanceof Error ? e.message : 'Could not start the session')
      setSending(false)
      gate.leave()
    }
  }

  const goBack = () => setPage(page === 'new-branch' ? 'branch' : 'main')
  const serverLabel = (serverId: string) => servers.find((s) => s.id === serverId)?.machine ?? serverId

  return (
    <BottomDrawer visible={visible} onClose={onClose} onAfterClose={onAfterClose}>
      {page === 'main' ? (
        <MainPage
          machine={machine}
          serverName={target && servers.length > 1 && serverLabel(target.serverId) !== machine ? serverLabel(target.serverId) : undefined}
          canPickMachine={options.length > 1}
          path={path}
          pathLoading={!path && (root.isLoading || root.isFetching)}
          isGit={isGit}
          branch={effectiveBranch}
          current={branches.data?.current || listing.data?.branch || ''}
          agents={agents}
          agentsLoading={!state}
          chosenAgent={chosenAgent}
          noMachines={options.length === 0}
          sending={sending}
          note={sending ? startingNote(effectiveBranch) : null}
          warning={warned?.warning ?? null}
          blocker={blocker}
          error={error}
          onClose={onClose}
          onMachine={() => setPage('machine')}
          onFolder={() => setPage('folder')}
          onBranch={() => setPage('branch')}
          onAgent={setAgent}
          onStart={start}
        />
      ) : page === 'machine' ? (
        <>
          <SheetHeader title="Machine" onBack={{ label: 'Back', onPress: goBack }} />
          <ListGroup>
            {options.map((option) => (
              <ListRow
                key={`${option.serverId}:${option.machine}`}
                title={option.machine}
                subtitle={servers.length > 1 ? `on ${serverLabel(option.serverId)}` : undefined}
                leading={<Server size={18} color={colors.textSecondary} />}
                selected={option.serverId === target?.serverId && option.machine === machine}
                onPress={() => pickMachine(option)}
              />
            ))}
          </ListGroup>
        </>
      ) : page === 'folder' && server ? (
        <FolderPage
          server={server}
          machine={machine}
          start={path}
          projects={projects}
          recent={recent}
          onBack={goBack}
          onPick={(next) => {
            setFolder(next)
            setPage('main')
          }}
        />
      ) : page === 'branch' ? (
        <BranchPage
          branches={branches.data}
          loading={branches.isLoading}
          failed={branches.isError ? branches.error.message : null}
          choice={effectiveBranch}
          onBack={goBack}
          onRetry={() => void branches.refetch()}
          onStay={() => {
            setBranch({ kind: 'stay' })
            setPage('main')
          }}
          onExisting={(name) => {
            setBranch({ kind: 'existing', name })
            setPage('main')
          }}
          onNew={() => setPage('new-branch')}
        />
      ) : page === 'new-branch' && branches.data ? (
        <NewBranchPage
          branches={branches.data}
          initial={effectiveBranch.kind === 'new' ? effectiveBranch : null}
          onBack={goBack}
          onDone={(name, base) => {
            setBranch({ kind: 'new', name, base })
            setPage('main')
          }}
        />
      ) : null}
    </BottomDrawer>
  )
}

function branchValue(branch: BranchChoice, current: string): string {
  if (branch.kind === 'stay') return current ? `Stay on ${current}` : 'Stay on current'
  if (branch.kind === 'existing') return branch.name
  return `New: ${branch.name || '...'}`
}

function MainPage(props: {
  machine: string
  serverName?: string
  canPickMachine: boolean
  path: string
  pathLoading: boolean
  isGit: boolean
  branch: BranchChoice
  current: string
  agents: { name: string; label: string }[]
  agentsLoading: boolean
  chosenAgent: string
  noMachines: boolean
  sending: boolean
  note: string | null
  warning: string | null
  blocker: string | null
  error: string | null
  onClose: () => void
  onMachine: () => void
  onFolder: () => void
  onBranch: () => void
  onAgent: (name: string) => void
  onStart: () => void
}) {
  useColorScheme()
  const disabled = (props.blocker !== null && !props.warning) || props.sending
  return (
    <View>
      <SheetHeader title="New session" subtitle={props.machine || undefined} onClose={props.onClose} />
      {props.noMachines ? (
        <EmptyState icon={Server} title="No machine is up" message="Start a session once a machine is connected." />
      ) : (
        <View style={styles.body}>
          <ListGroup>
            <ListRow
              key="machine"
              title="Machine"
              value={props.serverName ? `${props.machine} on ${props.serverName}` : props.machine}
              leading={<Server size={18} color={colors.textSecondary} />}
              navigates={props.canPickMachine}
              onPress={props.canPickMachine ? props.onMachine : undefined}
            />
            <ListRow
              key="folder"
              title="Folder"
              value={props.path ? folderLabel(props.path) : props.pathLoading ? 'Loading...' : 'Choose'}
              leading={<Folder size={18} color={colors.textSecondary} />}
              navigates
              onPress={props.onFolder}
            />
            {props.isGit ? (
              <ListRow
                key="branch"
                title="Branch"
                value={branchValue(props.branch, props.current)}
                leading={<GitBranch size={18} color={colors.textSecondary} />}
                navigates
                onPress={props.onBranch}
              />
            ) : null}
          </ListGroup>
          {props.path ? (
            <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
              {props.path}
            </Text>
          ) : null}
          <SectionHeader title="Agent" />
          {props.agentsLoading ? (
            <ActivityIndicator size="small" color={colors.textSecondary} style={styles.loading} />
          ) : props.agents.length === 0 ? (
            <Text style={styles.note}>This server lists no agents.</Text>
          ) : (
            <AgentTiles agents={props.agents} selected={props.chosenAgent} onPick={props.onAgent} />
          )}
          {props.note ? <Text style={styles.note}>{props.note}</Text> : null}
          {props.warning ? <Text style={styles.error}>{props.warning}</Text> : null}
          {props.error ? (
            <Text style={styles.error} accessibilityRole="alert">
              {props.error}
            </Text>
          ) : null}
          <Pressable
            onPress={props.onStart}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Start"
            accessibilityState={{ disabled, busy: props.sending }}
            style={({ pressed }) => [styles.start, disabled && styles.startDisabled, pressed && styles.startPressed]}
          >
            {props.sending ? (
              <ActivityIndicator size="small" color={colors.bgBase} />
            ) : (
              <Text style={styles.startLabel}>{props.warning ? 'Open session' : (props.blocker ?? 'Start')}</Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  )
}

function FolderPage({
  server,
  machine,
  start,
  projects,
  recent,
  onBack,
  onPick
}: {
  server: PairedServer
  machine: string
  start: string
  projects: string[]
  recent: string[]
  onBack: () => void
  onPick: (path: string) => void
}) {
  useColorScheme()
  const [at, setAt] = useState(start)
  const [find, setFind] = useState('')
  const listing = useQuery({
    queryKey: ['new-session', 'browse', server.id, machine, at],
    queryFn: () => browseFolder(server, machine, at)
  })
  const words = find.trim().toLowerCase()
  const keep = (path: string) => !words || path.toLowerCase().includes(words)
  const here = listing.data?.path ?? at
  const up = parentPath(here)
  const entries = (listing.data?.entries ?? []).filter((entry) => !words || entry.name.toLowerCase().includes(words))
  const shownProjects = projects.filter(keep)
  const shownRecent = recent.filter((path) => keep(path) && !projects.includes(path))

  return (
    <View>
      <SheetHeader
        title="Folder"
        onBack={{ label: 'Back', onPress: onBack }}
        trailing={{ label: 'Use', onPress: () => onPick(here), disabled: !listing.data }}
      />
      <View style={styles.body}>
        <SearchField value={find} onChangeText={setFind} placeholder="Filter folders" />
        {shownProjects.length ? (
          <>
            <SectionHeader title="Projects" />
            <ListGroup>
              {shownProjects.map((path) => (
                <ListRow
                  key={path}
                  title={folderLabel(path)}
                  subtitle={path}
                  subtitleMono
                  subtitleLines={1}
                  leading={<FolderGit2 size={18} color={colors.textSecondary} />}
                  selected={path === start}
                  onPress={() => onPick(path)}
                />
              ))}
            </ListGroup>
          </>
        ) : null}
        {shownRecent.length ? (
          <>
            <SectionHeader title="Recent" />
            <ListGroup>
              {shownRecent.map((path) => (
                <ListRow
                  key={path}
                  title={folderLabel(path)}
                  subtitle={path}
                  subtitleMono
                  subtitleLines={1}
                  leading={<Folder size={18} color={colors.textSecondary} />}
                  selected={path === start}
                  onPress={() => onPick(path)}
                />
              ))}
            </ListGroup>
          </>
        ) : null}
        <SectionHeader title="Browse" trailing={folderLabel(here)} />
        {listing.isLoading ? (
          <ActivityIndicator size="small" color={colors.textSecondary} style={styles.loading} />
        ) : listing.isError ? (
          <LoadErrorState message={listing.error.message} onRetry={() => void listing.refetch()} />
        ) : (
          <ListGroup>
            {[
              ...(up !== null
                ? [
                    <ListRow
                      key="up"
                      title="Parent folder"
                      leading={<ArrowUp size={18} color={colors.textSecondary} />}
                      onPress={() => setAt(up)}
                    />
                  ]
                : []),
              ...entries.map((entry) => (
                <ListRow
                  key={entry.name}
                  title={entry.name}
                  subtitle={entry.git && entry.branch ? entry.branch : undefined}
                  subtitleMono
                  subtitleLines={1}
                  leading={
                    entry.git ? (
                      <FolderGit2 size={18} color={colors.textSecondary} />
                    ) : (
                      <Folder size={18} color={colors.textSecondary} />
                    )
                  }
                  navigates
                  onPress={() => setAt(joinPath(here, entry.name))}
                />
              ))
            ]}
          </ListGroup>
        )}
      </View>
    </View>
  )
}

function BranchPage({
  branches,
  loading,
  failed,
  choice,
  onBack,
  onRetry,
  onStay,
  onExisting,
  onNew
}: {
  branches: Branches | undefined
  loading: boolean
  failed: string | null
  choice: BranchChoice
  onBack: () => void
  onRetry: () => void
  onStay: () => void
  onExisting: (name: string) => void
  onNew: () => void
}) {
  useColorScheme()
  const [find, setFind] = useState('')
  const words = find.trim().toLowerCase()
  const match = (name: string) => !words || name.toLowerCase().includes(words)
  const local = (branches?.local ?? []).filter(match)
  const remote = (branches?.remote ?? []).filter((name) => match(name) && !branches?.local.includes(name))
  const row = (name: string) => {
    const hasWorktree = branches?.worktrees[name] !== undefined
    return (
      <ListRow
        key={name}
        title={name}
        subtitle={name === branches?.current ? 'Current' : hasWorktree ? 'Has a worktree' : 'Opens in a worktree'}
        subtitleLines={1}
        selected={choice.kind === 'existing' && choice.name === name}
        onPress={() => onExisting(name)}
      />
    )
  }
  return (
    <View>
      <SheetHeader title="Branch" onBack={{ label: 'Back', onPress: onBack }} />
      <View style={styles.body}>
        {failed ? (
          <LoadErrorState message={failed} onRetry={onRetry} />
        ) : loading || !branches ? (
          <ActivityIndicator size="small" color={colors.textSecondary} style={styles.loading} />
        ) : (
          <>
            <ListGroup>
              <ListRow
                key="stay"
                title={branches.current ? `Stay on ${branches.current}` : 'Stay on current'}
                subtitle="Runs in the folder as it is"
                subtitleLines={1}
                leading={<GitBranch size={18} color={colors.textSecondary} />}
                selected={choice.kind === 'stay'}
                onPress={onStay}
              />
              <ListRow
                key="new"
                title="New branch"
                subtitle="Makes a worktree for it"
                subtitleLines={1}
                leading={<GitBranchPlus size={18} color={colors.textSecondary} />}
                selected={choice.kind === 'new'}
                navigates
                onPress={onNew}
              />
            </ListGroup>
            <SearchField value={find} onChangeText={setFind} placeholder="Filter branches" style={styles.gap} />
            {local.length ? (
              <>
                <SectionHeader title="Local" />
                <ListGroup>{local.map(row)}</ListGroup>
              </>
            ) : null}
            {remote.length ? (
              <>
                <SectionHeader title="Remote" />
                <ListGroup>{remote.map(row)}</ListGroup>
              </>
            ) : null}
            {!local.length && !remote.length ? <Text style={styles.note}>No branches match.</Text> : null}
          </>
        )}
      </View>
    </View>
  )
}

function NewBranchPage({
  branches,
  initial,
  onBack,
  onDone
}: {
  branches: Branches
  initial: { name: string; base: string } | null
  onBack: () => void
  onDone: (name: string, base: string) => void
}) {
  useColorScheme()
  const [name, setName] = useState(initial?.name ?? '')
  const [base, setBase] = useState(initial?.base || branches.default_base || branches.local[0] || '')
  const trimmed = name.trim()
  const invalid = trimmed.length > 0 && !isValidBranchName(trimmed)
  const bases = branches.local.length ? branches.local : branches.remote
  return (
    <View>
      <SheetHeader
        title="New branch"
        onBack={{ label: 'Back', onPress: onBack }}
        trailing={{ label: 'Done', onPress: () => onDone(trimmed, base), disabled: !trimmed || invalid || !base }}
      />
      <View style={styles.body}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="feature/name"
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.accentBlue}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="done"
          accessibilityLabel="Branch name"
          style={[styles.input, invalid && styles.inputInvalid]}
        />
        {invalid ? (
          <Text style={styles.error}>Branch names use letters, digits, dots, dashes and slashes.</Text>
        ) : null}
        <SectionHeader title="Based on" />
        <ListGroup>
          {bases.map((candidate) => (
            <ListRow
              key={candidate}
              title={candidate}
              selected={candidate === base}
              onPress={() => setBase(candidate)}
            />
          ))}
        </ListGroup>
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  body: { paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
  path: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: typography.monoFamily,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  loading: { paddingVertical: spacing.lg },
  note: { color: colors.textSecondary, fontSize: 13, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  error: { color: colors.statusRed, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  gap: { marginTop: spacing.md },
  start: {
    marginTop: spacing.lg,
    minHeight: 48,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg
  },
  startDisabled: { opacity: feedback.disabledOpacity },
  startPressed: { opacity: feedback.pressedOpacity },
  startLabel: { color: colors.bgBase, fontSize: 16, fontWeight: '600' },
  input: {
    minHeight: 48,
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup,
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: typography.monoFamily,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: 'transparent'
  },
  inputInvalid: { borderColor: colors.statusRed }
}))
