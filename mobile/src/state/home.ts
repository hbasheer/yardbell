import type { PairedServer } from '../servers/store'
import type { MachineView, SessionView, StateView } from './types'

export type HomeSection = {
  kind: 'needs-you' | 'machine'
  title: string
  server?: string
  sessions: SessionView[]
  machine?: MachineView
}

type Input = { server: PairedServer; state: StateView }

const needsYou = (session: SessionView) => session.activity === 'blocked' && !session.stopped

function byAttachableThenFolder(a: SessionView, b: SessionView): number {
  if (a.attachable !== b.attachable) return a.attachable ? -1 : 1
  return a.folder.localeCompare(b.folder)
}

export function homeSections(input: Input[]): HomeSection[] {
  const waiting = input.flatMap(({ state }) => state.sessions.filter(needsYou))
  const sections: HomeSection[] = []
  if (waiting.length > 0) sections.push({ kind: 'needs-you', title: 'Needs you', sessions: waiting })

  const multiple = input.length > 1
  for (const { server, state } of input) {
    for (const machine of state.machines) {
      sections.push({
        kind: 'machine',
        title: machine.name,
        server: multiple ? server.id : undefined,
        machine,
        sessions: state.sessions
          .filter((s) => s.machine === machine.name && !needsYou(s))
          .sort(byAttachableThenFolder)
      })
    }
  }
  return sections
}
