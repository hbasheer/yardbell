import { describe, expect, test } from 'vitest'
import type { HealthView } from './types'
import { gb, levelOf, pressure, resourceSummary, resourcesOf } from './resources'

const GB = 1048576
const health = (over: Partial<HealthView> = {}): HealthView => ({
  mem_total_kb: 16 * GB,
  mem_used_kb: 10 * GB,
  agent_kb: 3 * GB,
  user_kb: 0,
  limit_kb: 0,
  limit_used_kb: 0,
  load1: 1.234,
  cpus: 8,
  disk_total_kb: 500 * GB,
  disk_used_kb: 355 * GB,
  ...over
})

describe('levels', () => {
  test('amber from 85, red from 95', () => {
    expect([84, 85, 94, 95].map(levelOf)).toEqual(['normal', 'warn', 'warn', 'bad'])
  })
  test('gb has one decimal', () => expect(gb(1.5 * GB)).toBe('1.5'))
})

describe('resourcesOf', () => {
  test('nothing without health or when the machine is down', () => {
    expect(resourcesOf(true, null)).toBeNull()
    expect(resourcesOf(true, undefined)).toBeNull()
    expect(resourcesOf(false, health())).toBeNull()
  })

  test('memory, cpu and disk', () => {
    const r = resourcesOf(true, health())!
    expect(r.memory).toMatchObject({ pct: 63, level: 'normal', totalGb: '16.0' })
    expect(r.cpu).toEqual({ load: '1.2', cpus: 8 })
    expect(r.disk).toEqual({ pct: 71, level: 'normal', totalGb: '500.0', freeGb: '145.0' })
    expect(r.limit).toBeNull()
  })

  test('without a user total memory splits into agents, other and free', () => {
    const parts = resourcesOf(true, health())!.memory!.parts
    expect(parts.map((p) => [p.key, p.kb / GB])).toEqual([
      ['agents', 3],
      ['other', 7],
      ['free', 6]
    ])
  })

  test('with a user total there is a yours part, and other is dropped when empty', () => {
    const split = resourcesOf(true, health({ user_kb: 5 * GB }))!.memory!.parts
    expect(split.map((p) => [p.key, p.kb / GB])).toEqual([
      ['agents', 3],
      ['mine', 2],
      ['other', 5],
      ['free', 6]
    ])
    const all = resourcesOf(true, health({ user_kb: 10 * GB }))!.memory!.parts
    expect(all.map((p) => p.key)).toEqual(['agents', 'mine', 'free'])
  })

  test('sums larger than memory in use are clamped', () => {
    const parts = resourcesOf(true, health({ agent_kb: 40 * GB }))!.memory!.parts
    expect(parts[0].kb).toBe(10 * GB)
    expect(parts.at(-1)!.kb).toBe(6 * GB)
  })

  test('old server with only memory fields', () => {
    const old = { mem_total_kb: 8 * GB, mem_used_kb: 4 * GB, agent_kb: 0, user_kb: 0, limit_kb: 0, limit_used_kb: 0 } as HealthView
    const r = resourcesOf(true, old)!
    expect(r.cpu).toBeNull()
    expect(r.disk).toBeNull()
    expect(resourceSummary(r).map((p) => p.text)).toEqual(['Memory 50%'])
  })

  test('zero memory total yields no memory block', () => {
    expect(resourcesOf(true, health({ mem_total_kb: 0, disk_total_kb: 0 }))!.memory).toBeNull()
  })

  test('account limit', () => {
    const r = resourcesOf(true, health({ limit_kb: 8 * GB, limit_used_kb: 7.5 * GB }))!
    expect(r.limit).toEqual({ pct: 94, level: 'warn', usedGb: '7.5', limitGb: '8.0' })
    expect(pressure(health({ limit_kb: 8 * GB, limit_used_kb: 7.5 * GB }))).toBe(94)
    expect(pressure(health())).toBe(63)
    expect(pressure(null)).toBe(0)
  })
})

describe('resourceSummary', () => {
  test('line parts in web wording with levels', () => {
    const r = resourcesOf(true, health({ mem_used_kb: 14.5 * GB, disk_used_kb: 480 * GB }))!
    expect(resourceSummary(r)).toEqual([
      { text: 'Memory 91%', level: 'warn' },
      { text: 'CPU 1.2', level: 'normal' },
      { text: 'Disk 96%', level: 'bad' }
    ])
  })

  test('limit shows only when tighter than memory', () => {
    const tight = resourcesOf(true, health({ limit_kb: 4 * GB, limit_used_kb: 3.8 * GB }))!
    expect(resourceSummary(tight).map((p) => p.text)).toContain('Limit 95%')
    const loose = resourcesOf(true, health({ limit_kb: 40 * GB, limit_used_kb: 1 * GB }))!
    expect(resourceSummary(loose).map((p) => p.text).join()).not.toContain('Limit')
  })

  test('empty for no resources', () => expect(resourceSummary(null)).toEqual([]))
})
