import { useCallback, useEffect, useRef, useState } from 'react'
import type { YardbellState } from '@/lib/state'
import { activeItem, currentSpace, focusedGroup, load, MODE_EVENT, save, sync, type Layouts } from './layout'

export type WorkspaceStore = {
  layout: Layouts
  update: (fn: (l: Layouts) => Layouts) => void
  focusedKey: string | null
}

export function useWorkspace(state: YardbellState | null): WorkspaceStore {
  const [layout, setLayout] = useState<Layouts>(load)
  const missing = useRef(new Map<string, number>())

  useEffect(() => {
    if (state) setLayout((l) => sync(l, state, missing.current))
  }, [state])

  const stateRef = useRef(state)
  stateRef.current = state
  useEffect(() => {
    const changed = () => stateRef.current && setLayout((l) => sync(l, stateRef.current!, missing.current))
    window.addEventListener(MODE_EVENT, changed)
    return () => window.removeEventListener(MODE_EVENT, changed)
  }, [])

  useEffect(() => save(layout), [layout])

  const update = useCallback((fn: (l: Layouts) => Layouts) => setLayout((l) => fn(l)), [])
  const sp = currentSpace(layout)
  const item = sp ? activeItem(focusedGroup(sp)) : null
  return { layout, update, focusedKey: item?.key ?? null }
}
