import { beforeEach, expect, test, vi } from 'vitest'

const backing = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => backing.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      backing.set(k, v)
    }
  }
}))

beforeEach(() => {
  backing.clear()
  vi.resetModules()
})

test('defaults are Geist Mono at 13', async () => {
  const { DEFAULT_PREFS } = await import('./terminalPrefs')
  expect(DEFAULT_PREFS).toEqual({ fontFamily: 'geist-mono', fontSize: 13 })
})

test('parseFontFamily falls back to the default', async () => {
  const { parseFontFamily } = await import('./terminalPrefs')
  expect(parseFontFamily('jetbrains-mono')).toBe('jetbrains-mono')
  expect(parseFontFamily('comic-sans')).toBe('geist-mono')
  expect(parseFontFamily(null)).toBe('geist-mono')
})

test('setters store the choice and ignore sizes the terminal does not offer', async () => {
  const { setFontFamily, setFontSize } = await import('./terminalPrefs')
  setFontFamily('system')
  setFontSize(16)
  setFontSize(17)
  await Promise.resolve()
  expect(backing.get('yardbell:terminal-font-family')).toBe('system')
  expect(backing.get('yardbell:terminal-text-size')).toBe('13')
})
