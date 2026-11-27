import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { ApiClient } from '@/api/client'
import type { PairedServer } from '@/servers/store'
import type { ServerSession } from '@/state/views'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { sessionTitle } from '@/machine/WorkspaceRow'

export function useStopSession(
  server: PairedServer,
  onStopped?: () => void
): { ask: (session: ServerSession) => void; modals: ReactNode } {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<ServerSession | null>(null)
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null)

  const stop = () => {
    if (!target?.tmux) return
    new ApiClient(server)
      .post(`/sessions/${encodeURIComponent(target.machine)}/${encodeURIComponent(target.tmux)}/stop`)
      .then(() => queryClient.refetchQueries({ queryKey: ['state', server.id] }))
      .then(() => onStopped?.())
      .catch((error) =>
        setFailure({ title: 'Could not stop the session', message: error instanceof Error ? error.message : String(error) })
      )
  }

  const modals = (
    <>
      <ConfirmModal
        visible={target !== null}
        title="Stop this session?"
        message={target ? `${sessionTitle(target)} on ${target.machine} will be stopped.` : undefined}
        confirmLabel="Stop"
        destructive
        onConfirm={stop}
        onCancel={() => setTarget(null)}
      />
      <ConfirmModal
        visible={failure !== null}
        title={failure?.title ?? ''}
        message={failure?.message}
        cancelLabel={null}
        confirmLabel="OK"
        onCancel={() => setFailure(null)}
      />
    </>
  )
  return { ask: setTarget, modals }
}
