import { normalizeAddress, parsePairingLink } from '../pairing/link'
import type { Branches, Listing, NewSessionBody, Started } from '../new-session/request'
import type { PairedServer } from '../servers/store'

const TIMEOUT_MS = 15_000
const MIN_VERSION = '0.11.107'
const PRE_APP_API_REFUSAL = 'request did not come from the Yardbell page'

export class SignedOutError extends Error {
  constructor(message = 'This phone was signed out, pair it again') {
    super(message)
    this.name = 'SignedOutError'
  }
}

export class UnreachableError extends Error {
  constructor(address: string) {
    super(`Can't reach ${address}. Is Meshnet on?`)
    this.name = 'UnreachableError'
  }
}

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ServerError'
  }
}

export class ServerTooOldError extends Error {
  constructor(name: string) {
    super(`Update Yardbell on ${name} to ${MIN_VERSION} or later`)
    this.name = 'ServerTooOldError'
  }
}

type Target = PairedServer | { address: string }

async function send<T>(
  address: string,
  path: string,
  init: { method: string; body?: unknown; token?: string },
  fetchImpl: typeof fetch
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  let text: string
  try {
    response = await fetchImpl(`${address}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    text = await response.text()
  } catch {
    throw new UnreachableError(address)
  }

  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  const errorField =
    parsed && typeof parsed === 'object' && 'error' in parsed ? (parsed as { error: unknown }).error : undefined
  const message =
    typeof errorField === 'string' && errorField
      ? errorField
      : `The server refused the request (${response.status})`

  if (response.status === 401 && init.token) throw new SignedOutError(message)
  if (!response.ok) throw new ServerError(message, response.status)
  return parsed as T
}

export class ApiClient {
  private readonly address: string
  private readonly token?: string

  constructor(
    server: Target,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.address = server.address
    this.token = 'token' in server ? server.token : undefined
  }

  get<T>(path: string): Promise<T> {
    return send<T>(this.address, path, { method: 'GET', token: this.token }, this.fetchImpl)
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return send<T>(this.address, path, { method: 'POST', body, token: this.token }, this.fetchImpl)
  }
}

type PairReply = { token?: string; device?: { id?: string | number } }

async function requestPairing(address: string, path: string, body: unknown, fetchImpl: typeof fetch) {
  try {
    return await send<PairReply>(address, path, { method: 'POST', body }, fetchImpl)
  } catch (error) {
    if (error instanceof ServerError && error.status === 403 && error.message === PRE_APP_API_REFUSAL) {
      throw new ServerTooOldError(address)
    }
    throw error
  }
}
type About = { machine?: string; api?: number }

async function finishPairing(
  address: string,
  reply: PairReply | undefined,
  fetchImpl: typeof fetch
): Promise<PairedServer> {
  const token = reply?.token
  if (!token) throw new ServerTooOldError(address)
  const about = await send<About>(address, '/app/about', { method: 'GET', token }, fetchImpl)
  const machine = about.machine || address
  if (typeof about.api !== 'number' || about.api < 1) throw new ServerTooOldError(machine)
  return { id: address, address, token, machine, deviceId: String(reply.device?.id ?? '') }
}

export async function pair(
  link: string,
  deviceName: string,
  fetchImpl: typeof fetch = fetch
): Promise<PairedServer> {
  const { address, code } = parsePairingLink(link)
  const reply = await requestPairing(address, `/app/pair/${encodeURIComponent(code)}`, { device: deviceName }, fetchImpl)
  return finishPairing(address, reply, fetchImpl)
}

export async function signIn(
  addressInput: string,
  passcode: string,
  deviceName: string,
  fetchImpl: typeof fetch = fetch
): Promise<PairedServer> {
  const address = normalizeAddress(addressInput)
  const reply = await requestPairing(address, '/app/sign-in', { passcode, device: deviceName }, fetchImpl)
  return finishPairing(address, reply, fetchImpl)
}

const machinePath = (machine: string) => `/machines/${encodeURIComponent(machine)}`

export function newSession(server: PairedServer, body: NewSessionBody, fetchImpl?: typeof fetch): Promise<Started> {
  return new ApiClient(server, fetchImpl).post<Started>('/sessions', body)
}

export function browseFolder(server: PairedServer, machine: string, path: string): Promise<Listing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return new ApiClient(server).get<Listing>(`${machinePath(machine)}/browse${query}`)
}

export function folderBranches(server: PairedServer, machine: string, path: string): Promise<Branches> {
  return new ApiClient(server).get<Branches>(`${machinePath(machine)}/branches?path=${encodeURIComponent(path)}`)
}

export function installedAgents(server: PairedServer, machine: string): Promise<{ installed: string[] }> {
  return new ApiClient(server).get<{ installed: string[] }>(`${machinePath(machine)}/agents`)
}
