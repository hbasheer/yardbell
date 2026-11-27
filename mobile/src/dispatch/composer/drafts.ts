import AsyncStorage from '@react-native-async-storage/async-storage'

export const NEW_CHAT = 'new'

export const draftKey = (serverId: string, conversationId: string | null) =>
  `yardbell:dispatch-draft:${serverId}:${conversationId ?? NEW_CHAT}`

export async function loadDraft(key: string): Promise<string> {
  try {
    return (await AsyncStorage.getItem(key)) ?? ''
  } catch (error) {
    console.error('Could not read the Dispatch draft', error)
    return ''
  }
}

export function saveDraft(key: string, text: string): void {
  const write = text.trim() ? AsyncStorage.setItem(key, text) : AsyncStorage.removeItem(key)
  write.catch((error) => console.error('Could not save the Dispatch draft', error))
}

export type DraftStore = { get(key: string): Promise<string>; set(key: string, text: string): void }

export const asyncDrafts: DraftStore = { get: loadDraft, set: saveDraft }

export async function switchDraft(store: DraftStore, previous: { key: string; text: string } | null, nextKey: string): Promise<string> {
  if (previous && previous.key !== nextKey) store.set(previous.key, previous.text)
  return store.get(nextKey)
}

export function restoreText(original: string, current: string): string {
  return current ? `${original}\n${current}` : original
}
