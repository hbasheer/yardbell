import { useFocusEffect } from 'expo-router'
import * as Speech from 'expo-speech'
import { useCallback, useEffect, useRef } from 'react'
import type { DispatchEvent } from '../types'
import { speechPieces, takeNew } from './model'
import { useSpeakReplies } from './speakPrefs'

export function stopSpeaking(): void {
  Speech.stop().catch(() => {})
}

export function useSpokenReplies(events: readonly DispatchEvent[], ready: boolean, startsEmpty: boolean) {
  const [on] = useSpeakReplies()
  const seen = useRef<number | null>(null)
  const focused = useRef(false)
  const wanted = useRef(on)
  wanted.current = on

  useFocusEffect(
    useCallback(() => {
      focused.current = true
      return () => {
        focused.current = false
        stopSpeaking()
      }
    }, [])
  )

  useEffect(() => {
    if (!on) stopSpeaking()
  }, [on])

  useEffect(() => stopSpeaking, [])

  useEffect(() => {
    if (!ready) return
    if (seen.current === null) seen.current = startsEmpty ? 0 : events.length
    const next = takeNew(events, seen.current)
    seen.current = next.seen
    if (!wanted.current || !focused.current) return
    for (const text of next.say) for (const piece of speechPieces(text)) Speech.speak(piece)
  }, [events, ready, startsEmpty])
}
