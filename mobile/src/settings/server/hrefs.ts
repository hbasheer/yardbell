const root = (serverId: string) => `/settings/server/${encodeURIComponent(serverId)}`

export const serverSettingsHref = root
export const dispatchSettingsHref = (serverId: string) => `${root(serverId)}/dispatch`
export const memoryHref = (serverId: string) => `${root(serverId)}/memory`
export const phoneSettingsHref = (serverId: string) => `${root(serverId)}/phone`
export const triggersHref = (serverId: string) => `${root(serverId)}/triggers`
