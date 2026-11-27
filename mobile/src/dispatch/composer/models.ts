import type { DispatchSettings } from '../../settings/serverApi'

export type ModelChoice = { id: string; label: string; description?: string }

export const CLAUDE_MODELS: ModelChoice[] = [
  { id: 'fable', label: 'Fable 5.2', description: 'Most capable for the hardest, longest-running tasks' },
  { id: 'opus', label: 'Opus 5.5', description: 'Best for everyday, complex tasks' },
  { id: 'sonnet', label: 'Sonnet 5.5', description: 'Efficient for routine tasks' },
  { id: 'haiku', label: 'Haiku 5.5', description: 'Fastest for quick answers' }
]

export const CODEX_MODELS: ModelChoice[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' }
]

export type ApprovalMode = 'prompt' | 'allow' | 'deny'

export const APPROVALS: { id: ApprovalMode; label: string; detail: string }[] = [
  { id: 'prompt', label: 'Ask first', detail: 'Ask me to approve each step' },
  { id: 'allow', label: 'Go ahead', detail: 'Start, stop and type into sessions without asking' },
  { id: 'deny', label: 'Refuse', detail: 'Refuse each step, unless a rule allows it' }
]

export function approvalOf(settings: DispatchSettings | undefined): ApprovalMode {
  const raw = settings?.approval
  if (raw === 'allow' || raw === 'auto') return 'allow'
  if (raw === 'deny') return 'deny'
  return 'prompt'
}

export function modelsFor(backend: string | undefined): ModelChoice[] {
  return backend === 'codex' ? CODEX_MODELS : CLAUDE_MODELS
}

export function currentModel(settings: DispatchSettings | undefined): string {
  return settings?.runs_on === 'codex' ? (settings.codex_model ?? '') : (settings?.model ?? '')
}

export function modelChange(settings: DispatchSettings | undefined, id: string): Partial<DispatchSettings> {
  return settings?.runs_on === 'codex' ? { codex_model: id } : { model: id }
}

export function filterModels(models: ModelChoice[], query: string): ModelChoice[] {
  const q = query.trim().toLowerCase()
  return q ? models.filter((m) => m.label.toLowerCase().includes(q) || m.id.includes(q)) : models
}
