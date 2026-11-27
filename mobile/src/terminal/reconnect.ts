import type { StateView } from '../state/types'

export const EXIT_LIMIT = 3
export const EXIT_WINDOW_MS = 60_000

export type ExitBudget = {
  recordExit: (now: number) => boolean
  reset: () => void
}

export function createExitBudget(limit = EXIT_LIMIT, windowMs = EXIT_WINDOW_MS): ExitBudget {
  let exits: number[] = []
  return {
    recordExit(now) {
      exits = [...exits.filter((at) => now - at < windowMs), now]
      return exits.length < limit
    },
    reset() {
      exits = []
    }
  }
}

export function isListedLive(state: StateView | undefined, machine: string, name: string): boolean {
  const session = state?.sessions.find((s) => s.machine === machine && s.tmux === name)
  return Boolean(session && session.attachable && !session.stopped && !session.stale)
}

export function shouldRetryAfterExit(budgetAllows: boolean, state: StateView | undefined, machine: string, name: string): boolean {
  return budgetAllows && isListedLive(state, machine, name)
}

export function shouldReconnectOnForeground(
  status: 'connecting' | 'open' | 'reconnecting' | 'ended',
  state: StateView | undefined,
  machine: string,
  name: string
): boolean {
  return (status === 'reconnecting' || status === 'ended') && isListedLive(state, machine, name)
}
