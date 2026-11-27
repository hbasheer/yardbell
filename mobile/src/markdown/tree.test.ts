import { describe, expect, it } from 'vitest'
import { parseMarkdown, plainText } from './tree'

describe('parseMarkdown', () => {
  it('reads paragraphs with strong, emphasis, code and a hard break', () => {
    const [block] = parseMarkdown('Hello **big** and *small* `code`  \nnext')
    expect(block).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', text: 'Hello ' },
        { kind: 'strong', children: [{ kind: 'text', text: 'big' }] },
        { kind: 'text', text: ' and ' },
        { kind: 'em', children: [{ kind: 'text', text: 'small' }] },
        { kind: 'text', text: ' ' },
        { kind: 'code', text: 'code' },
        { kind: 'break' },
        { kind: 'text', text: 'next' }
      ]
    })
  })

  it('reads heading levels', () => {
    const blocks = parseMarkdown('# One\n\n### Three')
    expect(blocks.map((b) => (b.kind === 'heading' ? b.level : 0))).toEqual([1, 3])
  })

  it('reads bullet and ordered lists with nested lists and a start number', () => {
    const [bullets, ordered] = parseMarkdown('- a\n- b\n  - c\n\n3. x\n4. y')
    expect(bullets.kind === 'list' && bullets.ordered).toBe(false)
    if (bullets.kind !== 'list') throw new Error('list')
    expect(bullets.items).toHaveLength(2)
    expect(bullets.items[1].map((b) => b.kind)).toEqual(['paragraph', 'list'])
    if (ordered.kind !== 'list') throw new Error('list')
    expect(ordered.ordered).toBe(true)
    expect(ordered.start).toBe(3)
    expect(ordered.items).toHaveLength(2)
  })

  it('reads fenced code with its language and keeps indentation', () => {
    const [block] = parseMarkdown('```rust\nfn main() {\n    run();\n}\n```')
    expect(block).toEqual({ kind: 'code', lang: 'rust', text: 'fn main() {\n    run();\n}' })
  })

  it('reads indented code, quotes and rules', () => {
    const blocks = parseMarkdown('    indented\n\n> quoted **text**\n\n---')
    expect(blocks.map((b) => b.kind)).toEqual(['code', 'quote', 'hr'])
    const quote = blocks[1]
    if (quote.kind !== 'quote') throw new Error('quote')
    expect(quote.children[0].kind).toBe('paragraph')
  })

  it('reads a table with alignment', () => {
    const [table] = parseMarkdown('| Name | Count |\n|:--|--:|\n| a | 1 |\n| b | 2 |')
    if (table.kind !== 'table') throw new Error('table')
    expect(table.align).toEqual(['left', 'right'])
    expect(table.head.map(plainText)).toEqual(['Name', 'Count'])
    expect(table.rows.map((row) => row.map(plainText))).toEqual([['a', '1'], ['b', '2']])
  })

  it('keeps links with a safe scheme and links bare urls', () => {
    const [block] = parseMarkdown('[docs](https://example.com/a) and https://example.org')
    if (block.kind !== 'paragraph') throw new Error('paragraph')
    const links = block.children.filter((n) => n.kind === 'link')
    expect(links.map((n) => (n.kind === 'link' ? n.href : ''))).toEqual(['https://example.com/a', 'https://example.org'])
  })

  it('drops the target of a link that is not http, https or mailto and keeps its text', () => {
    const [block] = parseMarkdown('[run](javascript:alert(1))')
    expect(block).toEqual({ kind: 'paragraph', children: [{ kind: 'text', text: '[run](javascript:alert(1))' }] })
    const [other] = parseMarkdown('[file](file:///etc/passwd)')
    expect(plainText(other.kind === 'paragraph' ? other.children : [])).toContain('file')
    expect(JSON.stringify(other)).not.toContain('"link"')
  })

  it('does not pass raw html through', () => {
    const [block] = parseMarkdown('<script>x</script>')
    expect(JSON.stringify(block)).not.toContain('"link"')
    expect(block.kind).toBe('paragraph')
  })

  it('shows an image as its description', () => {
    const [block] = parseMarkdown('![a diagram](https://example.com/x.png)')
    if (block.kind !== 'paragraph') throw new Error('paragraph')
    expect(plainText(block.children)).toBe('a diagram')
  })

  it('closes partial markdown while streaming and leaves it alone otherwise', () => {
    const open = parseMarkdown('This is **half', true)
    if (open[0].kind !== 'paragraph') throw new Error('paragraph')
    expect(open[0].children.some((n) => n.kind === 'strong')).toBe(true)
    const plain = parseMarkdown('This is **half', false)
    if (plain[0].kind !== 'paragraph') throw new Error('paragraph')
    expect(plain[0].children.some((n) => n.kind === 'strong')).toBe(false)
  })

  it('renders an unfinished code fence as code while streaming', () => {
    const blocks = parseMarkdown('Look:\n\n```ts\nconst a = 1', true)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code'])
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'ts', text: 'const a = 1' })
  })

  it('returns nothing for empty text', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown('', true)).toEqual([])
  })
})
