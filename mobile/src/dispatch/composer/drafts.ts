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
