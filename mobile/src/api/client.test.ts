import { expect, test, vi } from 'vitest'
import {
  ApiClient,
  ServerError,
  ServerTooOldError,
  SignedOutError,
  UnreachableError,
  newSession,
  pair,
  signIn
} from './client'

const LINK = 'yardbell://pair?server=http%3A%2F%2F100.64.0.10%3A4000&code=Ab12'
const server = { id: 'http://h:1', address: 'http://h:1', token: 'ybd_t', machine: 'M', deviceId: '1' }

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected the promise to reject')
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

test('sends the bearer token', async () => {
  const fetchImpl = vi.fn(async () => json({ ok: true }))
  await new ApiClient(server, fetchImpl as unknown as typeof fetch).get('/app/about')
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('http://h:1/app/about')
  const headers = init.headers as Record<string, string>
  expect(headers.Authorization).toBe('Bearer ybd_t')
  expect(headers.Accept).toBe('application/json')
})

test('signed_out_on_401', async () => {
  const fetchImpl = vi.fn(async () => json({ error: 'this phone was signed out, pair it again' }, 401))
  await expect(new ApiClient(server, fetchImpl as unknown as typeof fetch).get('/x')).rejects.toBeInstanceOf(
    SignedOutError
  )
})

test('401 without a token is a server error', async () => {
  const fetchImpl = vi.fn(async () => json({ error: 'wrong passcode' }, 401))
  await expect(signIn('http://h:1', 'no', 'Pixel', fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
    name: 'ServerError',
    message: 'wrong passcode'
  })
})

test('unreachable_on_network_error', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new TypeError('Network request failed')
  })
  const err = await failure(new ApiClient(server, fetchImpl as unknown as typeof fetch).get('/x'))
  expect(err).toBeInstanceOf(UnreachableError)
  expect(err.message).toContain('Is Meshnet on?')
})

test('plain text error bodies use a status message', async () => {
  const fetchImpl = vi.fn(async () => new Response('Unsupported Media Type', { status: 415 }))
  const err = await failure(new ApiClient(server, fetchImpl as unknown as typeof fetch).post('/x', {}))
  expect(err).toBeInstanceOf(ServerError)
  expect(err.message).toBe('The server refused the request (415)')
})

const PRE_APP_API_REFUSAL = { error: 'request did not come from the Yardbell page' }

test('old_server_is_reported', async () => {
  const fetchImpl = vi.fn(async () => json(PRE_APP_API_REFUSAL, 403))
  const err = await failure(pair(LINK, 'Pixel', fetchImpl as unknown as typeof fetch))
  expect(err).toBeInstanceOf(ServerTooOldError)
  expect(err.message).toBe('Update Yardbell on http://100.64.0.10:4000 to 0.11.109 or later')
})

test('old server refusing the passcode sign-in is reported', async () => {
  const fetchImpl = vi.fn(async () => json(PRE_APP_API_REFUSAL, 403))
  const err = await failure(signIn('100.64.0.10:4000', '1234', 'Pixel', fetchImpl as unknown as typeof fetch))
  expect(err).toBeInstanceOf(ServerTooOldError)
  expect(err.message).toBe('Update Yardbell on http://100.64.0.10:4000 to 0.11.109 or later')
})

test('other 403 replies to pairing stay server errors', async () => {
  const fetchImpl = vi.fn(async () => json({ error: 'pairing is turned off' }, 403))
  const err = await failure(pair(LINK, 'Pixel', fetchImpl as unknown as typeof fetch))
  expect(err).toBeInstanceOf(ServerError)
  expect(err.message).toBe('pairing is turned off')
})

test('pairing reply without a token is reported as an old server', async () => {
  const fetchImpl = vi.fn(async () => json({ ok: true }))
  const err = await failure(pair(LINK, 'Pixel', fetchImpl as unknown as typeof fetch))
  expect(err).toBeInstanceOf(ServerTooOldError)
})

test('a failed body read is unreachable', async () => {
  const response = json({ ok: true })
  vi.spyOn(response, 'text').mockRejectedValue(new DOMException('Aborted', 'AbortError'))
  const fetchImpl = vi.fn(async () => response)
  const err = await failure(new ApiClient(server, fetchImpl as unknown as typeof fetch).get('/x'))
  expect(err).toBeInstanceOf(UnreachableError)
})

test('about without api is reported with the machine name', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(json({ ok: true, token: 'ybd_n', device: { id: 'd1' } }))
    .mockResolvedValueOnce(json({ machine: 'hp', version: '0.11.100' }))
  const err = await failure(pair(LINK, 'Pixel', fetchImpl as unknown as typeof fetch))
  expect(err).toBeInstanceOf(ServerTooOldError)
  expect(err.message).toBe('Update Yardbell on hp to 0.11.109 or later')
})

test('pair_saves_machine_from_about', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(json({ ok: true, token: 'ybd_n', device: { id: 'd1' } }))
    .mockResolvedValueOnce(json({ machine: 'hp', version: '0.11.107', api: 1 }))
  const result = await pair(LINK, 'Pixel', fetchImpl as unknown as typeof fetch)
  expect(result).toEqual({
    id: 'http://100.64.0.10:4000',
    address: 'http://100.64.0.10:4000',
    token: 'ybd_n',
    machine: 'hp',
    deviceId: 'd1'
  })

  const [pairUrl, pairInit] = fetchImpl.mock.calls[0] as [string, RequestInit]
  expect(pairUrl).toBe('http://100.64.0.10:4000/app/pair/Ab12')
  expect(pairInit.body).toBe(JSON.stringify({ device: 'Pixel' }))
  const pairHeaders = pairInit.headers as Record<string, string>
  expect(pairHeaders.Authorization).toBeUndefined()
  expect(pairHeaders.Origin).toBeUndefined()

  const [aboutUrl, aboutInit] = fetchImpl.mock.calls[1] as [string, RequestInit]
  expect(aboutUrl).toBe('http://100.64.0.10:4000/app/about')
  expect((aboutInit.headers as Record<string, string>).Authorization).toBe('Bearer ybd_n')
})

test('signIn posts the passcode without Authorization and normalizes the address', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(json({ ok: true, token: 'ybd_s', device: { id: 'd2' } }))
    .mockResolvedValueOnce(json({ machine: 'hp', api: 1 }))
  const result = await signIn('100.64.0.10:4000', '1234', 'Pixel', fetchImpl as unknown as typeof fetch)
  expect(result.address).toBe('http://100.64.0.10:4000')
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('http://100.64.0.10:4000/app/sign-in')
  expect(init.body).toBe(JSON.stringify({ passcode: '1234', device: 'Pixel' }))
  expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
})

test('newSession posts the body and surfaces the server message', async () => {
  const body = { machine: 'hp', path: '/a', agent: 'claude', resume: false, wait: false } as const
  const ok = vi.fn(async () => json({ machine: 'hp', name: 'a-1', path: '/a', created: false, repo: '/a' }))
  const started = await newSession(server, body, ok as unknown as typeof fetch)
  expect(started.name).toBe('a-1')
  const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('http://h:1/sessions')
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body as string)).toEqual(body)

  const refused = vi.fn(async () => json({ error: 'hp has no folder /a' }, 400))
  const error = await failure(newSession(server, body, refused as unknown as typeof fetch))
  expect(error).toBeInstanceOf(ServerError)
  expect(error.message).toBe('hp has no folder /a')
})

test('newSession allows two minutes for branch and setup work', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  const ok = vi.fn(async () => json({ machine: 'hp', name: 'a-1', path: '/a', created: false, repo: '/a' }))
  const body = { machine: 'hp', path: '/a', agent: 'claude', resume: false, wait: false } as const
  await newSession(server, body, ok as unknown as typeof fetch)
  expect(timeout).toHaveBeenCalledWith(120_000)
  timeout.mockRestore()
})
