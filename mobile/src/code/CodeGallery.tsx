import { useCallback, useState } from 'react'
import { Text, View } from 'react-native'
import type { DiffLine } from '../changes/api'
import { colors, radii, spacing, themedStyleSheet, typography, useColorScheme } from '../ui/theme'
import { DiffList } from './DiffList'
import { TextViewer } from './TextViewer'

export type CodeGroup = 'small' | 'big' | 'binary' | 'cut' | 'long' | 'markdown' | 'jump'

export const CODE_GROUPS: CodeGroup[] = ['small', 'big', 'binary', 'cut', 'long', 'markdown', 'jump']

const hunk = (t: string): DiffLine => ({ k: 'hunk', o: null, n: null, t })

const smallDiff: DiffLine[] = [
  hunk('@@ -10,7 +10,8 @@ export function run() {'),
  { k: 'ctx', o: 10, n: 10, t: '  const server = pick()' },
  { k: 'ctx', o: 11, n: 11, t: '  const rows = load(server)' },
  { k: 'del', o: 12, n: null, t: '  return rows.filter(Boolean)' },
  { k: 'add', o: null, n: 12, t: '  const kept = rows.filter(Boolean)' },
  { k: 'add', o: null, n: 13, t: '  return kept.sort(byAge).map((row) => ({ ...row, server: server.name, seen: Date.now(), label: `${row.name} (${row.id})` }))' },
  { k: 'ctx', o: 13, n: 14, t: '}' },
  hunk('@@ -48,3 +49,3 @@ function byAge(a, b) {'),
  { k: 'ctx', o: 48, n: 49, t: '  const left = a.at' },
  { k: 'del', o: 49, n: null, t: '  return left - b.at' },
  { k: 'add', o: null, n: 50, t: '  return b.at - left' },
  { k: 'ctx', o: 50, n: 51, t: '}' }
]

function bigPage(from: number, count: number): DiffLine[] {
  const lines: DiffLine[] = []
  if (from === 0) lines.push(hunk('@@ -1,6000 +1,6400 @@'))
  let old = from === 0 ? 1 : from - 200 + 1
  let now = old
  while (lines.length < count) {
    const at = lines.length
    if (at % 9 === 3) lines.push({ k: 'del', o: old++, n: null, t: `    let value_${old} = compute(${old}); // removed` })
    else if (at % 9 === 4 || at % 9 === 6) lines.push({ k: 'add', o: null, n: now++, t: `    let value_${now} = compute_again(${now}); // added` })
    else {
      lines.push({ k: 'ctx', o: old++, n: now++, t: `    println!("row {}", ${now});` })
    }
  }
  return lines
}

const BIG_TOTAL = 12000
const BIG_PAGE = 5000

function fileText(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}: const entry_${i + 1} = { id: ${i + 1}, name: 'item ${i + 1}' }`).join('\n')
}

const longLine = `const payload = ${JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ id: i, label: `entry number ${i}` })) })}`
const longFile = ['// A file with one very long line', 'const short = 1', longLine, 'const after = 2'].join('\n')

const notes = `# Release notes

Phone app step 3 adds **Changes**, **Files** and *Pipelines*.

- Review a diff with line numbers
- Open a file and jump to a line
- \`Show more\` pages a long diff

\`\`\`ts
const answer = 42
\`\`\`
`

function Block({ title, children, height = 440 }: { title: string; children: React.ReactNode; height?: number }) {
  useColorScheme()
  return (
    <View style={styles.block}>
      <Text style={styles.title}>{title}</Text>
      <View style={[styles.frame, { height }]}>{children}</View>
    </View>
  )
}

function BigDiff() {
  const [lines, setLines] = useState(() => bigPage(0, BIG_PAGE))
  const [loading, setLoading] = useState(false)
  const more = useCallback(() => {
    setLoading(true)
    setTimeout(() => {
      setLines((current) => [...current, ...bigPage(current.length, Math.min(BIG_PAGE, BIG_TOTAL - current.length))])
      setLoading(false)
    }, 300)
  }, [])
  return <DiffList lines={lines} next={lines.length} total={BIG_TOTAL} loadingMore={loading} onMore={more} />
}

export function CodeGallery({ group }: { group: CodeGroup }) {
  switch (group) {
    case 'small':
      return (
        <Block title="Diff: two hunks, fold rows, long added line" height={380}>
          <DiffList lines={smallDiff} next={smallDiff.length} total={smallDiff.length} />
        </Block>
      )
    case 'big':
      return (
        <Block title="Diff: 5000 lines of 12000, Show more" height={560}>
          <BigDiff />
        </Block>
      )
    case 'binary':
      return (
        <>
          <Block title="Diff: binary" height={140}>
            <DiffList lines={[]} binary />
          </Block>
          <Block title="Diff: no lines changed, with a note" height={160}>
            <DiffList lines={[]} notes={['Renamed, 100% the same']} />
          </Block>
          <Block title="Diff: too large" height={140}>
            <DiffList lines={[]} tooLarge />
          </Block>
          <Block title="File: binary, too large, empty" height={400}>
            <TextViewer text="" binary />
            <TextViewer text="" tooLarge />
            <TextViewer text="" />
          </Block>
        </>
      )
    case 'cut':
      return (
        <>
          <Block title="Diff: cut by the server" height={300}>
            <DiffList lines={smallDiff} next={smallDiff.length} total={smallDiff.length} cut />
          </Block>
          <Block title="File: cut, with a note" height={300}>
            <TextViewer text={fileText(30)} cut notes={['Showing the first 1 MB.']} />
          </Block>
        </>
      )
    case 'long':
      return (
        <Block title="File: a very long line scrolls sideways" height={300}>
          <TextViewer text={longFile} />
        </Block>
      )
    case 'markdown':
      return (
        <Block title="File: markdown, preview first" height={460}>
          <TextViewer text={notes} markdown />
        </Block>
      )
    case 'jump':
      return (
        <Block title="File: 30000 lines, jump to line 1200" height={460}>
          <TextViewer text={fileText(30000)} line={1200} />
        </Block>
      )
  }
}

const styles = themedStyleSheet(() => ({
  block: { marginTop: spacing.lg, paddingHorizontal: spacing.lg },
  title: { color: colors.textMuted, fontSize: typography.metaSize, fontWeight: '600', marginBottom: spacing.sm },
  frame: { borderRadius: radii.control, overflow: 'hidden', borderWidth: 1, borderColor: colors.borderSubtle }
}))
