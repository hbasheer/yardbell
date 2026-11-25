const ICONS: Record<string, string> = {
  start: 'M5.5 3.5v9l7-4.5z',
  manual: 'M5.5 8V4a1 1 0 0 1 2 0v3.5 M7.5 7V3a1 1 0 0 1 2 0v4 M9.5 7.5V4.5a1 1 0 0 1 2 0V9a4.5 4.5 0 0 1-8.2 2.6L2.6 9.4a1 1 0 0 1 1.6-1.2l1.3 1.3',
  schedule: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M8 5v3l2 1.5',
  ticket: 'M2.5 5a1.5 1.5 0 0 0 0 3v3h11V8a1.5 1.5 0 0 1 0-3V2.5h-11z M6.5 4.5v6',
  pull: 'M4.5 2.5v11 M4.5 4.5a1.5 1.5 0 1 0 0-.01 M11.5 13.5a1.5 1.5 0 1 0 0-.01 M11.5 12V7a2 2 0 0 0-2-2H7',
  agent: 'M2.5 3.5h11v9h-11z M5 6.5l2 1.5-2 1.5 M8.5 10h2.5',
  plan: 'M8 2.5v11 M3.5 4.5h6.5l2 1.75-2 1.75H3.5z',
  push: 'M8 13V3.5 M4.5 7 8 3.5 11.5 7',
  checks: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M5.5 8l1.75 1.75L10.5 6.5',
  update: 'M3 3.5h10v9H3z M5.5 8l1.75 1.75L10.5 6.5',
  call: 'M2.5 8h8 M8 5l3 3-3 3 M13.5 3v10',
  tool: 'M9.5 3.5a3 3 0 0 0-3.8 3.8L2.5 10.5l3 3 3.2-3.2a3 3 0 0 0 3.8-3.8l-2 2-2-2z',
  command: 'M3 4.5 6.5 8 3 11.5 M8 12h5',
  report: 'M2.5 4h11v8h-11z M2.5 4 8 8.5 13.5 4',
  wait: 'M6 4v8 M10 4v8',
  webhook: 'M6 6.5a2.5 2.5 0 1 1 3.5 2.3 M5 13a2.5 2.5 0 1 1 1.2-4.7 M11 13a2.5 2.5 0 0 1-2.5-2.5h-4',
  connector: 'M6 2.5v3 M10 2.5v3 M4.5 5.5h7v3a3.5 3.5 0 0 1-7 0z M8 12v1.5'
}

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[kind] || ICONS.agent} />
    </svg>
  )
}
