import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acceptTool,
  answerRun,
  briefRuns,
  clearEndedRuns,
  continueRun,
  deleteRun,
  dropRun,
  listPipelines,
  openTickets,
  pipelineHistory,
  retryRun,
  setPipelineEnabled,
  setTokenLimit,
  startRuns,
  stepTranscript,
  stopRunSession
} from './api'

const server = { id: 'http://h:1', address: 'http://h:1', token: 'ybd_t', machine: 'M', deviceId: '1' }

function reply(body: unknown = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const call = (fetchMock: ReturnType<typeof reply>) => {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined }
}

afterEach(() => vi.unstubAllGlobals())

describe('pipelines api', () => {
  it('reads the list, history and open tickets', async () => {
    let f = reply()
    await listPipelines(server)
    expect(call(f)).toMatchObject({ url: 'http://h:1/api/pipelines', method: 'GET' })
    f = reply()
    await pipelineHistory(server, 'night ly')
    expect(call(f).url).toBe('http://h:1/api/pipelines/night%20ly/history')
    f = reply()
    await openTickets(server)
    expect(call(f).url).toBe('http://h:1/api/pipelines/tickets')
  })

  it('turns a pipeline on or off', async () => {
    const f = reply()
    await setPipelineEnabled(server, 'p', false)
    expect(call(f)).toEqual({ url: 'http://h:1/api/pipelines/p/enabled', method: 'POST', body: { enabled: false } })
  })

  it('starts runs with tickets and links, and clears ended runs', async () => {
    let f = reply({ runs: [] })
    await startRuns(server, 'p', { tickets: ['ENG-1'], prs: [] })
    expect(call(f)).toEqual({ url: 'http://h:1/api/pipelines/p/runs', method: 'POST', body: { tickets: ['ENG-1'], prs: [] } })
    f = reply({ deleted: [] })
    await clearEndedRuns(server, 'p')
    expect(call(f)).toMatchObject({ url: 'http://h:1/api/pipelines/p/clear-runs', method: 'POST' })
  })

  it('asks for the brief runs list, with an optional state', async () => {
    let f = reply({ runs: [] })
    await briefRuns(server)
    expect(call(f).url).toBe('http://h:1/api/runs?brief=1')
    f = reply({ runs: [] })
    await briefRuns(server, 'waiting')
    expect(call(f).url).toBe('http://h:1/api/runs?brief=1&state=waiting')
  })

  it('posts each run action to its own route', async () => {
    const cases: [() => Promise<unknown>, string, string, unknown][] = [
      [() => answerRun(server, 'r1', 'go on'), 'POST', '/api/runs/r1/answer', { text: 'go on' }],
      [() => retryRun(server, 'r1'), 'POST', '/api/runs/r1/retry', {}],
      [() => acceptTool(server, 'r1'), 'POST', '/api/runs/r1/accept-tool', {}],
      [() => dropRun(server, 'r1'), 'POST', '/api/runs/r1/drop', {}],
      [() => continueRun(server, 'r1', 'fail'), 'POST', '/api/runs/r1/continue', { outcome: 'fail' }],
      [() => setTokenLimit(server, 'r1', 5000), 'POST', '/api/runs/r1/token-limit', { limit: 5000 }],
      [() => stopRunSession(server, 'r1', 'yb-1'), 'POST', '/api/runs/r1/stop-session', { name: 'yb-1' }],
      [() => deleteRun(server, 'r1'), 'DELETE', '/api/runs/r1', undefined]
    ]
    for (const [run, method, path, body] of cases) {
      const f = reply()
      await run()
      expect(call(f)).toEqual({ url: `http://h:1${path}`, method, body })
    }
  })

  it('reads a step transcript', async () => {
    const f = reply({ available: false, why: 'gone' })
    expect(await stepTranscript(server, 'r1', 'build step')).toEqual({ available: false, why: 'gone' })
    expect(call(f).url).toBe('http://h:1/api/runs/r1/steps/build%20step/transcript')
  })
})
