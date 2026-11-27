import { useRouter } from 'expo-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { listServers, onServersChanged, type PairedServer } from '../servers/store'
import { NewSessionSheet } from './NewSessionSheet'
import type { NewSessionOpen, Started } from './request'

type NewSessionApi = { open: (preset?: NewSessionOpen) => void }

const NewSessionContext = createContext<NewSessionApi>({ open: () => {} })

export function useNewSession(): NewSessionApi {
  return useContext(NewSessionContext)
}

export function NewSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [servers, setServers] = useState<PairedServer[]>([])
  const [request, setRequest] = useState<NewSessionOpen | null>(null)
  const [visible, setVisible] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    listServers()
      .then(setServers)
      .catch((error) => console.error('Could not read saved servers', error))
    return onServersChanged(setServers)
  }, [])

  const open = useCallback((preset: NewSessionOpen = {}) => {
    setRequest(preset)
    setNonce((n) => n + 1)
    setVisible(true)
  }, [])
  const api = useMemo(() => ({ open }), [open])

  const started = (server: PairedServer, result: Started) => {
    setVisible(false)
    router.navigate(
      `/session/${encodeURIComponent(server.id)}/${encodeURIComponent(result.machine)}/${encodeURIComponent(result.name)}` as never
    )
  }

  return (
    <NewSessionContext value={api}>
      {children}
      {request ? (
        <NewSessionSheet
          key={nonce}
          visible={visible}
          request={request}
          servers={servers}
          onClose={() => setVisible(false)}
          onAfterClose={() => setRequest(null)}
          onStarted={started}
        />
      ) : null}
    </NewSessionContext>
  )
}
