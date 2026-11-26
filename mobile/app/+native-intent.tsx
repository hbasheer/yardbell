import { redirectPairingPath } from '@/pairing/nativeIntent'

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return redirectPairingPath(path)
}
