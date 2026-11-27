import { router } from 'expo-router'
import { SignedOutError } from './client'

export function signedOutHref(error: unknown, serverId: string | undefined): string | null {
  if (!(error instanceof SignedOutError)) return null
  return serverId ? `/signed-out?server=${encodeURIComponent(serverId)}` : '/pair'
}

export function routeIfSignedOut(error: unknown, serverId: string | undefined): boolean {
  const href = signedOutHref(error, serverId)
  if (!href) return false
  router.replace(href as never)
  return true
}
