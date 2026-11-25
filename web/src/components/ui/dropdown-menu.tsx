// Adapted from Orca (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import * as React from 'react'
import * as DropdownMenuPrimitive from 'radix-ui/dropdown-menu'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'

export const MENU_SURFACE_CLASS =
  'rounded-[12px] border border-black/7 bg-popover p-[6px] text-popover-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.08)] dark:border-white/9 dark:shadow-[0_12px_32px_rgba(0,0,0,0.45)]'

export const ROW =
  "relative flex cursor-default items-center gap-2 rounded-md px-2.5 py-[5px] text-[13px] leading-4 font-normal outline-hidden select-none focus:bg-black/8 dark:focus:bg-white/14 data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[15px] [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:stroke-[1.5]"

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

function DropdownMenuContent({ className, sideOffset = 4, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          MENU_SURFACE_CLASS,
          'z-50 min-w-[11rem] overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({ className, variant, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { variant?: 'destructive' }) {
  return (
    <DropdownMenuPrimitive.Item
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

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn('-mx-[6px] my-[6px] h-px bg-black/7 dark:bg-white/10', className)} {...props} />
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label className={cn('px-2.5 py-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase', className)} {...props} />
  )
}

const DropdownMenuSub = DropdownMenuPrimitive.Sub

function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger className={cn(ROW, 'data-[state=open]:bg-black/8 dark:data-[state=open]:bg-white/14', className)} {...props}>
      {children}
      <ChevronRight className="ml-auto size-3.5 opacity-70" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent className={cn(MENU_SURFACE_CLASS, 'z-50 min-w-[11rem] overflow-hidden', className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('ml-auto shrink-0 pl-4 whitespace-nowrap text-muted-foreground', className)} {...props} />
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuShortcut
}
