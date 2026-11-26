type Role = 'yes' | 'always' | 'no'
export type Choice = { number: number; label: string; keys: string; role?: Role }
export type AgentInfo = {
  agent: string | null
  state: string
  choices?: Choice[]
  screen?: string | null
}

export type Reply = { word: string; keys: string | null; primary?: boolean }

const ROLE_ORDER: Role[] = ['yes', 'always', 'no']
const ROLE_WORDS: Record<Role, string> = { yes: 'Yes', always: 'Always', no: 'No' }

export function repliesFor(info: AgentInfo): Reply[] {
  const choices = info.choices ?? []
  if (choices.length === 0) return []
  if (info.state === 'permission') {
    return choices
      .filter((c): c is Choice & { role: Role } => !!c.role && ROLE_ORDER.includes(c.role))
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
      .map((c) => ({ word: ROLE_WORDS[c.role], keys: c.keys, primary: c.role === 'yes' }))
  }
  if (info.state === 'question') {
    return [...choices.map((c) => ({ word: `${c.number}. ${c.label}`, keys: c.keys })), { word: 'Cancel', keys: null }]
  }
  return []
}
