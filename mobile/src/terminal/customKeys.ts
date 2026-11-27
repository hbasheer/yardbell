import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'yardbell:custom-keys'
const MAX_LABEL = 12

export type CustomKey = { id: string; label: string; bytes: string }

export type CustomKeyDraft =
  | { label: string; kind: 'text'; text: string; enter: boolean }
  | { label: string; kind: 'ctrl'; letter: string }

function isCustomKey(value: unknown): value is CustomKey {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.label === 'string' && typeof v.bytes === 'string' && v.bytes.length > 0
}

export function parseCustomKeys(raw: string | null): CustomKey[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isCustomKey) : []
  } catch {
    return []
  }
}

export function buildCustomKey(draft: CustomKeyDraft, id: string): CustomKey | { error: string } {
  const label = draft.label.trim()
  if (!label) return { error: 'Give the key a label.' }
  if (label.length > MAX_LABEL) return { error: `Keep the label to ${MAX_LABEL} characters.` }
  if (draft.kind === 'ctrl') {
    const letter = draft.letter.trim().toUpperCase()
    if (!/^[A-Z]$/.test(letter)) return { error: 'Ctrl needs a single letter, A to Z.' }
    return { id, label, bytes: String.fromCharCode(letter.charCodeAt(0) & 0x1f) }
  }
  if (!draft.text) return { error: 'Enter the text the key sends.' }
  return { id, label, bytes: draft.enter ? `${draft.text}\r` : draft.text }
}

let current: CustomKey[] = []
let loaded: Promise<void> | null = null
const listeners = new Set<(keys: CustomKey[]) => void>()

function publish(keys: CustomKey[]) {
  current = keys
  for (const listener of listeners) listener(keys)
}

function load(): Promise<void> {
  loaded ??= AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => publish(parseCustomKeys(raw)))
    .catch((error) => console.error('Could not read the custom keys', error))
  return loaded
}

async function save(keys: CustomKey[]): Promise<void> {
  const before = current
  publish(keys)
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(keys))
  } catch (error) {
    publish(before)
    throw error
  }
}

export async function addCustomKey(key: CustomKey): Promise<void> {
  await load()
  await save([...current, key])
}

export async function removeCustomKey(id: string): Promise<void> {
  await load()
  await save(current.filter((k) => k.id !== id))
}

export function useCustomKeys(): CustomKey[] {
  const [keys, setKeys] = useState(current)
  useEffect(() => {
    listeners.add(setKeys)
    setKeys(current)
    load()
    return () => {
      listeners.delete(setKeys)
    }
  }, [])
  return keys
}
