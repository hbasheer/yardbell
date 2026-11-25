// Model and effort lists adapted from Orca (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md

export type Level = { value: string; label: string }
export type Model = { id: string; label: string; description?: string; levels: Level[] }
export type Catalog = { models: Model[]; effortLabel: string; defaultEffort: string; defaultLevels: Level[] }

const CLAUDE_LEVELS: Level[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

const CODEX_LEVELS: Level[] = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' }
]

const upTo = (ceiling: string) => CODEX_LEVELS.slice(0, CODEX_LEVELS.findIndex((l) => l.value === ceiling) + 1)

const CATALOGS: Record<string, Catalog> = {
  claude: {
    effortLabel: 'Effort',
    defaultEffort: 'high',
    defaultLevels: CLAUDE_LEVELS,
    models: [
      { id: 'fable', label: 'Fable 5.2', description: 'Most capable for the hardest, longest-running tasks', levels: CLAUDE_LEVELS },
      { id: 'opus', label: 'Opus 5.5', description: 'Best for everyday, complex tasks', levels: CLAUDE_LEVELS },
      { id: 'sonnet', label: 'Sonnet 5.5', description: 'Efficient for routine tasks', levels: CLAUDE_LEVELS },
      { id: 'haiku', label: 'Haiku 5.5', description: 'Fastest for quick answers', levels: [] }
    ]
  },
  codex: {
    effortLabel: 'Reasoning effort',
    defaultEffort: 'medium',
    defaultLevels: upTo('xhigh'),
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', levels: upTo('ultra') },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', levels: upTo('ultra') },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', levels: upTo('max') },
      { id: 'gpt-5.5', label: 'GPT-5.5', levels: upTo('xhigh') },
      { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', levels: upTo('xhigh') }
    ]
  }
}

export type Listed = { id: string; label: string; description?: string; efforts: string[]; default?: boolean }

const LEVEL_LABEL: Record<string, string> = Object.fromEntries([...CLAUDE_LEVELS, ...CODEX_LEVELS].map((l) => [l.value, l.label]))

// The list Claude Code itself gave for this machine, in place of the built-in one.
export function liveCatalog(base: Catalog, listed: Listed[]): Catalog {
  const levels = (efforts: string[]) => efforts.map((value) => ({ value, label: LEVEL_LABEL[value] ?? value }))
  const runs = listed.find((m) => m.default)
  return {
    ...base,
    defaultLevels: runs ? levels(runs.efforts) : base.defaultLevels,
    models: listed.map((m) => ({ id: m.id, label: m.label, description: m.description, levels: levels(m.efforts) }))
  }
}

// Yardbell knows the flags for Claude Code and Codex only, so other agents start on their own settings.
export function catalogFor(agent: string): Catalog | null {
  if (/claude/i.test(agent)) return CATALOGS.claude
  if (/codex/i.test(agent)) return CATALOGS.codex
  return null
}

export function levelsFor(catalog: Catalog, model: string): Level[] {
  if (!model) return catalog.defaultLevels
  return catalog.models.find((m) => m.id === model)?.levels ?? []
}
