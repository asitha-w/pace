import { describe, expect, test } from 'claude-code/testing'

import {
  configFrom,
  captureDue,
  capturePrompt,
  newTrack,
  noteFile,
  onStep,
  onTick,
  parsePoint,
  parseCapture,
  resumeMarker,
  statusText,
  resumeText,
  textFor,
  withSignal,
} from '../hooks/logic'
import type { Step } from '../hooks/logic'

const cfg = configFrom({})
const step = (over: Partial<Step>): Step => ({
  at: 0,
  prompt: 50_000,
  read: 49_000,
  write: 1_000,
  output: 500,
  model: 'm',
  tools: [],
  ...over,
})

describe('config', () => {
  test('defaults and minutes', () => {
    expect(cfg.warn).toBe(150_000)
    expect(cfg.cache_ttl).toBe(3600)
    expect(cfg.expiring).toBe(300)
    const custom = configFrom({ cache_ttl_minutes: 5, expiring_minutes: 1, hint: 'save state, then /clear' })
    expect(custom.cache_ttl).toBe(300)
    expect(custom.expiring).toBe(60)
    expect(custom.hint).toBe('save state, then /clear')
  })
})

describe('onStep', () => {
  test('jump names the previous step tools', () => {
    const track = newTrack()
    onStep(track, step({ tools: ['Read'] }), 1, cfg)
    const out = onStep(track, step({ at: 1000, prompt: 90_000, read: 50_000, write: 40_000 }), 1, cfg)
    const jump = out.find(d => d.kind === 'jump')
    expect(jump?.metrics.tools).toEqual(['Read'])
    expect(jump?.metrics.delta).toBe(39_500)
  })

  test('rewrite inside the cache lifetime, not after it', () => {
    const track = newTrack()
    onStep(track, step({ prompt: 100_000, read: 99_000 }), 1, cfg)
    const miss = onStep(track, step({ at: 60_000, prompt: 101_000, read: 0, write: 101_000, model: 'n' }), 2, cfg)
    expect(miss.find(d => d.kind === 'rewrite')?.metrics.cause).toBe('model switch m → n')
    expect(track.rewrites).toBe(1)
    const late = onStep(track, step({ at: 60_000 + 3_700_000, prompt: 102_000, read: 0, write: 102_000, model: 'n' }), 3, cfg)
    expect(late.some(d => d.kind === 'rewrite')).toBe(false)
  })

  test('heavy enters once, updates past high, clears below warn', () => {
    const track = newTrack()
    expect(onStep(track, step({ prompt: 160_000 }), 1, cfg).map(d => `${d.kind}:${d.phase}`)).toContain('heavy:enter')
    expect(onStep(track, step({ prompt: 165_000 }), 2, cfg).some(d => d.kind === 'heavy')).toBe(false)
    expect(onStep(track, step({ prompt: 260_000 }), 3, cfg).map(d => `${d.kind}:${d.phase}`)).toContain('heavy:update')
    expect(onStep(track, step({ prompt: 20_000, read: 0, write: 20_000 }), 4, cfg).map(d => `${d.kind}:${d.phase}`)).toContain(
      'heavy:clear',
    )
  })
})

describe('onTick', () => {
  test('expiring, then cold, then cleared by the next step', () => {
    const track = newTrack()
    onStep(track, step({ prompt: 120_000 }), 1, cfg)
    expect(onTick(track, 1_000_000, 1, cfg)).toEqual([])
    const expiring = onTick(track, 3_400_000, 1, cfg)
    expect(expiring.map(d => `${d.kind}:${d.phase}`)).toEqual(['expiring:enter'])
    expect(onTick(track, 3_450_000, 1, cfg).map(d => `${d.kind}:${d.phase}`)).toEqual(['expiring:update'])
    expect(onTick(track, 3_700_000, 1, cfg).map(d => `${d.kind}:${d.phase}`)).toEqual(['expiring:clear', 'cold:enter'])
    expect(onTick(track, 3_800_000, 1, cfg)).toEqual([])
    expect(onStep(track, step({ at: 3_900_000 }), 2, cfg).map(d => `${d.kind}:${d.phase}`)).toContain('cold:clear')
  })

  test('a small session goes cold quietly', () => {
    const track = newTrack()
    onStep(track, step({ prompt: 20_000 }), 1, cfg)
    expect(onTick(track, 3_700_000, 1, cfg).some(d => d.kind === 'cold')).toBe(false)
  })
})

describe('band', () => {
  test('heavy shows only at high', () => {
    const s = { kind: 'heavy' as const, phase: 'enter' as const, sessionId: 's', text: '', hint: '' }
    expect(withSignal({}, { ...s, metrics: { context: 160_000, turns: 1 } }, cfg.high).heavy).toBeUndefined()
    expect(withSignal({}, { ...s, metrics: { context: 260_000, turns: 1 } }, cfg.high).heavy).toBeDefined()
  })
})

describe('notes', () => {
  test('a note round-trips into a resume point and resume text', () => {
    const facts = {
      sessionId: 'abcdef1234',
      cwd: '/w',
      branch: 'main',
      context: 182_000,
      turns: 45,
      reason: 'expiring',
      createdMs: Date.parse('2026-10-03T14:32:00Z'),
      prompts: ['build the pace mod'],
      edited: ['/w/a.ts'],
      read: [],
    }
    const text = noteFile(facts, 'Pace mod v1\n\n## Goal\nship it')
    const point = parsePoint('/d/x.md', text)
    expect(point).toEqual({ path: '/d/x.md', title: 'Pace mod v1', cwd: '/w', createdMs: facts.createdMs, context: 182_000 })
    const resumed = resumeText('/d/x.md', text)
    expect(resumed.startsWith(resumeMarker('/d/x.md'))).toBe(true)
    expect(resumed.includes('pace_resume')).toBe(false)
    expect(parsePoint('/d/y.md', '# just a file')).toBeUndefined()
  })
})

describe('work captures', () => {
  const cap = (context: number, text: string, drifted = false) => ({ context, turns: 1, text, drifted, why: '' })

  test('the baseline is due at topic_at, then a check every topic_every', () => {
    expect(captureDue([], 90_000, cfg)).toBeUndefined()
    expect(captureDue([], 102_000, cfg)).toBe('baseline')
    expect(captureDue([cap(102_000, 'a')], 190_000, cfg)).toBeUndefined()
    expect(captureDue([cap(102_000, 'a')], 203_000, cfg)).toBe('check')
    expect(captureDue([cap(102_000, 'a'), cap(203_000, 'b')], 290_000, cfg)).toBeUndefined()
    expect(captureDue([cap(102_000, 'a'), cap(203_000, 'b')], 310_000, cfg)).toBe('check')
    expect(captureDue([], 102_000, cfg, 120_000)).toBeUndefined()
    expect(captureDue([], 102_000, configFrom({ topic_check: 'off' }))).toBeUndefined()
    expect(captureDue([], 60_000, configFrom({ topic_at: 50_000 }))).toBe('baseline')
  })

  test('the prompt asks only for a line without a baseline, and for a verdict with one', () => {
    const plain = capturePrompt(['one', 'two', 'three'])
    expect(plain).toContain('1. one')
    expect(plain).not.toContain('same_task')
    const checked = capturePrompt(['one', 'two', 'three'], 'pace mod status line', 'pace README')
    expect(checked).toContain('first measured the work was: "pace mod status line"')
    expect(checked).toContain('At the last check it was: "pace README"')
    expect(checked).toContain('same_task')
  })

  test('the reply parses with or without fences', () => {
    expect(parseCapture('{"now": "pace mod status line"}', false)).toEqual({ now: 'pace mod status line', sameTask: true, why: '' })
    expect(parseCapture('```json\n{"now": "k8s alerts on prod", "same_task": false, "why": "pace mod → k8s alerts"}\n```', true)).toEqual({
      now: 'k8s alerts on prod',
      sameTask: false,
      why: 'pace mod → k8s alerts',
    })
    expect(parseCapture('{"now": "k8s alerts on prod"}', true)).toEqual({ now: 'k8s alerts on prod', sameTask: false, why: '' })
    expect(parseCapture('not json', true)).toBeUndefined()
  })

  test('topic text: the baseline, then started / before / now', () => {
    const a = cap(102_000, 'pace mod status line')
    const b = cap(203_000, 'pace README', false)
    const c = cap(310_000, 'k8s alerts on prod', true)
    expect(textFor('topic', { context: 102_000, turns: 1, captures: [a] })).toBe('working on: pace mod status line (baseline at 102K)')
    expect(textFor('topic', { context: 203_000, turns: 1, captures: [a, { ...b, drifted: true }] })).toBe(
      'work changed at 203K · started: pace mod status line · now: pace README',
    )
    expect(textFor('topic', { context: 310_000, turns: 1, captures: [a, b, c] })).toBe(
      'work changed at 310K · started: pace mod status line · 107K ago: pace README · now: k8s alerts on prod',
    )
  })
})

describe('statusText', () => {
  const cfg = configFrom({})
  const at = (prompt: number, atMs: number) => {
    const track = newTrack()
    track.last = { at: atMs, prompt, read: prompt, write: 0, output: 0, model: 'm', tools: [] }
    return track
  }

  test('nothing before the first request', () => {
    expect(statusText(newTrack(), 0, 0, cfg)).toBeUndefined()
  })

  test('warm and small: context, turns, minutes left', () => {
    expect(statusText(at(182_000, 0), 19 * 60_000, 45, cfg)).toBe('⚠ ctx 182K · 45 turns · cache 41m')
    expect(statusText(at(40_000, 0), 19 * 60_000, 1, cfg)).toBe('ctx 40K · 1 turn · cache 41m')
  })

  test('heavy past high carries the hint', () => {
    expect(statusText(at(312_000, 0), 8 * 60_000, 120, cfg)).toBe('⚠ ctx 312K · 120 turns · cache 52m · ↻ suggestion: start a new session')
  })

  test('expiring counts down and asks to park', () => {
    expect(statusText(at(182_000, 0), 57 * 60_000 + 1, 45, cfg)).toBe('⚠ ctx 182K · 45 turns · ⏳ cache 3m · ↻ park before a break')
  })

  test('colour leads with a dot by cost and state', () => {
    expect(statusText(at(40_000, 0), 19 * 60_000, 1, cfg, 'colour')).toBe('🟢 ctx 40K · 1 turn · cache 41m')
    expect(statusText(at(182_000, 0), 19 * 60_000, 45, cfg, 'colour')).toBe('🟡 ⚠ ctx 182K · 45 turns · cache 41m')
    expect(statusText(at(40_000, 0), 57 * 60_000 + 1, 1, cfg, 'colour')).toBe('🟡 ctx 40K · 1 turn · ⏳ cache 3m · ↻ park before a break')
    expect(statusText(at(312_000, 0), 8 * 60_000, 120, cfg, 'colour')).toBe('🔴 ⚠ ctx 312K · 120 turns · cache 52m · ↻ suggestion: start a new session')
    expect(statusText(at(182_000, 0), 61 * 60_000, 45, cfg, 'colour')).toBe(
      '🔴 ⚠ ctx 182K · 45 turns · ❄ cache cold · 182K re-write · ↻ suggestion: start a new session',
    )
    expect(statusText(at(40_000, 0), 0, 1, cfg, 'off')).toBeUndefined()
  })

  test('the latest work reading rides at the end', () => {
    const work = { context: 102_000, turns: 9, text: 'pace mod status line', drifted: false, why: '' }
    expect(statusText(at(120_000, 0), 60_000, 12, cfg, 'colour', work)).toBe('🟢 ctx 120K · 12 turns · cache 59m · on: pace mod status line')
    expect(statusText(at(220_000, 0), 60_000, 30, cfg, 'plain', { ...work, text: 'k8s alerts on prod', drifted: true })).toBe(
      '⚠ ctx 220K · 30 turns · cache 59m · ⇄ on: k8s alerts on prod',
    )
  })

  test('cold and big names the re-write; cold and small stays quiet', () => {
    expect(statusText(at(310_000, 0), 61 * 60_000, 120, cfg)).toBe(
      '⚠ ctx 310K · 120 turns · ❄ cache cold · 310K re-write · ↻ suggestion: start a new session',
    )
    expect(statusText(at(40_000, 0), 61 * 60_000, 12, cfg)).toBe('ctx 40K · 12 turns · cache cold')
  })
})
