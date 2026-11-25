import { toast } from 'sonner'
import type { Session } from './state'

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Yardbell answered ${res.status}`)
  return data as T
}

// Each action reports its own failure, so a menu item only has to call it.
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (err) {
    toast.error((err as Error).message)
    return null
  }
}

export const startSession = (body: { machine: string; path: string; agent: string }) =>
  attempt(async () => {
    const data = await post<{ name: string }>('/sessions', { ...body, wait: true })
    return `${body.machine}/${data.name}`
  })

export const openShell = (machine: string) =>
  attempt(async () => {
    const data = await post<{ name: string }>(`/machines/${encodeURIComponent(machine)}/shell`)
    return `${machine}/${data.name}`
  })

export const stopSession = (s: Session) => attempt(() => post(`/sessions/${encodeURIComponent(s.machine)}/${encodeURIComponent(s.tmux || '')}/stop`))

export const renameProject = (id: string, name: string) => attempt(() => post('/api/projects/rename', { id, name }))
export const removeProject = (id: string) => attempt(() => post('/api/projects/delete', { id }))
export const checkNow = () => attempt(() => post('/refresh'))

export async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`Copied ${what}`)
  } catch {
    toast(text)
  }
}
