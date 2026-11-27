import { useEffect, useState } from 'react'
import { listServers, onServersChanged, type PairedServer } from '@/servers/store'

export function useServers(): PairedServer[] | null {
  const [servers, setServers] = useState<PairedServer[] | null>(null)
  useEffect(() => {
    listServers()
      .then(setServers)
      .catch((error) => {
        console.error('Could not read saved servers', error)
        setServers([])
      })
    return onServersChanged(setServers)
  }, [])
  return servers
}
