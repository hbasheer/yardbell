import type { PairedServer } from '../servers/store'

export type PairDeps = {
  pair: (link: string, deviceName: string) => Promise<PairedServer>
  signIn: (address: string, passcode: string, deviceName: string) => Promise<PairedServer>
  saveServer: (server: PairedServer) => Promise<void>
  deviceName: () => string
}

export type Outcome = { ok: true } | { ok: false; message: string }

async function finish(attempt: () => Promise<PairedServer>, deps: PairDeps): Promise<Outcome> {
  try {
    await deps.saveServer(await attempt())
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Pairing failed' }
  }
}

export function pairWithLink(link: string, deps: PairDeps): Promise<Outcome> {
  return finish(() => deps.pair(link, deps.deviceName()), deps)
}

export function signInWithPasscode(address: string, passcode: string, deps: PairDeps): Promise<Outcome> {
  return finish(() => deps.signIn(address, passcode, deps.deviceName()), deps)
}
