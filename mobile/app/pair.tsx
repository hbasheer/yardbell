import { CameraView, useCameraPermissions } from 'expo-camera'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Camera, QrCode } from 'lucide-react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BackHandler, Linking, View } from 'react-native'
import { pairDeps } from '@/pairing/deps'
import { parsePairingLink } from '@/pairing/link'
import { CenteredMessage, PairFrame } from '@/pairing/PairFrame'
import { pairWithLink } from '@/pairing/pairFlow'
import { PairError, PairProgress } from '@/pairing/PairProgress'
import { PairSteps } from '@/pairing/PairSteps'
import { ScanReticle } from '@/pairing/ScanReticle'
import { ActionButton } from '@/ui/ActionButton'
import { triggerSuccess } from '@/ui/haptics'
import { colors, fixedColors, radii, spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

const CONNECTED_BEAT_MS = 700
const DECODE_BEAT_MS = 180

type Phase = 'idle' | 'connecting' | 'connected'

export default function Pair() {
  useColorScheme()
  const router = useRouter()
  const { link } = useLocalSearchParams<{ link?: string }>()
  const [permission, requestPermission] = useCameraPermissions()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [decoded, setDecoded] = useState(false)
  const inFlight = useRef(false)
  const decoding = useRef(false)
  const lastTarget = useRef<string | null>(null)

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }, [router])

  const attempt = useCallback(
    async (target: string) => {
      if (inFlight.current) return
      inFlight.current = true
      lastTarget.current = target
      setPhase('connecting')
      setError(null)
      const outcome = await pairWithLink(target, pairDeps)
      if (outcome.ok) {
        triggerSuccess()
        setPhase('connected')
        setTimeout(() => router.replace('/'), CONNECTED_BEAT_MS)
        return
      }
      inFlight.current = false
      setPhase('idle')
      setError(outcome.message)
    },
    [router]
  )

  const onScanned = useCallback(
    (data: string) => {
      if (decoding.current || inFlight.current) return
      decoding.current = true
      setDecoded(true)
      setTimeout(() => {
        decoding.current = false
        setDecoded(false)
        attempt(data)
      }, DECODE_BEAT_MS)
    },
    [attempt]
  )

  const linkTarget = useMemo(() => {
    if (!link) return null
    try {
      return { address: parsePairingLink(link).address }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'That is not a Yardbell pairing code' }
    }
  }, [link])

  useEffect(() => {
    setConfirmed(false)
    if (linkTarget?.error) setError(linkTarget.error)
  }, [linkTarget])

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) requestPermission()
  }, [permission, requestPermission])

  const confirming = Boolean(link && linkTarget?.address && !confirmed)

  useEffect(() => {
    if (!confirming) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      leave()
      return true
    })
    return () => subscription.remove()
  }, [confirming, leave])

  const passcodeButton = <ActionButton variant="ghost" label="Sign in with the passcode instead" onPress={() => router.push('/sign-in')} />

  if (confirming && link) {
    return (
      <PairFrame>
        <CenteredMessage title={`Pair with ${linkTarget?.address}?`} titleLines={2} message="Only pair with a Yardbell server you run yourself.">
          <View style={styles.actions}>
            <ActionButton
              label="Pair"
              fullWidth
              onPress={() => {
                setConfirmed(true)
                attempt(link)
              }}
            />
            <ActionButton variant="ghost" label="Cancel" fullWidth onPress={leave} />
          </View>
        </CenteredMessage>
      </PairFrame>
    )
  }

  if (phase !== 'idle') {
    return (
      <PairFrame back={false}>
        <PairProgress done={phase === 'connected'} title="Connecting" />
      </PairFrame>
    )
  }

  if (error && linkTarget?.error) {
    return (
      <PairFrame>
        <CenteredMessage title="Could not read the code">
          <PairError message={error} />
          <View style={styles.actions}>
            <ActionButton label="Scan the code" fullWidth onPress={() => router.replace('/pair')} />
            {passcodeButton}
          </View>
        </CenteredMessage>
      </PairFrame>
    )
  }

  if (error) {
    return (
      <PairFrame>
        <CenteredMessage title="Could not pair">
          <PairError message={error} />
          <View style={styles.actions}>
            <ActionButton label="Try again" fullWidth onPress={() => (link ? attempt(link) : setError(null))} />
            {passcodeButton}
          </View>
        </CenteredMessage>
      </PairFrame>
    )
  }

  if (!link && permission && !permission.granted && !permission.canAskAgain) {
    return (
      <PairFrame>
        <CenteredMessage title="Camera access needed" message="Yardbell uses the camera to scan the pairing code shown on your computer.">
          <View style={styles.actions}>
            <ActionButton icon={Camera} label="Open settings" onPress={() => Linking.openSettings()} />
            {passcodeButton}
          </View>
        </CenteredMessage>
      </PairFrame>
    )
  }

  return (
    <PairFrame>
      <PairSteps />
      <View style={styles.card}>
        {!link && permission?.granted ? (
          <>
            <CameraView
              style={styles.camera}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => onScanned(data)}
            />
            <ScanReticle decoded={decoded} />
          </>
        ) : (
          <View style={styles.placeholder}>
            <QrCode size={28} color={colors.textMuted} strokeWidth={1.75} />
          </View>
        )}
      </View>
      <View style={styles.footer}>{passcodeButton}</View>
    </PairFrame>
  )
}

const styles = themedStyleSheet(() => ({
  card: { flex: 1, borderRadius: radii.surface, overflow: 'hidden', backgroundColor: fixedColors.black },
  camera: { flex: 1 },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  actions: { alignSelf: 'stretch', alignItems: 'center', maxWidth: 360, gap: spacing.sm, marginTop: spacing.lg },
  footer: { alignItems: 'center', marginTop: spacing.md }
}))
