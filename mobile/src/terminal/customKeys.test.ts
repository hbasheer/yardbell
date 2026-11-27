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

test('buildCustomKey makes text and ctrl keys', async () => {
  const { buildCustomKey } = await import('./customKeys')
  expect(buildCustomKey({ label: 'deploy', kind: 'text', text: 'make ship', enter: true }, 'a')).toEqual({
    id: 'a',
    label: 'deploy',
    bytes: 'make ship\r'
  })
  expect(buildCustomKey({ label: 'Ctrl+K', kind: 'ctrl', letter: 'k' }, 'b')).toEqual({ id: 'b', label: 'Ctrl+K', bytes: '\x0b' })
  expect(buildCustomKey({ label: 'x', kind: 'text', text: 'yes', enter: false }, 'c')).toMatchObject({ bytes: 'yes' })
})

test('buildCustomKey says what is wrong', async () => {
  const { buildCustomKey } = await import('./customKeys')
  expect(buildCustomKey({ label: ' ', kind: 'text', text: 'a', enter: false }, 'a')).toEqual({ error: 'Give the key a label.' })
  expect(buildCustomKey({ label: 'x', kind: 'text', text: '', enter: true }, 'a')).toEqual({ error: 'Enter the text the key sends.' })
  expect(buildCustomKey({ label: 'x', kind: 'ctrl', letter: '12' }, 'a')).toEqual({ error: 'Ctrl needs a single letter, A to Z.' })
  expect(buildCustomKey({ label: 'a'.repeat(13), kind: 'ctrl', letter: 'a' }, 'a')).toHaveProperty('error')
})

test('parseCustomKeys drops bad entries and bad JSON', async () => {
  const { parseCustomKeys } = await import('./customKeys')
  expect(parseCustomKeys('nope')).toEqual([])
  expect(parseCustomKeys(null)).toEqual([])
  expect(parseCustomKeys(JSON.stringify([{ id: 'a', label: 'l', bytes: 'x' }, { id: 1 }, { id: 'b', label: 'l', bytes: '' }]))).toEqual([
    { id: 'a', label: 'l', bytes: 'x' }
  ])
})

test('keys are added, saved and removed', async () => {
  const { addCustomKey, removeCustomKey, parseCustomKeys } = await import('./customKeys')
  await addCustomKey({ id: 'a', label: 'one', bytes: '1' })
  await addCustomKey({ id: 'b', label: 'two', bytes: '2' })
  expect(parseCustomKeys(backing.get('yardbell:custom-keys') ?? null).map((k) => k.id)).toEqual(['a', 'b'])
  await removeCustomKey('a')
  expect(parseCustomKeys(backing.get('yardbell:custom-keys') ?? null).map((k) => k.id)).toEqual(['b'])
})

test('keys saved earlier are kept when a new one is added', async () => {
  backing.set('yardbell:custom-keys', JSON.stringify([{ id: 'old', label: 'old', bytes: 'o' }]))
  const { addCustomKey, parseCustomKeys } = await import('./customKeys')
  await addCustomKey({ id: 'new', label: 'new', bytes: 'n' })
  expect(parseCustomKeys(backing.get('yardbell:custom-keys') ?? null).map((k) => k.id)).toEqual(['old', 'new'])
})
