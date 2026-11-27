import { describe, expect, test } from 'vitest'
import { decodeServer, encodeInput, encodeResize, encodeScroll, encodeView, toBase64 } from './protocol'

describe('client frames', () => {
  test('input', () => {
    expect(encodeInput('ls\r')).toBe('{"t":"in","d":"ls\\r"}')
  })

  test('resize, scroll and view', () => {
    expect(encodeResize(40, 100)).toBe('{"t":"resize","rows":40,"cols":100}')
    expect(encodeScroll(-3)).toBe('{"t":"scroll","lines":-3}')
    expect(encodeView(true)).toBe('{"t":"view","on":true}')
  })
})

describe('decodeServer', () => {
  test('exit frame', () => {
    expect(decodeServer('{"t":"exit","msg":"session ended"}')).toEqual({ kind: 'exit', msg: 'session ended' })
  })

  test('binary output', () => {
    const frame = decodeServer(new Uint8Array([104, 105]).buffer)
    expect(frame.kind).toBe('output')
    expect(frame.kind === 'output' && Array.from(frame.bytes)).toEqual([104, 105])
  })

  test('text that is not a frame is shown as output', () => {
    const frame = decodeServer('hi')
    expect(frame.kind === 'output' && Array.from(frame.bytes)).toEqual([104, 105])
  })
})

describe('toBase64', () => {
  test('matches the standard encoding for every padding length', () => {
    for (const text of ['', 'h', 'hi', 'hi!', 'hello world']) {
      const bytes = new TextEncoder().encode(text)
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    }
  })

  test('keeps bytes above 127', () => {
    const bytes = new Uint8Array([0, 255, 128, 27, 91])
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})
