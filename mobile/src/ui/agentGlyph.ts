export type GlyphActivity = 'active' | 'idle' | 'blocked'
export type AgentGlyphKind = 'working' | 'question' | 'idle' | 'stopped'

export function agentGlyphKind(session: { activity: GlyphActivity; stopped?: string | null }): AgentGlyphKind {
  if (session.stopped) return 'stopped'
  if (session.activity === 'blocked') return 'question'
  if (session.activity === 'active') return 'working'
  return 'idle'
}

export function agentGlyphLabel(kind: AgentGlyphKind): string {
  switch (kind) {
    case 'working':
      return 'Working'
    case 'question':
      return 'Needs you'
    case 'idle':
      return 'Idle'
    case 'stopped':
      return 'Stopped'
  }
}
