import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PairedServer } from '../../servers/store'
import { getMemory, getServerSettings, getTriggers, type ServerSettings } from '../serverApi'
import { useGuardedTask } from '../../pipelines/queries'

export const serverSettingsKey = (serverId: string) => ['server-settings', serverId] as const
export const memoryKey = (serverId: string) => ['server-memory', serverId] as const
export const triggersKey = (serverId: string) => ['server-triggers', serverId] as const

export function serverSettingsQuery(server: PairedServer) {
  return {
    queryKey: serverSettingsKey(server.id),
    queryFn: () => getServerSettings(server),
    staleTime: 15_000,
    meta: { serverId: server.id }
  }
}

export function useServerSettings(server: PairedServer) {
  return useQuery(serverSettingsQuery(server))
}

export function useMemory(server: PairedServer) {
  return useQuery({ queryKey: memoryKey(server.id), queryFn: () => getMemory(server), meta: { serverId: server.id } })
}

export function useTriggers(server: PairedServer, poll: boolean) {
  return useQuery({
    queryKey: triggersKey(server.id),
    queryFn: () => getTriggers(server),
    refetchInterval: poll ? 8000 : false,
    meta: { serverId: server.id }
  })
}

export function mergeSettings(old: ServerSettings | undefined, next: Partial<ServerSettings>): ServerSettings {
  return { ...old, ...next }
}

export function useSettingsTask(server: PairedServer, extra: () => readonly (readonly unknown[])[] = () => []) {
  const queryClient = useQueryClient()
  const task = useGuardedTask(server.id, () => [serverSettingsKey(server.id), ...extra()] as never)
  const adopt = (next: Partial<ServerSettings>) => queryClient.setQueryData<ServerSettings>(serverSettingsKey(server.id), (old) => mergeSettings(old, next))
  return { ...task, adopt }
}
