import { useCallback, useEffect, useRef, useState } from 'react'
import { appendPage, type DiffPages } from '../../changes/model'
import type { ReviewFilePage } from '../types'

type Loaded = { first: ReviewFilePage; pages: DiffPages }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function usePagedFile(fetchPage: (from: number) => Promise<ReviewFilePage>, key: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const token = useRef(0)
  const fetching = useRef(false)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage

  const start = useCallback(() => {
    const mine = ++token.current
    fetching.current = false
    setLoaded(null)
    setError(null)
    setLoadingMore(false)
    fetchRef
      .current(0)
      .then((first) => token.current === mine && setLoaded({ first, pages: appendPage(null, first) }))
      .catch((e) => token.current === mine && setError(messageOf(e)))
  }, [])

  useEffect(() => {
    start()
    return () => {
      token.current += 1
    }
  }, [start, key])

  const more = useCallback(() => {
    if (!loaded || fetching.current) return
    const mine = token.current
    fetching.current = true
    setLoadingMore(true)
    fetchRef
      .current(loaded.pages.next)
      .then((page) => token.current === mine && setLoaded((c) => (c ? { first: c.first, pages: appendPage(c.pages, page) } : c)))
      .catch((e) => token.current === mine && setError(messageOf(e)))
      .finally(() => {
        if (token.current !== mine) return
        fetching.current = false
        setLoadingMore(false)
      })
  }, [loaded])

  return { loaded, error, loadingMore, more, retry: start }
}
