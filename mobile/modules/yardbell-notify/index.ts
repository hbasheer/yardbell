import { type EventSubscription, NativeModule, requireOptionalNativeModule } from 'expo'

type Server = { address: string; token: string }

type Events = {
  open: (event: { link: string }) => void
}

declare class YardbellNotifyModule extends NativeModule<Events> {
  setServers(list: Server[]): void
  start(): void
  getInitialLink(): string | null
}

const native = requireOptionalNativeModule<YardbellNotifyModule>('YardbellNotify')

export function setServers(list: Server[]): void {
  native?.setServers(list)
}

export function start(): void {
  native?.start()
}

export function addOpenListener(fn: (link: string) => void): EventSubscription {
  if (!native) return { remove() {} }
  return native.addListener('open', ({ link }) => fn(link))
}

export function getInitialLink(): string | null {
  return native?.getInitialLink() ?? null
}
