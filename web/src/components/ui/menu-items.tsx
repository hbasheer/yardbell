import type { LucideIcon } from 'lucide-react'
import { ContextMenuItem, ContextMenuSeparator } from './context-menu'
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from './dropdown-menu'

export type MenuEntry =
  | { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; shortcut?: string; disabled?: boolean }
  | 'separator'
  | ''
  | null
  | undefined
  | false

// A menu still closing holds focus and the pointer, so a dialog an item opens waits for it to go.
export const later = (fn: () => void) => setTimeout(fn, 0)

// One list of entries drives both the "⋯" menu and the right-click menu of the same thing.
export function MenuItems({ items, as }: { items: MenuEntry[]; as: 'dropdown' | 'context' }) {
  const Item = as === 'dropdown' ? DropdownMenuItem : ContextMenuItem
  const Separator = as === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator
  const shown = items.filter(Boolean) as Exclude<MenuEntry, '' | null | undefined | false>[]
  return (
    <>
      {shown.map((entry, i) => {
        if (entry === 'separator') return i > 0 && i < shown.length - 1 && shown[i - 1] !== 'separator' ? <Separator key={`s${i}`} /> : null
        const Icon = entry.icon
        return (
          <Item key={entry.label} variant={entry.danger ? 'destructive' : undefined} disabled={entry.disabled} onSelect={() => later(entry.onSelect)}>
            {Icon && <Icon />}
            {entry.label}
            {entry.shortcut && <DropdownMenuShortcut>{entry.shortcut}</DropdownMenuShortcut>}
          </Item>
        )
      })}
    </>
  )
}
