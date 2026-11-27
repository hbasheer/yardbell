import { RecordingPresets, getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Platform } from 'react-native'
import { routeIfSignedOut } from '../../api/signedOut'
import type { PairedServer } from '../../servers/store'
import { triggerError, triggerSelection } from '../../ui/haptics'
import { transcribe } from '../api'
import { MAX_RECORDING_MS, NOTHING_HEARD, RECORDING_MIME, abortsOnBackground, onRelease, tooShort, type MicMode } from './model'

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

type Handlers = {
  mode: MicMode
  onText: (text: string) => void
  onProblem: (text: string) => void
  onDenied: () => void
}

const messageOf = (error: unknown) => (error instanceof Error && error.message ? error.message : String(error))

export function useDictation(server: PairedServer, { mode, onText, onProblem, onDenied }: Handlers) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY)
  const [phase, setPhaseState] = useState<DictationPhase>('idle')
  const phaseRef = useRef<DictationPhase>('idle')
  const pressedAt = useRef(0)
  const pressStopping = useRef(false)
  const stopAfterStart = useRef(false)
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  const startedAt = useRef(0)
  const abortStart = useRef(false)
  const permissionPending = useRef(false)
  const handlers = useRef({ onText, onProblem, onDenied })
  handlers.current = { onText, onProblem, onDenied }

  const setPhase = useCallback((next: DictationPhase) => {
    phaseRef.current = next
    if (alive.current) setPhaseState(next)
  }, [])

  const clearLimit = () => {
    if (limit.current) clearTimeout(limit.current)
    limit.current = null
  }

  const finish = useCallback(async () => {
    clearLimit()
    setPhase('transcribing')
    try {
      const short = tooShort(startedAt.current, Date.now())
      await recorder.stop().catch((error) => {
        if (!short) throw error
      })
      if (short) {
        await setAudioModeAsync({ allowsRecording: false }).catch(() => {})
        return
      }
      const uri = recorder.uri
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {})
      if (!uri) throw new Error('The recording was not saved. Try again.')
      const audio = await (await fetch(uri)).blob()
      const { text } = await transcribe(server, audio, Platform.OS === 'web' ? 'audio/webm' : RECORDING_MIME)
      if (!alive.current) return
      if (text.trim()) handlers.current.onText(text)
      else handlers.current.onProblem(NOTHING_HEARD)
    } catch (error) {
      if (!alive.current || routeIfSignedOut(error, server.id)) return
      triggerError()
      handlers.current.onProblem(messageOf(error))
    } finally {
      setPhase('idle')
    }
  }, [recorder, server, setPhase])

  const start = useCallback(async () => {
    abortStart.current = false
    setPhase('starting')
    let prepared = false
    try {
      permissionPending.current = true
      let permission
      try {
        permission = await getRecordingPermissionsAsync()
        if (!permission.granted) permission = await requestRecordingPermissionsAsync()
      } finally {
        permissionPending.current = false
      }
      if (!permission.granted) {
        setPhase('idle')
        handlers.current.onDenied()
        return
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      prepared = true
      await recorder.prepareToRecordAsync()
      if (!alive.current || abortStart.current) {
        await recorder.stop().catch(() => {})
        return
      }
      recorder.record()
      startedAt.current = Date.now()
      triggerSelection()
      setPhase('recording')
      limit.current = setTimeout(() => {
        handlers.current.onProblem('Recording stops after 5 minutes.')
        void finish()
      }, MAX_RECORDING_MS)
      if (stopAfterStart.current) {
        stopAfterStart.current = false
        void finish()
      }
    } catch (error) {
      if (prepared) await recorder.stop().catch(() => {})
      setPhase('idle')
      triggerError()
      handlers.current.onProblem(`The microphone did not start: ${messageOf(error)}`)
    }
  }, [recorder, finish, setPhase])

  const pressIn = useCallback(() => {
    if (phaseRef.current === 'transcribing') return
    pressedAt.current = Date.now()
    stopAfterStart.current = false
    pressStopping.current = phaseRef.current === 'recording'
    if (phaseRef.current === 'idle') void start()
  }, [start])

  const pressOut = useCallback(() => {
    const phaseNow = phaseRef.current
    if (phaseNow === 'idle' || phaseNow === 'transcribing') return
    const action = onRelease({
      mode,
      stopping: pressStopping.current,
      starting: phaseNow === 'starting',
      heldMs: Date.now() - pressedAt.current
    })
    if (action === 'stop-after-start') stopAfterStart.current = true
    else if (action === 'stop') void finish()
  }, [mode, finish])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'background' || !abortsOnBackground(phaseRef.current, permissionPending.current)) return
      clearLimit()
      stopAfterStart.current = false
      abortStart.current = true
      if (phaseRef.current === 'recording') void recorder.stop().catch(() => {})
      void setAudioModeAsync({ allowsRecording: false }).catch(() => {})
      setPhase('idle')
    })
    return () => subscription.remove()
  }, [recorder, setPhase])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearLimit()
      if (phaseRef.current === 'recording') void recorder.stop().catch(() => {})
    }
  }, [recorder])

  return { phase, pressIn, pressOut }
}
