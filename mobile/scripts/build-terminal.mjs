import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const bundle = await esbuild.build({
  entryPoints: [join(root, 'terminal/main.ts')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'chrome100',
  write: false,
  legalComments: 'none'
})
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
const css = readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8')

const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT_RANGE =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

function fontFace(family, file, range, weight) {
  const data = readFileSync(join(root, 'terminal/fonts', file)).toString('base64')
  return `@font-face{font-family:'${family}';src:url('data:font/woff2;base64,${data}') format('woff2');font-weight:${weight};font-style:normal;font-display:swap;unicode-range:${range}}`
}

const fontCss = [
  fontFace('Geist Mono', 'GeistMono-LatinExt.woff2', LATIN_EXT_RANGE, '100 900'),
  fontFace('Geist Mono', 'GeistMono-Latin.woff2', LATIN_RANGE, '100 900'),
  fontFace('JetBrains Mono', 'JetBrainsMono-LatinExt.woff2', LATIN_EXT_RANGE, '100 800'),
  fontFace('JetBrains Mono', 'JetBrainsMono-Latin.woff2', LATIN_RANGE, '100 800'),
  fontFace('Yardbell Terminal Symbols', 'NotoSansSymbols2-TerminalSubset.woff2', 'U+23F4-23F7', '400')
].join('\n')

const html = readFileSync(join(root, 'terminal/index.html'), 'utf8')
  .replace('{{XTERM_CSS}}', () => css)
  .replace('{{FONT_CSS}}', () => fontCss)
  .replace('{{TERMINAL_JS}}', () => js)

writeFileSync(join(root, 'src/terminal/terminalHtml.ts'), `export const terminalHtml = ${JSON.stringify(html)}\n`)
