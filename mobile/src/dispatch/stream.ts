import type { StreamLine } from './types'

export class StreamLineError extends Error {
  constructor() {
    super('Dispatch sent a line the phone could not read')
    this.name = 'StreamLineError'
  }
}

export function parseChunk(rest: string, chunk: string): { lines: StreamLine[]; rest: string } {
  const pieces = (rest + chunk).split('\n')
  const tail = pieces.pop() ?? ''
  const lines: StreamLine[] = []
  for (const piece of pieces) {
    if (!piece.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(piece)
    } catch {
      throw new StreamLineError()
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { role?: unknown }).role !== 'string') {
      throw new StreamLineError()
    }
    lines.push(parsed as StreamLine)
  }
  return { lines, rest: tail }
}

export function finishStream(rest: string): StreamLine[] {
  return rest.trim() ? parseChunk('', `${rest}\n`).lines : []
}
