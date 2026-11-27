import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerError } from '../api/client'
import { changeDiff, changePaths, commitChanges, draftMessage, gitAction, listChanges } from './api'

const server = { id: 'http://h:1', address: 'http://h:1', token: 'ybd_t', machine: 'M', deviceId: '1' }

function reply(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const call = (fetchMock: ReturnType<typeof reply>) => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined }
}

afterEach(() => vi.unstubAllGlobals())

describe('changes api', () => {
  it('lists changes for a root on a machine', async () => {
    const f = reply({ branch: 'main', files: [], truncated: false })
    await listChanges(server, 'dev box', '/home/dev/app')
    expect(call(f)).toMatchObject({ url: 'http://h:1/machines/dev%20box/changes?root=%2Fhome%2Fdev%2Fapp', method: 'GET' })
  })

  it('asks for a diff page and leaves out what was not given', async () => {
    const f = reply({ lines: [] })
    await changeDiff(server, 'hp', { root: '/r', path: 'src/a b.ts', staged: true, from: 5000 })
    expect(call(f).url).toBe('http://h:1/machines/hp/changes/diff?root=%2Fr&path=src%2Fa%20b.ts&staged=true&from=5000')
    const g = reply({ lines: [] })
    await changeDiff(server, 'hp', { root: '/r', path: 'a', staged: false })
    expect(call(g).url).toBe('http://h:1/machines/hp/changes/diff?root=%2Fr&path=a&staged=false')
  })

  it('drafts a message from the root', async () => {
    const f = reply({ message: 'Update a', from: 'files' })
    expect(await draftMessage(server, 'hp', '/r')).toEqual({ message: 'Update a', from: 'files' })
    expect(call(f).url).toBe('http://h:1/machines/hp/changes/draft?root=%2Fr')
  })

  it('commits with the message and the chosen files', async () => {
    const f = reply({ sha: 'abcdef123', short: 'abcdef1' })
    await commitChanges(server, 'hp', '/r', 'Fix it', { paths: ['a', 'b'] })
    expect(call(f)).toEqual({ url: 'http://h:1/machines/hp/changes/commit', method: 'POST', body: { root: '/r', message: 'Fix it', paths: ['a', 'b'] } })
    const g = reply({ sha: 'x', short: 'x' })
    await commitChanges(server, 'hp', '/r', 'Fix it', { staged: true })
    expect(call(g).body).toEqual({ root: '/r', message: 'Fix it', staged: true })
  })

  it('stages, unstages and discards paths', async () => {
    for (const action of ['stage', 'unstage', 'discard'] as const) {
      const f = reply({ ok: true })
      await changePaths(server, 'hp', action, '/r', ['a'])
      expect(call(f)).toEqual({ url: `http://h:1/machines/hp/changes/${action}`, method: 'POST', body: { root: '/r', paths: ['a'] } })
    }
  })

  it('runs push, pull and fetch and keeps git\'s message whole when it fails', async () => {
    const f = reply({ ok: true })
    await gitAction(server, 'hp', 'push', '/r')
    expect(call(f)).toEqual({ url: 'http://h:1/machines/hp/changes/push', method: 'POST', body: { root: '/r' } })
    reply({ error: 'git said: Permission denied (publickey).\nfatal: Could not read from remote repository.' }, 422)
    await expect(gitAction(server, 'hp', 'push', '/r')).rejects.toMatchObject({
      message: 'git said: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      status: 422
    })
    reply({ error: 'x' }, 422)
    await expect(gitAction(server, 'hp', 'pull', '/r')).rejects.toBeInstanceOf(ServerError)
  })
})
