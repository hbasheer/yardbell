export const DEL = '\x7f'

const COMBINING: [number, number][] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0900, 0x0903],
  [0x093a, 0x094f],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200c, 0x200c],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0x1f3fb, 0x1f3ff],
  [0xe0020, 0xe007f],
  [0xe0100, 0xe01ef]
]

const ZWJ = 0x200d
const isCombining = (cp: number) => COMBINING.some(([from, to]) => cp >= from && cp <= to)
const isRegional = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff

export function graphemes(text: string): string[] {
  const out: string[] = []
  let regionals = 0
  let joined = false
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    const extends_ = out.length > 0 && (isCombining(cp) || cp === ZWJ || joined || (isRegional(cp) && regionals === 1))
    if (extends_) out[out.length - 1] += ch
    else out.push(ch)
    regionals = isRegional(cp) ? (extends_ ? 2 : 1) : 0
    joined = cp === ZWJ
  }
  return out
}

export function diffToBytes(previous: string, next: string): string {
  const before = graphemes(previous)
  const after = graphemes(next)
  let shared = 0
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared++
  return DEL.repeat(before.length - shared) + after.slice(shared).join('')
}

export function singleAddedChar(previous: string, next: string): string | null {
  if (!next.startsWith(previous)) return null
  const added = graphemes(next.slice(previous.length))
  return added.length === 1 ? added[0] : null
}

const LINE_ENDERS = /[\r\n\x1b\x03\x04\x15]/

export const endsLine = (bytes: string): boolean => LINE_ENDERS.test(bytes)
