import { useSyncExternalStore } from 'react'

const isDark = () => document.documentElement.classList.contains('dark')

export function useDark(): boolean {
  return useSyncExternalStore((fn) => {
    const watch = new MutationObserver(fn)
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => watch.disconnect()
  }, isDark)
}
