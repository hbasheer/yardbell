import { CameraView, useCameraPermissions } from 'expo-camera'
import { Link, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, Pressable, Text, View } from 'react-native'
import { pairDeps } from '@/pairing/deps'
import { pairWithLink } from '@/pairing/pairFlow'
import { useTheme } from '@/theme/useTheme'

export default function Pair() {
  const theme = useTheme()
  const router = useRouter()
  const { link } = useLocalSearchParams<{ link?: string }>()
  const [permission, requestPermission] = useCameraPermissions()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const attempt = useCallback(
    async (target: string) => {
      if (inFlight.current) return
      inFlight.current = true
      setBusy(true)
      setError(null)
      const outcome = await pairWithLink(target, pairDeps)
      if (outcome.ok) {
        router.replace('/')
        return
      }
      inFlight.current = false
      setBusy(false)
      setError(outcome.message)
    },
    [router]
  )

  useEffect(() => {
    if (link) attempt(link)
  }, [link, attempt])

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) requestPermission()
  }, [permission, requestPermission])

  const text = { color: theme.foreground, fontSize: 16 }
  const passcodeLink = (
    <Link href="/sign-in" style={{ color: theme.foreground, fontSize: 16, textDecorationLine: 'underline', marginTop: 16 }}>
      Sign in with the passcode instead
    </Link>
  )

  if (!link && permission && !permission.granted && !permission.canAskAgain) {
    return (
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', backgroundColor: theme.background }}>
        <Text style={text}>Yardbell needs the camera to scan the pairing code</Text>
        <Pressable
          onPress={() => Linking.openSettings()}
          style={{ marginTop: 16, padding: 12, borderRadius: 8, backgroundColor: theme.accent }}
        >
          <Text style={{ color: theme.accentForeground, fontSize: 16, textAlign: 'center' }}>Open settings</Text>
        </Pressable>
        {passcodeLink}
      </View>
    )
  }

  return (
    <View style={{ flex: 1, padding: 24, justifyContent: 'center', backgroundColor: theme.background }}>
      <Text style={{ ...text, marginBottom: 16 }}>
        Point at the code in Yardbell &gt; Settings &gt; Connect a phone
      </Text>
      {!link && permission?.granted && (
        <CameraView
          style={{ aspectRatio: 1, borderRadius: 12, overflow: 'hidden' }}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          active={!busy}
          onBarcodeScanned={busy || error ? undefined : ({ data }) => attempt(data)}
        />
      )}
      {busy && <Text style={{ ...text, marginTop: 16, color: theme.mutedForeground }}>Pairing...</Text>}
      {error && (
        <>
          <Text style={{ marginTop: 16, fontSize: 16, color: theme.down }}>{error}</Text>
          <Pressable
            onPress={() => {
              setError(null)
              if (link) attempt(link)
            }}
            style={{ marginTop: 12, padding: 12, borderRadius: 8, backgroundColor: theme.accent }}
          >
            <Text style={{ color: theme.accentForeground, fontSize: 16, textAlign: 'center' }}>Try again</Text>
          </Pressable>
        </>
      )}
      {passcodeLink}
    </View>
  )
}
