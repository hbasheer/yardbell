import { createGuard } from '../changes/guard'

type Hooks = {
  start: (name: string) => void
  before: () => Promise<unknown>
  fail: (error: unknown) => void
  end: () => void
}

export type TaskRunner = <T>(name: string, task: () => Promise<T>) => Promise<T | undefined>

export function createTaskRunner(hooks: () => Hooks): TaskRunner {
  const guard = createGuard()
  return async (name, task) => {
    if (!guard.begin(name)) return undefined
    const h = hooks()
    h.start(name)
    try {
      await h.before().catch(() => {})
      return await task()
    } catch (error) {
      h.fail(error)
      return undefined
    } finally {
      guard.end()
      h.end()
    }
  }
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
