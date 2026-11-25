import { useSyncExternalStore } from 'react'

export type SavedNote = { title: string; text: string; restart: boolean; undo: boolean }

let note: SavedNote | null = null
const listeners = new Set<() => void>()
const tell = () => listeners.forEach((l) => l())

// After a save the page offers to undo it, and to restart Yardbell when the change needs one.
export function saved(text: string, restart = false) {
  note = { title: 'Saved.', text, restart, undo: true }
  tell()
}
export function setSavedNote(next: SavedNote | null) {
  note = next
  tell()
}
export function useSavedNote() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => note
  )
}
