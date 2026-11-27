import * as ImagePicker from 'expo-image-picker'
import { useCallback, useEffect, useRef, useState } from 'react'
import { shellPath, uploadFile } from '../api/upload'
import type { PairedServer } from '../servers/store'

export type AttachState =
  | { kind: 'idle' }
  | { kind: 'uploading'; file: string; fraction: number }
  | { kind: 'failed'; message: string }

const IDLE: AttachState = { kind: 'idle' }

export function useAttach(server: PairedServer, machine: string, name: string, typeIntoTerminal: (text: string) => void) {
  const [state, setState] = useState<AttachState>(IDLE)
  const current = useRef(name)
  current.current = name
  const busy = useRef(false)

  useEffect(() => setState(IDLE), [name])

  const pickPhoto = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    const target = name
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85, exif: false })
      const asset = picked.canceled ? undefined : picked.assets[0]
      if (!asset) return
      const file = asset.fileName ?? `photo-${Date.now()}.jpg`
      setState({ kind: 'uploading', file, fraction: 0 })
      const { path } = await uploadFile(server, machine, target, { uri: asset.uri, name: file, size: asset.fileSize }, (fraction) =>
        setState((now) => (now.kind === 'uploading' ? { ...now, fraction } : now))
      )
      if (current.current !== target) {
        setState({ kind: 'failed', message: `Uploaded, but you switched sessions first. The file is at ${path}` })
        return
      }
      typeIntoTerminal(`${shellPath(path)} `)
      setState(IDLE)
    } catch (error) {
      setState({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally {
      busy.current = false
    }
  }, [server, machine, name, typeIntoTerminal])

  const dismiss = useCallback(() => setState(IDLE), [])
  return { state, pickPhoto, dismiss }
}
