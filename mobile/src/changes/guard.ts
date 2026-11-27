export type Guard = { begin(name: string): boolean; end(): void; current(): string | null }

export function createGuard(): Guard {
  let running: string | null = null
  return {
    begin(name) {
      if (running !== null) return false
      running = name
      return true
    },
    end() {
      running = null
    },
    current: () => running
  }
}
