import { describe, expect, it, vi } from 'vitest'

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }))

import { ServerError, UnreachableError } from '../api/client'
import { ask, attachmentSource, followTurn, isAlreadyDecided } from './api'
import type { DispatchEvent } from './types'

const server = { id: 'http://h:1', address: 'http://h:1', token: 'ybd_t', machine: 'M', deviceId: '1' }

function ndjson(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    }
  })
  return new Response(body, { status, headers: { 'Content-Type': 'application/x-ndjson' } })
}

describe('ask', () => {
  it('posts with the token, reports the new conversation first, then each event', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async () =>
      ndjson(['{"role":"conversation","id":"abc"}\n{"role":"assis', 'tant","text":"Hi"}\n{"role":"done"}\n'])
    )
    await ask(
      server,
      { text: 'hello' },
      { onConversation: (id) => seen.push(`id ${id}`), onEvent: (e: DispatchEvent) => seen.push(e.role) },
      fetchImpl
    )
    expect(seen).toEqual(['id abc', 'assistant'])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://h:1/dispatch/ask')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ybd_t')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello' })
  })

  it('reads a final line that has no newline', async () => {
    const events: string[] = []
    await ask(server, { text: 'x' }, { onEvent: (e) => events.push(e.role) }, async () => ndjson(['{"role":"error","text":"boom"}']))
    expect(events).toEqual(['error'])
  })

  it('throws the server message for a 409', async () => {
    const reply = async () => new Response(JSON.stringify({ error: 'this conversation is still answering' }), { status: 409 })
    const error = await ask(server, { text: 'x' }, { onEvent: () => {} }, reply).catch((e) => e)
    expect(error).toBeInstanceOf(ServerError)
    expect(error.message).toBe('this conversation is still answering')
    expect(isAlreadyDecided(error)).toBe(true)
  })

  it('throws unreachable when the connection fails', async () => {
    const error = await ask(server, { text: 'x' }, { onEvent: () => {} }, async () => {
      throw new TypeError('network')
    }).catch((e) => e)
    expect(error).toBeInstanceOf(UnreachableError)
  })

  it('throws when a line cannot be read', async () => {
    const error = await ask(server, { text: 'x' }, { onEvent: () => {} }, async () => ndjson(['nope\n'])).catch((e) => e)
    expect(error.message).toBe('Dispatch sent a line the phone could not read')
  })

  it('stops quietly when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const pending = ask(server, { text: 'x' }, { onEvent: () => {}, signal: controller.signal }, fetchImpl)
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
  })
})

describe('followTurn', () => {
  function conversationFetch(busy: boolean[]) {
    let i = 0
    return vi.fn(async () => {
      const state = busy[Math.min(i++, busy.length - 1)]
      return new Response(JSON.stringify({ id: 'abc', title: 't', updated: '', events: [], sessions: [], busy: state }))
    })
  }

  it('polls until busy is false', async () => {
    const original = globalThis.fetch
    const fake = conversationFetch([true, true, false])
    globalThis.fetch = fake as unknown as typeof fetch
    try {
      const updates: boolean[] = []
      const done = await followTurn(server, 'abc', { intervalMs: 1, onUpdate: (c) => updates.push(c.busy) })
      expect(done?.busy).toBe(false)
      expect(updates).toEqual([true, true, false])
      expect(fake).toHaveBeenCalledTimes(3)
    } finally {
      globalThis.fetch = original
    }
  })

  it('stops when cancelled', async () => {
    const original = globalThis.fetch
    globalThis.fetch = conversationFetch([true]) as unknown as typeof fetch
    try {
      const controller = new AbortController()
      const pending = followTurn(server, 'abc', { intervalMs: 5, signal: controller.signal })
      setTimeout(() => controller.abort(), 20)
      await expect(pending).resolves.toBeNull()
    } finally {
      globalThis.fetch = original
    }
  })

  it('keeps polling through a server error such as a restart', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 })
      if (calls === 2) return new Response('{}', { status: 500 })
      return new Response(JSON.stringify({ id: 'abc', title: 't', updated: '', events: [], sessions: [], busy: false }))
    }) as unknown as typeof fetch
    try {
      const done = await followTurn(server, 'abc', { intervalMs: 1 })
      expect(done?.busy).toBe(false)
      expect(calls).toBe(3)
    } finally {
      globalThis.fetch = original
    }
  })

  it('keeps polling through a dropped connection but not through a refusal', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new TypeError('network')
      if (calls === 2) return new Response(JSON.stringify({ error: 'no such conversation' }), { status: 404 })
      return new Response('{}')
    }) as unknown as typeof fetch
    try {
      const error = await followTurn(server, 'abc', { intervalMs: 1 }).catch((e) => e)
      expect(error).toBeInstanceOf(ServerError)
      expect(calls).toBe(2)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('attachmentSource', () => {
  it('builds the url and the bearer header for an image', () => {
    expect(attachmentSource(server, 'abc', '1-a b.png')).toEqual({
      uri: 'http://h:1/dispatch/conversations/abc/attachments/1-a%20b.png',
      headers: { Authorization: 'Bearer ybd_t' }
    })
  })
})
