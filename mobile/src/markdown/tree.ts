import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import remend from 'remend'

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' }

export type Align = 'left' | 'center' | 'right'

export type MarkdownBlock =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownBlock[][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; children: MarkdownBlock[] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { kind: 'hr' }

const parser = new MarkdownIt({ html: false, linkify: true, breaks: false })

const SAFE_LINK = /^(https?:|mailto:)/i

export function parseMarkdown(source: string, streaming = false): MarkdownBlock[] {
  const text = streaming ? remend(source) : source
  return blocksOf(parser.parse(text, {}), { at: 0 }, null)
}

type Cursor = { at: number }

function blocksOf(tokens: Token[], cursor: Cursor, closing: string | null): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  while (cursor.at < tokens.length) {
    const token = tokens[cursor.at]
    if (token.type === closing) {
      cursor.at += 1
      return out
    }
    cursor.at += 1
    switch (token.type) {
      case 'paragraph_open': {
        const inline = tokens[cursor.at]
        cursor.at += 2
        out.push({ kind: 'paragraph', children: inlineOf(inline.children ?? []) })
        break
      }
      case 'heading_open': {
        const inline = tokens[cursor.at]
        cursor.at += 2
        out.push({ kind: 'heading', level: Number(token.tag.slice(1)), children: inlineOf(inline.children ?? []) })
        break
      }
      case 'fence':
      case 'code_block':
        out.push({ kind: 'code', lang: token.info.trim().split(/\s+/)[0] ?? '', text: token.content.replace(/\n$/, '') })
        break
      case 'hr':
        out.push({ kind: 'hr' })
        break
      case 'blockquote_open':
        out.push({ kind: 'quote', children: blocksOf(tokens, cursor, 'blockquote_close') })
        break
      case 'bullet_list_open':
      case 'ordered_list_open':
        out.push(listOf(tokens, cursor, token))
        break
      case 'table_open':
        out.push(tableOf(tokens, cursor))
        break
    }
  }
  return out
}

function listOf(tokens: Token[], cursor: Cursor, open: Token): MarkdownBlock {
  const ordered = open.type === 'ordered_list_open'
  const close = ordered ? 'ordered_list_close' : 'bullet_list_close'
  const items: MarkdownBlock[][] = []
  while (cursor.at < tokens.length) {
    const token = tokens[cursor.at]
    cursor.at += 1
    if (token.type === close) break
    if (token.type === 'list_item_open') items.push(blocksOf(tokens, cursor, 'list_item_close'))
  }
  const start = ordered ? Number(open.attrGet('start') ?? 1) : 1
  return { kind: 'list', ordered, start: Number.isFinite(start) ? start : 1, items }
}

function tableOf(tokens: Token[], cursor: Cursor): MarkdownBlock {
  const head: Inline[][] = []
  const rows: Inline[][][] = []
  const align: Align[] = []
  let row: Inline[][] | null = null
  let inHead = false
  while (cursor.at < tokens.length) {
    const token = tokens[cursor.at]
    cursor.at += 1
    if (token.type === 'table_close') break
    if (token.type === 'thead_open') inHead = true
    else if (token.type === 'thead_close') inHead = false
    else if (token.type === 'tr_open') row = []
    else if (token.type === 'tr_close' && row) {
      if (inHead) head.push(...row)
      else rows.push(row)
      row = null
    } else if (token.type === 'th_open' || token.type === 'td_open') {
      const inline = tokens[cursor.at]
      cursor.at += 2
      row?.push(inlineOf(inline.children ?? []))
      if (inHead) align.push(alignOf(token))
    }
  }
  return { kind: 'table', head, rows, align }
}

function alignOf(token: Token): Align {
  const style = token.attrGet('style') ?? ''
  if (style.includes('center')) return 'center'
  if (style.includes('right')) return 'right'
  return 'left'
}

type Frame = { kind: 'strong' | 'em' | 'del' | 'link'; href?: string; children: Inline[] }

function inlineOf(tokens: Token[]): Inline[] {
  const root: Inline[] = []
  const stack: Frame[] = []
  const push = (node: Inline) => (stack.length ? stack[stack.length - 1].children : root).push(node)
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        if (token.content) push({ kind: 'text', text: token.content })
        break
      case 'code_inline':
        push({ kind: 'code', text: token.content })
        break
      case 'softbreak':
        push({ kind: 'text', text: ' ' })
        break
      case 'hardbreak':
        push({ kind: 'break' })
        break
      case 'strong_open':
        stack.push({ kind: 'strong', children: [] })
        break
      case 'em_open':
        stack.push({ kind: 'em', children: [] })
        break
      case 's_open':
        stack.push({ kind: 'del', children: [] })
        break
      case 'link_open':
        stack.push({ kind: 'link', href: token.attrGet('href') ?? '', children: [] })
        break
      case 'strong_close':
      case 'em_close':
      case 's_close':
      case 'link_close': {
        const frame = stack.pop()
        if (!frame) break
        if (frame.kind === 'link') {
          const href = frame.href ?? ''
          if (SAFE_LINK.test(href)) push({ kind: 'link', href, children: frame.children })
          else frame.children.forEach(push)
        } else {
          push({ kind: frame.kind, children: frame.children })
        }
        break
      }
      case 'image':
        if (token.content) push({ kind: 'text', text: token.content })
        break
    }
  }
  return root
}

export function plainText(children: Inline[]): string {
  return children
    .map((node) => {
      if (node.kind === 'text' || node.kind === 'code') return node.text
      if (node.kind === 'break') return '\n'
      return plainText(node.children)
    })
    .join('')
}
