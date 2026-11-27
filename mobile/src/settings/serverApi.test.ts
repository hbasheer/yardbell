import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeMemory,
  getMemory,
  runTrigger,
  setDispatchSettings,
  setPhoneSettings,
  setTriggerEnabled,
  type PhoneSettings
} from './serverApi'

const server = { id: 'http://h:1', address: 'http://h:1', token: 'ybd_t', machine: 'M', deviceId: '1' }

type Seen = { url: string; method: string; body?: unknown }

function script(replies: unknown[]) {
  const seen: Seen[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method as string, body: init.body ? JSON.parse(init.body as string) : undefined })
      return new Response(JSON.stringify(replies[seen.length - 1] ?? {}), { status: 200 })
    })
  )
  return seen
}

const phone: PhoneSettings = {
  app_connected: true,
  wait_minutes: 5,
  agent_waiting: true,
  session_ended: false,
  machines: true,
  memory: true,
  pipeline_waiting: true,
  pipeline_finished: false,
  proposals: true,
  dispatch: true,
  pull_ci_failed: true,
  pull_conflicts: true,
  pull_ready: true,
  pull_merged: false,
  pull_closed: false,
  limit_reset: true
}

afterEach(() => vi.unstubAllGlobals())

describe('setDispatchSettings', () => {
  it('re-reads the server before saving so a change made elsewhere survives, and returns the saved values', async () => {
    const seen = script([
      { dispatch: { instructions: 'Be brief', model: 'opus', runs_on: 'claude', approval: 'allow', rules: [{ action: 'any', machine: 'any', folder: '', approval: 'allow' }] } },
      { ok: true },
      { dispatch: { instructions: 'Be brief', model: 'sonnet' } }
    ])
    const saved = await setDispatchSettings(server, { model: 'sonnet' })
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET http://h:1/api/settings',
      'POST http://h:1/api/settings/dispatch',
      'GET http://h:1/api/settings'
    ])
    expect(seen[1].body).toEqual({
      instructions: 'Be brief',
      agent: '',
      runs_on: 'claude',
      model: 'sonnet',
      codex_model: '',
      approval: 'allow',
      rules: [{ action: 'any', machine: 'any', folder: '', approval: 'allow' }]
    })
    expect(saved.dispatch?.model).toBe('sonnet')
  })

  it('fills defaults and leaves approval out when the server has none', async () => {
    const seen = script([{}, { ok: true }, {}])
    await setDispatchSettings(server, { instructions: 'x' })
    expect(seen[1].body).toEqual({ instructions: 'x', agent: '', runs_on: 'claude', model: '', codex_model: '', rules: [] })
  })
})

describe('setPhoneSettings', () => {
  it('saves the whole object over the freshly read one, without app_connected', async () => {
    const seen = script([{ phone }, { ok: true }, { phone: { ...phone, pipeline_finished: true } }])
    const saved = await setPhoneSettings(server, { pipeline_finished: true })
    expect(seen[1]).toMatchObject({ url: 'http://h:1/api/settings/phone', method: 'POST' })
    const { app_connected: _, ...rest } = phone
    expect(seen[1].body).toEqual({ ...rest, pipeline_finished: true })
    expect(saved.pipeline_finished).toBe(true)
  })

  it('says so when the server sends no phone settings', async () => {
    script([{}])
    await expect(setPhoneSettings(server, { wait_minutes: 2 })).rejects.toThrow('phone notification settings')
  })
})

describe('triggers and memory', () => {
  it('switches a trigger and runs it now', async () => {
    let seen = script([{ triggers: [] }])
    await setTriggerEnabled(server, 'Morning', false)
    expect(seen[0]).toEqual({ url: 'http://h:1/api/triggers/enable', method: 'POST', body: { name: 'Morning', enabled: false } })
    seen = script([{ conversation: 'c1' }])
    expect(await runTrigger(server, 'Morning')).toEqual({ conversation: 'c1' })
    expect(seen[0]).toEqual({ url: 'http://h:1/api/triggers/run', method: 'POST', body: { name: 'Morning' } })
  })

  it('reads and changes memory', async () => {
    let seen = script([{ entries: [], bytes: 0, max_bytes: 8192, omitted: 0, file: 'f', history: [] }])
    await getMemory(server)
    expect(seen[0]).toMatchObject({ url: 'http://h:1/dispatch/memory', method: 'GET' })
    seen = script([{ entries: ['a'] }])
    await changeMemory(server, { change: 'replace', old: 'a', entry: 'b' })
    expect(seen[0]).toEqual({ url: 'http://h:1/dispatch/memory', method: 'POST', body: { change: 'replace', old: 'a', entry: 'b' } })
  })
})
