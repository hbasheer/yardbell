import { useEffect, useRef, useState } from 'react'
import { PAGES, type PageId } from './pages'

type Frames = Map<PageId, HTMLIFrameElement>

// Each page loads once and then stays alive behind the others, so switching never reloads it and a
// Workspace keeps its terminals connected.
export function PageHost({
  page,
  pending,
  native,
  onFrames,
  children
}: {
  page: PageId
  pending: { id: PageId; search: string } | null
  native: PageId[]
  onFrames: (frames: Frames) => void
  children?: React.ReactNode
}) {
  const [visited, setVisited] = useState<Map<PageId, string>>(() => new Map([[page, '']]))
  const frames = useRef<Frames>(new Map())

  useEffect(() => {
    setVisited((v) => (v.has(page) ? v : new Map(v).set(page, '')))
  }, [page])

  useEffect(() => {
    if (!pending) return
    setVisited((v) => (v.has(pending.id) ? v : new Map(v).set(pending.id, pending.search)))
  }, [pending])

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      {PAGES.filter((p) => visited.has(p.id) && !native.includes(p.id)).map((p) => {
        const search = visited.get(p.id) || ''
        const src = `${p.legacy}${search}`
        return (
          <iframe
            key={p.id}
            title={p.name}
            src={src}
            data-yardbell-host=""
            ref={(el) => {
              if (el) frames.current.set(p.id, el)
              else frames.current.delete(p.id)
              onFrames(frames.current)
            }}
            className="absolute inset-0 size-full border-0 bg-background"
            hidden={p.id !== page}
          />
        )
      })}
      {children}
    </div>
  )
}
