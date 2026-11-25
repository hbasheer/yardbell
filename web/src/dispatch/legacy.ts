// The approval, review, pull request and group cards, dictation and the scan dialog still come from the
// old pages, so they behave exactly as they always have. Their stylesheet sits in the lowest cascade
// layer, so it styles only their own classes and never the new page around them.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Module = Record<string, any>
export type Legacy = {
  lit: Module
  repeat: Module
  steps: Module
  pulls: Module
  scans: Module
  groups: Module
  tasks: Module
  voice: Module
  attach: Module
}

// Names the new page's stylesheet also defines, so the old ones get their own.
const SHARED = [
  'accent',
  'muted',
  'primary',
  'radius',
  'radius-sm',
  'split-divider',
  'split-divider-hover',
  'tab-active',
  'tab-inactive',
  'agent-question',
  'agent-working'
]
// Each old rule is narrowed to the old cards, their dialogs and their menus, so it keeps its exact
// look there and never reaches the new page. Rules on :root and html only define colours, so they stay.
const SCOPE = ':where(.yb-legacy, .yb-legacy *, body > dialog, body > dialog *, #scan-menu, #scan-menu *)'
// The old cards draw from these names, so pointing them at the new design's tokens gives every old
// card the new colours, fonts and corners in both themes; the rules after match the new buttons,
// badges and card frame.
const SCOPED = `
.yb-legacy, body > dialog, #scan-menu {
  --ink: var(--foreground);
  --ink-2: color-mix(in oklab, var(--foreground) 82%, transparent);
  --yb-muted: var(--muted-foreground);
  --line: var(--border);
  --line-strong: color-mix(in oklab, var(--foreground) 18%, transparent);
  --surface: var(--card);
  --bg: var(--background);
  --side: var(--muted);
  --hover: var(--accent);
  --selected: var(--accent);
  --yb-primary: var(--primary);
  --primary-hover: color-mix(in oklab, var(--primary) 88%, var(--background));
  --primary-ink: var(--primary-foreground);
  --primary-shadow: none;
  --btn-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
  --btn-press: none;
  --card-shadow: none;
  --pill-shadow: none;
  --yb-accent: var(--foreground);
  --accent-text: var(--foreground);
  --accent-soft: var(--accent);
  --yb-radius: 0.75rem;
  --radius-sm: 0.5rem;
  --sans: var(--font-sans);
  --mono: var(--font-mono);
  color: var(--ink);
  font: 14px/1.5 var(--sans);
}
body > dialog { margin: auto; border: 1px solid var(--border); border-radius: 0.75rem; background: var(--card); color: var(--foreground); box-shadow: 0 20px 60px rgb(0 0 0 / 0.28); }
.yb-legacy .btn, body > dialog .btn, #scan-menu .btn {
  height: 32px; padding: 0 12px; gap: 6px; border: 1px solid var(--border); border-radius: 0.5rem;
  background: var(--background); color: var(--foreground); font: 500 13px/1 var(--sans); box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
}
.yb-legacy .btn:hover, body > dialog .btn:hover { background: var(--accent); }
.yb-legacy .btn.primary, body > dialog .btn.primary { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
.yb-legacy .btn.primary:hover, body > dialog .btn.primary:hover { background: color-mix(in oklab, var(--primary) 88%, var(--background)); }
.yb-legacy .btn.quiet, body > dialog .btn.quiet { border-color: transparent; background: transparent; box-shadow: none; color: var(--muted-foreground); }
.yb-legacy .btn.quiet:hover, body > dialog .btn.quiet:hover { background: var(--accent); color: var(--foreground); }
.yb-legacy .btn.danger:hover, body > dialog .btn.danger:hover { color: var(--destructive); }
.yb-legacy .btn .icon, body > dialog .btn .icon { width: 14px; height: 14px; }
.yb-legacy .badge { height: 20px; padding: 0 8px; border: 1px solid var(--border); border-radius: 999px; background: color-mix(in oklab, var(--muted) 60%, transparent); color: var(--muted-foreground); font: 500 11px/1 var(--sans); }
.yb-legacy .badge.busy { border-color: color-mix(in oklab, #10b981 30%, transparent); background: color-mix(in oklab, #10b981 10%, transparent); color: var(--ok-text); }
.yb-legacy .badge.blocked { border-color: color-mix(in oklab, #f59e0b 35%, transparent); background: color-mix(in oklab, #f59e0b 10%, transparent); color: var(--warn-text); font-weight: 500; }
.yb-legacy .badge.done { border-color: color-mix(in oklab, #10b981 30%, transparent); background: color-mix(in oklab, #10b981 10%, transparent); color: var(--ok-text); }
.yb-legacy .badge.failed { border-color: color-mix(in oklab, var(--destructive) 30%, transparent); background: color-mix(in oklab, var(--destructive) 10%, transparent); color: var(--destructive); }
.yb-legacy .step-card, .yb-legacy .review-card, .yb-legacy .pull-card, .yb-legacy .group-card, .yb-legacy .results-card, .yb-legacy .session-card {
  border: 1px solid var(--border); border-radius: 0.75rem; background: var(--card); box-shadow: none;
}
.yb-legacy .step-card.pending { border-color: color-mix(in oklab, #f59e0b 45%, var(--border)); }
.yb-legacy .step-card.running, .yb-legacy .step-card.done, .yb-legacy .step-card.ready { border-color: var(--border); }
.yb-legacy .step-card.failed { border-color: color-mix(in oklab, var(--destructive) 40%, var(--border)); }
.yb-legacy .step-card-head { padding: 14px 16px 0; gap: 12px; }
.yb-legacy .step-card-icon { width: 30px; height: 30px; border-radius: 0.5rem; background: var(--muted); color: var(--muted-foreground); }
.yb-legacy .step-card.pending .step-card-icon { background: color-mix(in oklab, #f59e0b 14%, transparent); color: var(--warn-text); }
.yb-legacy .step-card-title > strong { font-size: 13.5px; }
.yb-legacy .step-card-where { font-size: 12px; }
.yb-legacy .step-card-body { padding: 10px 16px 0 58px; }
.yb-legacy .step-card-label { font-size: 11px; font-weight: 500; text-transform: none; color: var(--muted-foreground); }
.yb-legacy .step-card-text { font-size: 13px; }
.yb-legacy .step-card-mono { border: 1px solid color-mix(in oklab, var(--border) 70%, transparent); border-radius: 0.5rem; background: color-mix(in oklab, var(--muted) 50%, transparent); font-size: 12px; }
.yb-legacy .step-card-note { margin: 8px 16px 0 58px; }
.yb-legacy .step-card-foot { padding: 12px 16px 14px; border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); margin-top: 12px; }
.yb-legacy .step-card-trail { font-size: 11.5px; }
.yb-legacy .steps-bar { border: 1px solid color-mix(in oklab, #f59e0b 35%, var(--border)); border-radius: 0.75rem; background: color-mix(in oklab, #f59e0b 6%, var(--card)); padding: 10px 14px; font-size: 13px; }
.yb-legacy .link-btn { color: var(--foreground); font: 500 12.5px var(--sans); text-decoration: underline; text-underline-offset: 2px; }
.yb-legacy input, .yb-legacy textarea, .yb-legacy select, body > dialog input, body > dialog textarea, body > dialog select {
  border: 1px solid var(--input, var(--border)); border-radius: 0.5rem; background: var(--background); color: var(--foreground); font: 13px var(--sans);
}
body > dialog h2 { font: 600 16px/1.3 var(--sans); }
.yb-legacy .step-card-form label, body > dialog label { font: 500 12px/1.4 var(--sans); color: var(--muted-foreground); }
.yb-legacy .step-card-form label input, .yb-legacy .step-card-form label textarea, .yb-legacy .step-card-form label select { margin-top: 4px; }
body > dialog svg, .yb-legacy svg, #scan-menu svg { display: inline-block; vertical-align: middle; }
`

function splitList(selector: string) {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(selector.slice(start, i))
      start = i + 1
    }
  }
  out.push(selector.slice(start))
  return out.map((x) => x.trim()).filter(Boolean)
}

function narrow(selector: string) {
  if (/^(:root|html)(?![\w-])/.test(selector)) return selector
  let depth = 0
  for (let i = 0; i < selector.length - 1; i++) {
    const c = selector[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && c === ':' && selector[i + 1] === ':') return `${selector.slice(0, i)}${SCOPE}${selector.slice(i)}`
  }
  return `${selector}${SCOPE}`
}

function narrowRules(rules: CSSRuleList) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) rule.selectorText = splitList(rule.selectorText).map(narrow).join(', ')
    else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) narrowRules(rule.cssRules)
  }
}

let loading: Promise<Legacy> | null = null

function script(src: string) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`could not load ${src}`))
    document.head.append(s)
  })
}

// The old stylesheet picks its dark colours from data-theme, the new page from the dark class.
function followTheme() {
  const root = document.documentElement
  const set = () => {
    const dark = root.classList.contains('dark') ? 'dark' : 'light'
    if (root.dataset.theme !== dark) root.dataset.theme = dark
  }
  set()
  new MutationObserver(set).observe(root, { attributes: true, attributeFilter: ['class'] })
}

const load = (path: string) => import(/* @vite-ignore */ path) as Promise<Module>

export function loadLegacy(): Promise<Legacy> {
  loading ??= (async () => {
    let css = await fetch('/style.css').then((r) => {
      if (!r.ok) throw new Error(`could not load the card styles (${r.status})`)
      return r.text()
    })
    for (const name of SHARED) css = css.replace(new RegExp(`--${name}(?![\\w-])`, 'g'), `--yb-${name}`)
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(`${css}\n${SCOPED}`)
    narrowRules(sheet.cssRules)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    followTheme()
    await Promise.all(['/pull.js', '/voice-keys.js', '/insights.js'].map(script))
    const [lit, repeat, steps, pulls, scans, groups, tasks, voice, attach] = await Promise.all([
      load('/vendor/lit-html/lit-html.js'),
      load('/vendor/lit-html/directives/repeat.js'),
      load('/dispatch-review.js'),
      load('/dispatch-pull.js'),
      load('/dispatch-scan.js'),
      load('/dispatch-group.js'),
      load('/dispatch-tasks.js'),
      load('/voice.js'),
      load('/attachments.js')
    ])
    return { lit, repeat, steps, pulls, scans, groups, tasks, voice, attach }
  })()
  loading.catch(() => (loading = null))
  return loading
}
