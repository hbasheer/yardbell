export type ServerFrame = { kind: 'output'; bytes: Uint8Array } | { kind: 'exit'; msg: string }

export const encodeInput = (d: string): string => JSON.stringify({ t: 'in', d })
export const encodeResize = (rows: number, cols: number): string => JSON.stringify({ t: 'resize', rows, cols })
export const encodeScroll = (lines: number): string => JSON.stringify({ t: 'scroll', lines })
export const encodeView = (on: boolean): string => JSON.stringify({ t: 'view', on })

function exitMessage(text: string): string | null {
  try {
    const frame = JSON.parse(text) as { t?: unknown; msg?: unknown }
    return frame && frame.t === 'exit' ? String(frame.msg ?? '') : null
  } catch {
    return null
  }
}

export function decodeServer(data: string | ArrayBuffer): ServerFrame {
  if (typeof data !== 'string') return { kind: 'output', bytes: new Uint8Array(data) }
  const msg = exitMessage(data)
  return msg === null ? { kind: 'output', bytes: new TextEncoder().encode(data) } : { kind: 'exit', msg }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    const n = (a << 16) | (b << 8) | c
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }
  return out
}
