import { useCallback, useEffect, useReducer, useRef } from 'react'
import { appendPage, type DiffPages } from '../changes/model'
import type { DiffLine } from '../changes/api'

export type DiffPage = { lines: DiffLine[]; from: number; next: number; total: number }

export type PagedState<P extends DiffPage> = {
  first: P | null
  pages: DiffPages | null
  error: string | null
  moreError: string | null
  loadingMore: boolean
}

export type PagedAction<P extends DiffPage> =
  | { type: 'reset' }
  | { type: 'first'; page: P }
  | { type: 'firstFailed'; message: string }
  | { type: 'moreStarted' }
  | { type: 'more'; page: P }
  | { type: 'moreFailed'; message: string }

export const initialPaged = <P extends DiffPage>(): PagedState<P> => ({ first: null, pages: null, error: null, moreError: null, loadingMore: false })

export function pagedReducer<P extends DiffPage>(state: PagedState<P>, action: PagedAction<P>): PagedState<P> {
  switch (action.type) {
    case 'reset':
      return initialPaged<P>()
    case 'first':
      return { ...initialPaged<P>(), first: action.page, pages: appendPage(null, action.page) }
    case 'firstFailed':
      return { ...initialPaged<P>(), error: action.message }
    case 'moreStarted':
      return { ...state, moreError: null, loadingMore: true }
    case 'more':
      return { ...state, pages: state.pages ? appendPage(state.pages, action.page) : state.pages, moreError: null, loadingMore: false }
    case 'moreFailed':
      return { ...state, moreError: action.message, loadingMore: false }
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function usePagedDiff<P extends DiffPage>(fetchPage: (from: number) => Promise<P>, key: string) {
  const [state, dispatch] = useReducer(pagedReducer<P>, undefined, initialPaged<P>)
  const token = useRef(0)
  const fetching = useRef(false)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const next = useRef<number | null>(null)
  next.current = state.pages ? state.pages.next : null

  const start = useCallback(() => {
    const mine = ++token.current
    fetching.current = false
    dispatch({ type: 'reset' })
    fetchRef
      .current(0)
      .then((page) => token.current === mine && dispatch({ type: 'first', page }))
      .catch((e) => token.current === mine && dispatch({ type: 'firstFailed', message: messageOf(e) }))
  }, [])

  useEffect(() => {
    start()
    return () => {
      token.current += 1
    }
  }, [start, key])

  const more = useCallback(() => {
    const from = next.current
    if (from === null || fetching.current) return
    const mine = token.current
    fetching.current = true
    dispatch({ type: 'moreStarted' })
    fetchRef
      .current(from)
      .then((page) => token.current === mine && dispatch({ type: 'more', page }))
      .catch((e) => token.current === mine && dispatch({ type: 'moreFailed', message: messageOf(e) }))
      .finally(() => {
        if (token.current === mine) fetching.current = false
      })
  }, [])

  return { ...state, more, retry: start }
}
