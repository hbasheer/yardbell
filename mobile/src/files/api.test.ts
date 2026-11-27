import { afterEach, describe, expect, it, vi } from 'vitest'
import { listFiles, readFile, searchFiles } from './api'

const server = { id: 'http://h:1', address: 'http://h:1', token: 'ybd_t', machine: 'M', deviceId: '1' }

function reply(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const urlOf = (fetchMock: ReturnType<typeof reply>) => (fetchMock.mock.calls[0] as unknown as [string])[0]

afterEach(() => vi.unstubAllGlobals())

describe('files api', () => {
  it('lists a folder, the root by default', async () => {
    const f = reply({ path: '', entries: [], more: false })
    await listFiles(server, 'hp', '/home/dev/app')
    expect(urlOf(f)).toBe('http://h:1/machines/hp/files?root=%2Fhome%2Fdev%2Fapp&path=')
    const g = reply({ path: 'src', entries: [], more: false })
    await listFiles(server, 'hp', '/r', 'src/ui kit')
    expect(urlOf(g)).toBe('http://h:1/machines/hp/files?root=%2Fr&path=src%2Fui%20kit')
  })

  it('reads a file', async () => {
    const f = reply({ path: 'a.md', size: 3, text: 'hi\n', hash: 'h', editable: true })
    expect((await readFile(server, 'hp', '/r', 'a.md')).text).toBe('hi\n')
    expect(urlOf(f)).toBe('http://h:1/machines/hp/file?root=%2Fr&path=a.md')
  })

  it('surfaces the server status for a binary or too large file', async () => {
    reply({ error: 'big.bin is binary' }, 415)
    await expect(readFile(server, 'hp', '/r', 'big.bin')).rejects.toMatchObject({ status: 415, message: 'big.bin is binary' })
    reply({ error: 'too large' }, 413)
    await expect(readFile(server, 'hp', '/r', 'huge.txt')).rejects.toMatchObject({ status: 413 })
  })

  it('searches names or contents', async () => {
    const f = reply({ matches: ['a.ts'], more: false })
    await searchFiles(server, 'hp', '/r', 'to do', 'contents')
    expect(urlOf(f)).toBe('http://h:1/machines/hp/files/search?root=%2Fr&q=to%20do&mode=contents')
  })
})
