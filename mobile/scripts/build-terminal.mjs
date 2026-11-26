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
const html = readFileSync(join(root, 'terminal/index.html'), 'utf8')
  .replace('{{XTERM_CSS}}', () => css)
  .replace('{{TERMINAL_JS}}', () => js)

writeFileSync(join(root, 'src/terminal/terminalHtml.ts'), `export const terminalHtml = ${JSON.stringify(html)}\n`)
