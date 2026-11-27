import { useRouter } from 'expo-router'
import { useState } from 'react'
import { KeyboardAvoidingView, Platform, View } from 'react-native'
import { pairDeps } from '@/pairing/deps'
import { CenteredMessage, PairFrame } from '@/pairing/PairFrame'
import { signInWithPasscode } from '@/pairing/pairFlow'
import { PairError } from '@/pairing/PairProgress'
import { ActionButton } from '@/ui/ActionButton'
import { PageField } from '@/ui/PageField'
import { spacing, themedStyleSheet, useColorScheme } from '@/ui/theme'

export default function SignIn() {
  useColorScheme()
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [passcode, setPasscode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (busy) return
    setBusy(true)
    setError(null)
    const outcome = await signInWithPasscode(address, passcode, pairDeps)
    setBusy(false)
    if (outcome.ok) router.replace('/')
    else setError(outcome.message)
  }

  return (
    <PairFrame>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <CenteredMessage title="Sign in with the passcode" message="Enter the address of your Yardbell server and its passcode.">
          <View style={styles.form}>
            <PageField
              value={address}
              onChangeText={setAddress}
              placeholder="100.64.0.10:4000"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="Server address"
            />
            <PageField
              value={passcode}
              onChangeText={setPasscode}
              placeholder="Passcode"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submit}
              accessibilityLabel="Passcode"
            />
            {error ? <PairError message={error} /> : null}
            <View style={styles.actions}>
              <ActionButton label="Sign in" busy={busy} fullWidth onPress={submit} />
              <ActionButton variant="ghost" label="Scan the pairing code instead" onPress={() => router.replace('/pair')} />
            </View>
          </View>
        </CenteredMessage>
      </KeyboardAvoidingView>
    </PairFrame>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1 },
  form: { alignSelf: 'stretch', maxWidth: 360, width: '100%', gap: spacing.sm, marginTop: spacing.lg },
  actions: { alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm }
}))
