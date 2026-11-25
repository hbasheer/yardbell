export type BrowserPrefs = { engine: string; home: string; zoom: number }

export const ENGINES: Record<string, { label: string; url: string }> = {
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
  brave: { label: 'Brave Search', url: 'https://search.brave.com/search?q=' },
  kagi: { label: 'Kagi', url: 'https://kagi.com/search?q=' }
}

const KEY = 'yardbell.browser.prefs'
const DEFAULTS: BrowserPrefs = { engine: 'duckduckgo', home: '', zoom: 1 }

export function browserPrefs(): BrowserPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return DEFAULTS
  }
}

export function setBrowserPrefs(change: Partial<BrowserPrefs>) {
  localStorage.setItem(KEY, JSON.stringify({ ...browserPrefs(), ...change }))
}

export const searchUrl = (q: string) => `${(ENGINES[browserPrefs().engine] || ENGINES.duckduckgo).url}${encodeURIComponent(q)}`
