import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useRef, useState } from 'react'

export function usePersisted<T>(
  key: string,
  initial: T,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string
): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial)
  const latest = useRef(value)
  const touched = useRef(false)

  useEffect(() => {
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (touched.current) return
        latest.current = parse(raw)
        setValue(latest.current)
      })
      .catch((error) => console.error(`Could not read ${key}`, error))
  }, [key, parse])

  const update = useCallback(
    (next: T | ((current: T) => T)) => {
      touched.current = true
      latest.current = typeof next === 'function' ? (next as (current: T) => T)(latest.current) : next
      setValue(latest.current)
      AsyncStorage.setItem(key, serialize(latest.current)).catch((error) => console.error(`Could not save ${key}`, error))
    },
    [key, serialize]
  )

  return [value, update]
}
