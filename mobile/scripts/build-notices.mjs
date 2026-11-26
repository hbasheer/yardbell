import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8')
writeFileSync(join(root, 'src/about/notices.ts'), `export const notices = ${JSON.stringify(text)}\n`)
