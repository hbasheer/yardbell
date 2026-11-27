import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useState } from 'react'
import { parseSpeak } from './model'

const KEY = 'yardbell:dispatch-speak'

let current = false
let loaded: Promise<void> | null = null
const listeners = new Set<(on: boolean) => void>()

function publish(on: boolean) {
  current = on
  for (const listener of listeners) listener(on)
}

function load(): Promise<void> {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((raw) => publish(parseSpeak(raw)))
    .catch((error) => console.error('Could not read the speak replies setting', error))
  return loaded
}

export function setSpeakReplies(on: boolean): void {
  publish(on)
  const write = on ? AsyncStorage.setItem(KEY, '1') : AsyncStorage.removeItem(KEY)
  write.catch((error) => console.error('Could not save the speak replies setting', error))
}

export function useSpeakReplies(): [boolean, typeof setSpeakReplies] {
  const [on, setOn] = useState(current)
  useEffect(() => {
    listeners.add(setOn)
    setOn(current)
    void load()
    return () => {
      listeners.delete(setOn)
    }
  }, [])
  return [on, setSpeakReplies]
}
