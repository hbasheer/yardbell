// Settings building blocks adapted from Orca (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/class-names'

export const inputClass =
  'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30'
export const areaClass =
  'w-full min-w-0 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30'

export function Section({
  title,
  description,
  action,
  children
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="max-w-2xl text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

// Title sits outside the card so each group's start and end read at a glance.
export function Group({
  title,
  description,
  action,
  children,
  className
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-2', className)}>
      {(title || action) && (
        <div className="flex items-end justify-between gap-3 px-1">
          <div className="space-y-0.5">
            {title && <h3 className="text-[13px] font-semibold">{title}</h3>}
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="rounded-xl border border-border bg-card px-5 [&>*+*]:border-t [&>*+*]:border-border">{children}</div>
    </div>
  )
}

export function Row({
  label,
  description,
  control,
  alignTop,
  className
}: {
  label: React.ReactNode
  description?: React.ReactNode
  control?: React.ReactNode
  alignTop?: boolean
  className?: string
}) {
  return (
    <div
      className={cn('flex flex-wrap gap-x-4 gap-y-2', description ? 'py-3' : 'py-2.5', alignTop ? 'items-start' : 'items-center justify-between', className)}
    >
      <div className={cn('min-w-0 grow basis-40', description ? 'space-y-1' : 'space-y-0.5')}>
        <div className="text-[13px] font-medium">{label}</div>
        {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {control !== undefined && <div className="max-w-full shrink-0">{control}</div>}
    </div>
  )
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  label: string
  description?: React.ReactNode
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
}) {
  return (
    <Row label={label} description={description} control={<Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />} />
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label
}: {
  value: T
  onChange: (v: T) => void
  options: [T, React.ReactNode][]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center rounded-md border border-border bg-background/50 p-0.5">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          onClick={() => onChange(v)}
          className={cn(
            'h-7 rounded-[5px] px-2.5 text-xs font-medium transition-colors',
            v === value ? 'bg-accent text-accent-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

export type Tone = 'connected' | 'attention' | 'neutral' | 'bad'
const TONE: Record<Tone, string> = {
  connected: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  attention: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  neutral: 'border-border bg-background text-muted-foreground',
  bad: 'border-destructive/40 bg-destructive/10 text-destructive'
}
const DOT: Record<Tone, string> = { connected: 'bg-emerald-500', attention: 'bg-amber-500', neutral: 'bg-muted-foreground', bad: 'bg-destructive' }

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', TONE[tone])}>
      <span className={cn('size-1.5 rounded-full', DOT[tone])} />
      {children}
    </span>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="grid content-start gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <small className="text-[11.5px] leading-relaxed text-muted-foreground">{hint}</small>}
    </label>
  )
}

// An empty list says what it would hold and offers the first step, as Orca's empty panes do.
export function EmptyState({ icon: Icon, title, children, action }: { icon: React.ComponentType<{ className?: string }>; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="grid justify-items-center gap-2 px-6 py-8 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{children}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
