import * as Clipboard from 'expo-clipboard'
import { Copy, RefreshCw, Trash2 } from 'lucide-react-native'
import { useState, type RefObject } from 'react'
import type { HostInstance } from 'react-native'
import { forgetServer, type PairedServer } from '@/servers/store'
import { ActionSheet, type ActionSheetAction } from '@/ui/ActionSheet'
import { ConfirmModal } from '@/ui/ConfirmModal'
import { PullDownMenu } from '@/ui/PullDownMenu'

type Props = {
  server: PairedServer | undefined
  title?: string
  visible: boolean
  onClose: () => void
  onReconnect: () => void
  anchorRef?: RefObject<HostInstance | null>
}

export function ServerMenus({ server, title, visible, onClose, onReconnect, anchorRef }: Props) {
  const [forgetting, setForgetting] = useState<PairedServer | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions: ActionSheetAction[] = server
    ? [
        { label: 'Reconnect', icon: RefreshCw, onPress: onReconnect },
        {
          label: 'Copy address',
          icon: Copy,
          onPress: () => {
            Clipboard.setStringAsync(server.address).catch((e) => console.error('Could not copy the address', e))
          }
        },
        { label: 'Forget server', icon: Trash2, destructive: true, closeBeforePress: true, onPress: () => setForgetting(server) }
      ]
    : []

  const forget = () => {
    if (!forgetting) return
    forgetServer(forgetting.id).catch((e) => {
      console.error('Could not forget server', e)
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  return (
    <>
      {anchorRef ? (
        <PullDownMenu visible={visible} anchorRef={anchorRef} groups={[actions]} onClose={onClose} />
      ) : (
        <ActionSheet visible={visible} title={title} message={server?.address} actions={actions} onClose={onClose} />
      )}
      <ConfirmModal
        visible={forgetting !== null}
        title={`Forget ${forgetting?.machine ?? 'server'}?`}
        message="You can pair again later."
        confirmLabel="Forget"
        destructive
        onConfirm={forget}
        onCancel={() => setForgetting(null)}
      />
      <ConfirmModal
        visible={error !== null}
        title="Could not forget the server"
        message={error ?? undefined}
        cancelLabel={null}
        confirmLabel="OK"
        onCancel={() => setError(null)}
      />
    </>
  )
}
