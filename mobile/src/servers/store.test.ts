import { beforeEach, expect, test, vi } from 'vitest'

const backing = new Map<string, string>()
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => backing.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    backing.set(k, v)
  },
  deleteItemAsync: async (k: string) => {
    backing.delete(k)
  }
}))
vi.mock('../../modules/yardbell-notify', () => ({ setServers: vi.fn() }))

import { setServers } from '../../modules/yardbell-notify'
import { forgetServer, listServers, onServersChanged, saveServer, type PairedServer } from './store'

const a: PairedServer = { id: 'http://a:1', address: 'http://a:1', token: 'ybd_a', machine: 'A', deviceId: '1' }
const b: PairedServer = { id: 'http://b:2', address: 'http://b:2', token: 'ybd_b', machine: 'B', deviceId: '2' }

beforeEach(() => {
  backing.clear()
  vi.mocked(setServers).mockClear()
})

test('save, list, forget round trip and notify setServers each time', async () => {
  const seen: PairedServer[][] = []
  const off = onServersChanged((s) => seen.push(s))

  expect(await listServers()).toEqual([])
  await saveServer(a)
  await saveServer(b)
  expect(await listServers()).toEqual([a, b])
  expect(setServers).toHaveBeenLastCalledWith([
    { address: a.address, token: a.token },
    { address: b.address, token: b.token }
  ])

  await forgetServer(a.id)
  expect(await listServers()).toEqual([b])
  expect(setServers).toHaveBeenCalledTimes(3)
  expect(setServers).toHaveBeenLastCalledWith([{ address: b.address, token: b.token }])
  expect(seen).toHaveLength(3)

  off()
  await forgetServer(b.id)
  expect(seen).toHaveLength(3)
})

test('saving a server again replaces its token', async () => {
  await saveServer(a)
  await saveServer({ ...a, token: 'ybd_new' })
  expect(await listServers()).toEqual([{ ...a, token: 'ybd_new' }])
})
