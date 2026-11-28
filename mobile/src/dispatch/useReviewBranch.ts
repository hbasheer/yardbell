import { useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { routeIfSignedOut } from '../api/signedOut'
import type { PairedServer } from '../servers/store'
import { reviewSession } from './api'
import { dispatchHref } from './listModel'

export type ReviewFailure = { title: string; message: string }

export function useReviewBranch(server: PairedServer, onFailure: (failure: ReviewFailure) => void) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const working = useRef(false)

  const start = useCallback(
    async (machine: string, name: string) => {
      if (working.current) return
      working.current = true
      setBusy(true)
      try {
        const { conversation } = await reviewSession(server, machine, name)
        router.push(dispatchHref(server.id, conversation) as never)
      } catch (error) {
        if (!routeIfSignedOut(error, server.id)) {
          onFailure({ title: 'Could not start the review', message: error instanceof Error ? error.message : String(error) })
        }
      } finally {
        working.current = false
        setBusy(false)
      }
    },
    [server, router, onFailure]
  )

  return { busy, start }
}
