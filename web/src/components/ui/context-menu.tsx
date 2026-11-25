// Adapted from Orca (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import * as React from 'react'
import * as ContextMenuPrimitive from 'radix-ui/context-menu'
import { cn } from '@/lib/class-names'
import { MENU_SURFACE_CLASS, ROW } from './dropdown-menu'

const ContextMenu = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(MENU_SURFACE_CLASS, 'z-50 min-w-[12rem] overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0', className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({ className, variant, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Item> & { variant?: 'destructive' }) {
  return (
    <ContextMenuPrimitive.Item
      data-variant={variant}
      className={cn(
        ROW,
        'data-[variant=destructive]:text-[color-mix(in_srgb,var(--destructive)_78%,black)] dark:data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10',
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cn('-mx-[6px] my-[6px] h-px bg-black/7 dark:bg-white/10', className)} {...props} />
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator }
