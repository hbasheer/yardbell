import { useEffect, useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'

const KEY = 'yardbell.theme'
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
export const THEME_WORD: Record<Theme, string> = { system: 'Auto theme', light: 'Light theme', dark: 'Dark theme' }

function chosen(): Theme {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches
const CHANGED = 'yardbell-theme'
const TERM_KEY = 'yardbell.termTheme'
export type TermTheme = 'app' | 'light' | 'dark'

type FrameTheme = { set: (t: Theme) => void; setTerminal?: (t: TermTheme) => void }
const frames = () => [...document.querySelectorAll('iframe')].map((f) => (f.contentWindow as (Window & { YardbellTheme?: FrameTheme }) | null)?.YardbellTheme).filter(Boolean) as FrameTheme[]

export const themeChoice = chosen

export function setThemeChoice(next: Theme) {
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {}
  window.dispatchEvent(new Event(CHANGED))
  for (const f of frames()) f.set(next)
}

export function terminalTheme(): TermTheme {
  try {
    const t = localStorage.getItem(TERM_KEY)
    return t === 'light' || t === 'dark' ? t : 'app'
  } catch {
    return 'app'
  }
}

export function setTerminalTheme(next: TermTheme) {
  try {
    if (next === 'app') localStorage.removeItem(TERM_KEY)
    else localStorage.setItem(TERM_KEY, next)
  } catch {}
  for (const f of frames()) f.setTerminal?.(next)
}

// The old pages in the frames read the same key and hear the change through the storage event.
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(chosen)

  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && systemDark())
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    }
    apply()
    const media = matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    const heard = (e: StorageEvent) => e.key === KEY && setTheme(chosen())
    const here = () => setTheme(chosen())
    window.addEventListener('storage', heard)
    window.addEventListener(CHANGED, here)
    return () => {
      window.removeEventListener('storage', heard)
      window.removeEventListener(CHANGED, here)
    }
  }, [])

  const cycle = () => setThemeChoice(NEXT[theme])

  return [theme, cycle]
}
