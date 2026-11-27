import { describe, expect, it } from 'vitest'
import { StreamLineError, finishStream, parseChunk } from './stream'

describe('parseChunk', () => {
  it('splits whole lines and ignores blank ones', () => {
    const out = parseChunk('', '{"role":"conversation","id":"abc"}\n\n{"role":"assistant","text":"Hi"}\n')
    expect(out.lines).toEqual([
      { role: 'conversation', id: 'abc' },
      { role: 'assistant', text: 'Hi' }
    ])
    expect(out.rest).toBe('')
  })

  it('keeps a partial line until the rest arrives', () => {
    const first = parseChunk('', '{"role":"assistant","te')
    expect(first.lines).toEqual([])
    const second = parseChunk(first.rest, 'xt":"Hi"}\n{"role":"do')
    expect(second.lines).toEqual([{ role: 'assistant', text: 'Hi' }])
    expect(second.rest).toBe('{"role":"do')
    expect(parseChunk(second.rest, 'ne"}\n').lines).toEqual([{ role: 'done' }])
  })

  it('rejects a line that is not JSON', () => {
    expect(() => parseChunk('', '{"role":"assistant"\n')).toThrow(StreamLineError)
  })

  it('rejects JSON that is not an event', () => {
    expect(() => parseChunk('', '[1]\n')).toThrow(StreamLineError)
    expect(() => parseChunk('', '{"text":"x"}\n')).toThrow(StreamLineError)
  })
})

describe('finishStream', () => {
  it('reads a last line the server did not end with a newline', () => {
    expect(finishStream('{"role":"done"}')).toEqual([{ role: 'done' }])
    expect(finishStream('  ')).toEqual([])
  })
})
