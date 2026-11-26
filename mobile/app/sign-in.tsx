import { Link, useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { pairDeps } from '@/pairing/deps'
import { signInWithPasscode } from '@/pairing/pairFlow'
import { useTheme } from '@/theme/useTheme'

export default function SignIn() {
  const theme = useTheme()
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

  const input = {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: theme.foreground,
    backgroundColor: theme.muted,
    marginTop: 8
  }

  return (
    <View style={{ flex: 1, padding: 24, justifyContent: 'center', backgroundColor: theme.background }}>
      <Text style={{ fontSize: 24, fontWeight: '600', color: theme.foreground }}>Sign in with the passcode</Text>
      <TextInput
        value={address}
        onChangeText={setAddress}
        placeholder="100.64.0.10:4000"
        placeholderTextColor={theme.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={{ ...input, marginTop: 24 }}
      />
      <TextInput
        value={passcode}
        onChangeText={setPasscode}
        placeholder="Passcode"
        placeholderTextColor={theme.mutedForeground}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={submit}
        style={input}
      />
      {error && <Text style={{ marginTop: 12, fontSize: 16, color: theme.down }}>{error}</Text>}
      <Pressable
        onPress={submit}
        disabled={busy}
        style={{ marginTop: 16, padding: 12, borderRadius: 8, backgroundColor: theme.accent, opacity: busy ? 0.6 : 1 }}
      >
        <Text style={{ color: theme.accentForeground, fontSize: 16, textAlign: 'center' }}>
          {busy ? 'Signing in...' : 'Sign in'}
        </Text>
      </Pressable>
      <Link href="/pair" style={{ color: theme.foreground, fontSize: 16, textDecorationLine: 'underline', marginTop: 16 }}>
        Scan the pairing code instead
      </Link>
    </View>
  )
}
