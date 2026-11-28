import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { routeIfSignedOut } from '../api/signedOut'
import { useAppActive } from '../ui/useAppActive'
import type { PairedServer } from '../servers/store'
import {
  answerSession,
  ask,
  decideAll,
  decideGroup,
  decideReview,
  decideStep,
  followTurn,
  getConversation,
  isAlreadyDecided,
  requestReview,
  reviewTargets,
  savePrompt,
  sendToSession,
  startScan,
  stopConversation,
  type ReviewDecision
} from './api'
import {
  hasNews,
  isOlder,
  mergeStreamed,
  replaceAt,
  replaceSteps,
  sentEvent,
  settledText,
  STREAM_CHECK_MS,
  streamStalled,
  withdrawnCount,
  withdrawnText
} from './chatModel'
import { BUSY_TEXT, type SendPayload } from './composer'
import type { ActionEvent, Backend, Conversation, Decision, DispatchEvent, ReviewTarget, SavedPrompt, TrackedSession, Trigger } from './types'

const CATCH_UP_MS = 5000

type Phase = 'idle' | 'sending' | 'streaming' | 'following'

export type Notice = { tone: 'error' | 'info'; text: string }

export type ChatMeta = {
  title: string
  sessions: TrackedSession[]
  trigger: Trigger | null
  backend?: Backend
}

export type CardActions = {
  decide: (step: ActionEvent, decision: Decision, input?: Record<string, unknown>, again?: boolean) => Promise<void>
  answer: (index: number, key: string) => Promise<void>
  review: (index: number, child?: number) => Promise<void>
  scan: (index: number, kind: 'dead_code' | 'test_gaps' | 'security') => Promise<void>
  sendPull: (index: number) => Promise<void>
  settleReview: (index: number, body: ReviewDecision) => Promise<void>
  loadTargets: (index: number) => Promise<ReviewTarget[]>
  decideGroup: (group: string, decision: Decision) => Promise<ActionEvent[]>
  saveVersion: (prompt: SavedPrompt, text: string) => Promise<SavedPrompt[]>
}

const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : String(error))

const EMPTY_META: ChatMeta = { title: '', sessions: [], trigger: null }

export function useConversation(server: PairedServer, routeId: string, onCreated: (id: string) => void, onMoved: (id: string) => void) {
  const fresh = routeId === 'new' ? null : routeId
  const [id, setId] = useState<string | null>(fresh)
  const [meta, setMeta] = useState<ChatMeta>(EMPTY_META)
  const [events, setEvents] = useState<DispatchEvent[]>([])
  const [busy, setBusyState] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [since, setSince] = useState<number | null>(null)
  const [loading, setLoading] = useState(fresh !== null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const idRef = useRef(fresh)
  const eventsRef = useRef<DispatchEvent[]>([])
  const shown = useRef({ updated: '', count: 0 })
  const phase = useRef<Phase>('idle')
  const busyRef = useRef(false)
  const stream = useRef<AbortController | null>(null)
  const following = useRef<AbortController | null>(null)
  const alive = useRef(true)
  const openedNext = useRef(true)
  const foreground = useAppActive()
  const generation = useRef(0)
  const callbacks = useRef({ onCreated, onMoved })
  callbacks.current = { onCreated, onMoved }

  const update = useCallback((change: (list: DispatchEvent[]) => DispatchEvent[]) => {
    const next = change(eventsRef.current)
    if (next === eventsRef.current) return
    eventsRef.current = next
    setEvents(next)
  }, [])

  // A reply sent before a change made here, or older than what is shown, would bring back a step
  // that was just decided, so it is dropped and the next load brings the current list.
  const local = useCallback(
    (change: (list: DispatchEvent[]) => DispatchEvent[]) => {
      generation.current += 1
      update(change)
    },
    [update]
  )

  const isFresh = useCallback(
    (conversation: Conversation, asked: number) => asked === generation.current && !isOlder(shown.current.updated, conversation.updated),
    []
  )

  const setBusy = useCallback((on: boolean) => {
    busyRef.current = on
    setBusyState(on)
    if (!on) setSince(null)
    else setSince((at) => at ?? Date.now())
  }, [])

  const adopt = useCallback(
    (conversation: Conversation) => {
      setMeta({
        title: conversation.title,
        sessions: conversation.sessions ?? [],
        trigger: conversation.trigger ?? null,
        backend: conversation.backend
      })
      if (hasNews(shown.current, conversation) || conversation.events.length !== eventsRef.current.length) {
        update(() => conversation.events.slice())
      } else {
        update((list) => replaceSteps(list, conversation.events))
      }
      shown.current = { updated: conversation.updated, count: conversation.events.length }
    },
    [update]
  )

  const fail = useCallback(
    (error: unknown, what: string) => {
      if (routeIfSignedOut(error, server.id)) return
      setNotice({ tone: 'error', text: `${what}: ${messageOf(error)}` })
    },
    [server.id]
  )

  const follow = useCallback(
    async (cid: string) => {
      if (phase.current !== 'idle' || !alive.current) return
      phase.current = 'following'
      setBusy(true)
      const controller = new AbortController()
      following.current = controller
      let asked = generation.current
      try {
        const done = await followTurn(server, cid, {
          signal: controller.signal,
          onUpdate: (conversation) => {
            if (!alive.current || idRef.current !== cid || !conversation.busy) return
            if (isFresh(conversation, asked)) adopt(conversation)
            asked = generation.current
          }
        })
        if (done && alive.current && idRef.current === cid) {
          const current = isFresh(done, asked)
          if (current) adopt(done)
          setBusy(false)
          if (!current) void loadRef.current()
        }
      } catch (error) {
        if (alive.current) {
          fail(error, 'Could not follow the reply')
          setBusy(false)
        }
      } finally {
        if (following.current === controller) following.current = null
        if (phase.current === 'following') phase.current = 'idle'
      }
    },
    [server, adopt, fail, setBusy, isFresh]
  )

  const load = useCallback(async () => {
    const cid = idRef.current
    if (!cid) return
    const asked = generation.current
    try {
      const opened = openedNext.current
      openedNext.current = false
      const conversation = await getConversation(server, cid, opened)
      if (!alive.current || idRef.current !== cid) return
      setLoadError(null)
      if (!isFresh(conversation, asked)) return
      if (phase.current === 'sending' || phase.current === 'streaming') {
        update((list) => replaceSteps(list, conversation.events))
        return
      }
      adopt(conversation)
      if (conversation.busy) void follow(cid)
      else if (phase.current === 'idle' && busyRef.current) setBusy(false)
    } catch (error) {
      if (!alive.current || routeIfSignedOut(error, server.id)) return
      if (shown.current.updated) setNotice({ tone: 'error', text: `Could not refresh the chat: ${messageOf(error)}` })
      else setLoadError(messageOf(error))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [server, adopt, follow, update, setBusy, isFresh])
  const loadRef = useRef(load)
  loadRef.current = load

  const syncSteps = useCallback(
    async (cid: string, before: DispatchEvent[]) => {
      const asked = generation.current
      try {
        const conversation = await getConversation(server, cid)
        if (!alive.current || idRef.current !== cid || asked !== generation.current) return
        const withdrawn = withdrawnCount(before, conversation.events)
        update((list) => replaceSteps(list, conversation.events))
        if (withdrawn > 0) setNotice({ tone: 'info', text: withdrawnText(withdrawn) })
      } catch {
        // The turn's end replaces every event with the server's, withdrawn steps included.
      }
    },
    [server, update]
  )

  const send = useCallback(
    async ({ text, attachments, task, improve }: SendPayload) => {
      if (busyRef.current || phase.current !== 'idle') throw new Error(BUSY_TEXT)
      const before = eventsRef.current
      const sent = sentEvent(text, attachments, task, improve)
      local((list) => [...list, sent])
      phase.current = 'sending'
      setBusy(true)
      setNotice(null)
      const controller = new AbortController()
      stream.current = controller
      let cid = idRef.current
      let started = false
      let lastLineAt = Date.now()
      let watchdog: ReturnType<typeof setInterval> | undefined
      const watch = (conversationId: string) => {
        watchdog = setInterval(() => {
          void (async () => {
            const serverBusy = await getConversation(server, conversationId).then(
              (c) => c.busy,
              () => null
            )
            if (stream.current === controller && streamStalled(lastLineAt, Date.now(), serverBusy)) controller.abort()
          })()
        }, STREAM_CHECK_MS)
      }
      try {
        await ask(
          server,
          { ...(cid ? { conversation: cid } : {}), text, ...(task ? { task } : {}), ...(improve ? { improve } : {}), ...(attachments.length ? { attachments } : {}) },
          {
            signal: controller.signal,
            onConversation: (next) => {
              lastLineAt = Date.now()
              if (!started) watch(next)
              started = true
              phase.current = 'streaming'
              setStreaming(true)
              cid = next
              if (idRef.current !== next) {
                idRef.current = next
                setId(next)
                callbacks.current.onCreated(next)
              }
              void syncSteps(next, before)
            },
            onEvent: (event) => {
              lastLineAt = Date.now()
              if (alive.current) update((list) => mergeStreamed(list, event))
            }
          }
        )
      } catch (error) {
        if (!started) {
          phase.current = 'idle'
          stream.current = null
          update((list) => list.filter((e) => e !== sent))
          setBusy(false)
          if (routeIfSignedOut(error, server.id)) return
          void load()
          throw error
        }
      } finally {
        clearInterval(watchdog)
        if (stream.current === controller) stream.current = null
        if (alive.current) setStreaming(false)
      }
      if (!alive.current) return
      phase.current = 'idle'
      if (!started || !cid) {
        update((list) => list.filter((e) => e !== sent))
        setBusy(false)
        void load()
        throw new Error('The server closed the reply before it started. Check the chat, then send again.')
      }
      void follow(cid)
    },
    [server, update, local, setBusy, syncSteps, follow, load]
  )

  const stop = useCallback(async () => {
    const cid = idRef.current
    if (!cid) return
    try {
      await stopConversation(server, cid)
    } catch (error) {
      fail(error, 'Could not stop Dispatch')
    }
  }, [server, fail])

  const resume = useCallback(
    (fromBackground: boolean) => {
      const cid = idRef.current
      if (!cid || !alive.current) return
      if (phase.current === 'streaming') {
        // A stream held across the background may be dead without an error, so the turn is followed
        // by polling instead, which replaces the events with the server's.
        if (fromBackground) stream.current?.abort()
        return
      }
      if (phase.current === 'idle') void load()
    },
    [load]
  )

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      stream.current?.abort()
      following.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (routeId === 'new' || routeId === idRef.current) return
    stream.current?.abort()
    following.current?.abort()
    phase.current = 'idle'
    idRef.current = routeId
    shown.current = { updated: '', count: 0 }
    openedNext.current = true
    eventsRef.current = []
    setEvents([])
    setMeta(EMPTY_META)
    setId(routeId)
    setBusy(false)
    setLoading(true)
    setNotice(null)
    void load()
  }, [routeId, load, setBusy])

  useFocusEffect(
    useCallback(() => {
      openedNext.current = true
      resume(false)
    }, [resume])
  )

  useFocusEffect(
    useCallback(() => {
      if (!foreground) return
      const timer = setInterval(() => {
        if (phase.current === 'idle' && !busyRef.current) void load()
      }, CATCH_UP_MS)
      return () => clearInterval(timer)
    }, [load, foreground])
  )

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') resume(true)
    })
    return () => subscription.remove()
  }, [resume])

  const settle = useCallback(
    async (error: unknown) => {
      if (routeIfSignedOut(error, server.id)) return true
      if (!isAlreadyDecided(error)) return false
      setNotice({ tone: 'info', text: settledText(messageOf(error)) })
      await load()
      return true
    },
    [server.id, load]
  )

  const actions = useMemo<CardActions>(() => {
    const cid = () => {
      const current = idRef.current
      if (!current) throw new Error('The chat has not started yet')
      return current
    }
    const guard = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run()
      } catch (error) {
        await settle(error)
        throw error
      }
    }
    return {
      decide: (step, decision, input, again) =>
        guard(async () => {
          const out = await decideStep(server, cid(), step.id, { decision, ...(input ? { input } : {}), ...(again ? { again } : {}) })
          local((list) => replaceSteps(list, [out]))
        }),
      answer: (index, key) =>
        guard(async () => {
          const out = await answerSession(server, cid(), index, key)
          local((list) => replaceAt(list, index, out))
        }),
      review: (index, child) =>
        guard(async () => {
          const step = await requestReview(server, cid(), index, child)
          local((list) => mergeStreamed(list, step))
        }),
      scan: (index, kind) =>
        guard(async () => {
          const here = cid()
          const out = await startScan(server, { conversation: here, card: index, kind })
          if (out.conversation !== here) callbacks.current.onMoved(out.conversation)
          else local((list) => mergeStreamed(list, out.step))
        }),
      sendPull: (index) =>
        guard(async () => {
          const out = await sendToSession(server, cid(), index)
          local((list) => mergeStreamed(replaceAt(list, index, out.card), out.step))
        }),
      settleReview: (index, body) =>
        guard(async () => {
          const out = await decideReview(server, cid(), index, body)
          if ('step' in out) local((list) => mergeStreamed(replaceAt(list, index, out.card), out.step))
          else local((list) => replaceAt(list, index, out))
        }),
      loadTargets: (index) => reviewTargets(server, cid(), index).then((r) => r.sessions),
      decideGroup: (group, decision) =>
        guard(async () => {
          const out = await decideGroup(server, cid(), group, decision)
          local((list) => replaceSteps(list, out))
          return out
        }),
      saveVersion: (prompt, text) => savePrompt(server, { name: prompt.name, text, replacing: prompt.name })
    }
  }, [server, local, settle])

  const decideEvery = useCallback(
    async (decision: Decision) => {
      const cid = idRef.current
      if (!cid) return
      try {
        const out = await decideAll(server, cid, decision)
        local((list) => replaceSteps(list, out))
      } catch (error) {
        if (await settle(error)) return
        setNotice({ tone: 'error', text: `Could not ${decision === 'approve' ? 'approve' : 'reject'} the steps: ${messageOf(error)}` })
        await load()
      }
    },
    [server, local, settle, load]
  )

  return {
    id,
    meta,
    events,
    busy,
    streaming,
    since,
    loading,
    loadError,
    notice,
    dismissNotice: () => setNotice(null),
    reload: load,
    send,
    stop,
    decideEvery,
    actions
  }
}
