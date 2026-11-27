import * as Clipboard from 'expo-clipboard'
import { ChevronLeft, Copy, MoreHorizontal } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { useMemo, useRef, useState } from 'react'
import { View, type HostInstance } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ServerError } from '../api/client'
import { absolutePath } from '../changes/model'
import { TextViewer } from '../code/TextViewer'
import type { PairedServer } from '../servers/store'
import type { ActionSheetAction } from '../ui/ActionSheet'
import { NavBar } from '../ui/NavBar'
import { NavBarButton } from '../ui/NavBarButton'
import { PullDownMenu } from '../ui/PullDownMenu'
import { LoadErrorState, StateView } from '../ui/StateView'
import { colors, themedStyleSheet, useColorScheme } from '../ui/theme'
import { findLine, isMarkdown, sizeWord, splitResult } from './model'
import { useFileText } from './useFiles'

type Props = { server: PairedServer; machine: string; root: string; path: string; line: number | null; find: string; multipleServers: boolean }

export function FileViewScreen({ server, machine, root, path, line, find, multipleServers }: Props) {
  useColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const query = useFileText(server, machine, root, path)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HostInstance>(null)
  const { name, dir } = splitResult(path)
  const data = query.data
  const failure = query.error
  const refused = failure instanceof ServerError && (failure.status === 413 || failure.status === 415) ? failure : null
  const target = useMemo(() => line ?? (data && find ? findLine(data.text, find) : null), [line, data, find])

  const copy = (text: string) => {
    Clipboard.setStringAsync(text).catch((error) => console.error('Could not copy', error))
  }
  const actions: ActionSheetAction[] = [
    { label: 'Copy path', icon: Copy, onPress: () => copy(absolutePath(root, path)) },
    { label: 'Copy relative path', icon: Copy, onPress: () => copy(path) }
  ]

  const where = multipleServers && server.machine !== machine ? ` · ${server.machine}` : ''
  const subtitle = data ? `${dir || machine}${where} · ${sizeWord(data.size)}` : `${dir || machine}${where}`

  let body
  if (data) {
    body = (
      <TextViewer
        text={data.text}
        line={target}
        markdown={isMarkdown(path)}
        notes={data.editable ? [] : ['This file is not valid UTF-8, so some characters may show wrongly.']}
        style={styles.viewer}
      />
    )
  } else if (refused) {
    body = <TextViewer text="" binary={refused.status === 415} tooLarge={refused.status === 413} notes={[refused.message]} style={styles.viewer} />
  } else if (failure) {
    body = <LoadErrorState message={failure instanceof Error ? failure.message : 'Could not read the file.'} onRetry={() => query.refetch()} />
  } else {
    body = <StateView loading title="Reading the file" />
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <NavBar
        leading={<NavBarButton icon={ChevronLeft} accessibilityLabel="Back" onPress={() => router.back()} />}
        title={name}
        subtitle={subtitle}
        trailing={
          <View ref={moreRef} collapsable={false}>
            <NavBarButton icon={MoreHorizontal} accessibilityLabel="More File Actions" active={moreOpen} onPress={() => setMoreOpen(true)} />
          </View>
        }
      />
      {body}
      <PullDownMenu visible={moreOpen} anchorRef={moreRef} groups={[actions]} onClose={() => setMoreOpen(false)} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  viewer: { flex: 1 }
}))
