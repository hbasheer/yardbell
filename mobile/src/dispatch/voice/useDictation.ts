import { RecordingPresets, getRecordingPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { routeIfSignedOut } from '../../api/signedOut'
import type { PairedServer } from '../../servers/store'
import { triggerError, triggerSelection } from '../../ui/haptics'
import { transcribe } from '../api'
import { MAX_RECORDING_MS, NOTHING_HEARD, RECORDING_MIME, onRelease, type MicMode } from './model'

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
      await recorder.stop()
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
    setPhase('starting')
    try {
      let permission = await getRecordingPermissionsAsync()
      if (!permission.granted) permission = await requestRecordingPermissionsAsync()
      if (!permission.granted) {
        setPhase('idle')
        handlers.current.onDenied()
        return
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      recorder.record()
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
    alive.current = true
    return () => {
      alive.current = false
      clearLimit()
      if (phaseRef.current === 'recording') void recorder.stop().catch(() => {})
    }
  }, [recorder])

  return { phase, pressIn, pressOut }
}
