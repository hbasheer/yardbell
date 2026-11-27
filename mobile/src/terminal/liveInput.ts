export const DEL = '\x7f'

// What the terminal needs to see for the field to go from `previous` to `next`: a backspace for
// every character the edit took away, then the characters it added.
export function diffToBytes(previous: string, next: string): string {
  const before = Array.from(previous)
  const after = Array.from(next)
  let shared = 0
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared++
  return DEL.repeat(before.length - shared) + after.slice(shared).join('')
}

export function singleAddedChar(previous: string, next: string): string | null {
  if (!next.startsWith(previous)) return null
  const added = Array.from(next.slice(previous.length))
  return added.length === 1 ? added[0] : null
}
