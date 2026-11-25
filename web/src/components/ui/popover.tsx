// Adapted from Orca (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import * as React from 'react'
import * as PopoverPrimitive from 'radix-ui/popover'
import { cn } from '@/lib/class-names'
import { MENU_SURFACE_CLASS } from './dropdown-menu'

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger

function PopoverContent({ className, align = 'start', sideOffset = 4, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(MENU_SURFACE_CLASS, 'z-[60] w-(--radix-popover-trigger-width) min-w-[14rem] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
