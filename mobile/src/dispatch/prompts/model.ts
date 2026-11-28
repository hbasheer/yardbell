import type { SavedPrompt } from '../types'

export const NAME_LIMIT = 60

export type PromptForm = { editing: string | null; name: string; text: string }

export const emptyForm = (text = ''): PromptForm => ({ editing: null, name: '', text })

export const formOf = (prompt: SavedPrompt): PromptForm => ({ editing: prompt.name, name: prompt.name, text: prompt.text })

export const visiblePrompts = (prompts: readonly SavedPrompt[]) => prompts.filter((prompt) => !prompt.hidden)

export const hasHiddenDefaults = (prompts: readonly SavedPrompt[]) => prompts.some((prompt) => prompt.hidden)

export function filterPrompts(prompts: readonly SavedPrompt[], query: string): SavedPrompt[] {
  const needle = query.trim().toLowerCase()
  const shown = visiblePrompts(prompts)
  if (!needle) return shown
  return shown.filter((prompt) => `${prompt.name} ${prompt.text}`.toLowerCase().includes(needle))
}

export function hasUnsavedEdits(prompts: readonly SavedPrompt[] | undefined, form: PromptForm): boolean {
  const saved = form.editing ? prompts?.find((prompt) => prompt.name === form.editing) : undefined
  return !saved || saved.name !== form.name || saved.text !== form.text
}

export const canSave = (form: PromptForm) => form.name.trim().length > 0 && form.text.trim().length > 0

export const clampName = (name: string) => name.slice(0, NAME_LIMIT)

export function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function clash(prompts: readonly SavedPrompt[], form: PromptForm): string | null {
  const taken = visiblePrompts(prompts).find((prompt) => sameName(prompt.name, form.name) && !(form.editing && sameName(prompt.name, form.editing)))
  return taken ? `A saved prompt named "${taken.name}" already exists.` : null
}

export const savedMessage = (name: string) => `Saved "${name.trim()}"`

export const deleteNote = (prompt: SavedPrompt) =>
  prompt.builtin ? 'It is a default prompt, so Restore default prompts brings it back.' : 'Conversations it started are kept.'

export function versionLine(prompt: SavedPrompt) {
  const origin = prompt.builtin ? (prompt.customised ? ', changed from the default' : ', the default') : ''
  return `Version ${prompt.version}${origin}`
}

export const runHref = (serverId: string, name: string) =>
  `/dispatch/${encodeURIComponent(serverId)}/new?run=${encodeURIComponent(name)}`

export const promptToRun = (prompts: readonly SavedPrompt[], name: string) =>
  visiblePrompts(prompts).find((prompt) => prompt.name === name)
