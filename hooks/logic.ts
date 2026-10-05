import type { PaceBand, PaceKind, PaceMetrics, PacePhase, PaceResumePoint, PaceSignal, PaceTarget } from '../types'

export type StatusStyle = 'colour' | 'plain' | 'off'

export type PaceConfig = {
  warn: number
  high: number
  cold_warn: number
  cache_ttl: number
  expiring: number
  hint: string
  big_result: number
  status_line: StatusStyle
}

export const DEFAULTS: PaceConfig = {
  warn: 150_000,
  high: 250_000,
  cold_warn: 100_000,
  cache_ttl: 3600,
  expiring: 300,
  hint: 'suggestion: start a new session',
  big_result: 30_000,
  status_line: 'colour',
}

export function configFrom(options: Readonly<Record<string, unknown>>): PaceConfig {
  const num = (key: string, fallback: number): number => {
    const value = Number(options[key])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  const hint = options.hint
  return {
    warn: num('warn', DEFAULTS.warn),
    high: num('high', DEFAULTS.high),
    cold_warn: num('cold_warn', DEFAULTS.cold_warn),
    cache_ttl: num('cache_ttl_minutes', DEFAULTS.cache_ttl / 60) * 60,
    expiring: num('expiring_minutes', DEFAULTS.expiring / 60) * 60,
    hint: typeof hint === 'string' && hint !== '' ? hint : DEFAULTS.hint,
    big_result: num('big_result', DEFAULTS.big_result),
    status_line: options.status_line === 'off' || options.status_line === 'plain' ? options.status_line : 'colour',
  }
}

export function k(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

export type Step = {
  at: number
  prompt: number
  read: number
  write: number
  output: number
  model: string
  tools: string[]
}

export type CacheState = 'warm' | 'expiring' | 'cold'

export type Track = {
  last?: Step
  warned: boolean
  heavyAt: number
  cache: CacheState
  rewrites: number
}

export type Detected = { kind: PaceKind; phase: PacePhase; metrics: PaceMetrics }

export function newTrack(): Track {
  return { warned: false, heavyAt: 0, cache: 'warm', rewrites: 0 }
}

const REWRITE_FLOOR = 20_000
const HEAVY_UPDATE_STEP = 10_000

export function contextOf(step: Step | undefined): number {
  return step ? step.prompt + step.output : 0
}

export function onStep(track: Track, step: Step, turns: number, cfg: PaceConfig): Detected[] {
  const out: Detected[] = []
  const last = track.last
  const context = contextOf(step)

  if (track.cache !== 'warm') {
    out.push({ kind: track.cache, phase: 'clear', metrics: { context, turns } })
    track.cache = 'warm'
  }

  if (last) {
    const delta = step.prompt - last.prompt - last.output
    if (delta >= cfg.big_result) {
      const tools = last.tools.length > 0 ? last.tools : ['your prompt']
      out.push({ kind: 'jump', phase: 'enter', metrics: { context, turns, delta, tools } })
    }

    const gapMs = step.at - last.at
    const isMiss = last.prompt >= REWRITE_FLOOR && step.read < last.prompt * 0.5 && step.write >= step.prompt * 0.5
    if (isMiss && gapMs < cfg.cache_ttl * 1000) {
      track.rewrites += 1
      const cause = step.model !== last.model ? `model switch ${last.model} → ${step.model}` : 'cause unknown'
      out.push({ kind: 'rewrite', phase: 'enter', metrics: { context, turns, recacheTokens: step.write, cause } })
    }
  }

  if (context >= cfg.warn) {
    if (!track.warned) {
      track.warned = true
      track.heavyAt = context
      out.push({ kind: 'heavy', phase: 'enter', metrics: { context, turns } })
    } else if (context >= cfg.high && Math.abs(context - track.heavyAt) >= HEAVY_UPDATE_STEP) {
      track.heavyAt = context
      out.push({ kind: 'heavy', phase: 'update', metrics: { context, turns } })
    }
  } else if (track.warned) {
    track.warned = false
    track.heavyAt = 0
    out.push({ kind: 'heavy', phase: 'clear', metrics: { context, turns } })
  }

  track.last = step
  return out
}

export function remainingMs(track: Track, now: number, cfg: PaceConfig): number | undefined {
  if (!track.last) return undefined
  return track.last.at + cfg.cache_ttl * 1000 - now
}

export function onTick(track: Track, now: number, turns: number, cfg: PaceConfig): Detected[] {
  const left = remainingMs(track, now, cfg)
  if (left === undefined) return []
  const context = contextOf(track.last)
  const out: Detected[] = []

  if (left > 0 && left <= cfg.expiring * 1000) {
    const metrics = { context, turns, cacheRemainingMs: left, recacheTokens: context }
    out.push({ kind: 'expiring', phase: track.cache === 'expiring' ? 'update' : 'enter', metrics })
    track.cache = 'expiring'
  } else if (left <= 0 && track.cache !== 'cold') {
    if (track.cache === 'expiring') {
      out.push({ kind: 'expiring', phase: 'clear', metrics: { context, turns } })
    }
    track.cache = 'cold'
    if (context >= cfg.cold_warn) {
      out.push({ kind: 'cold', phase: 'enter', metrics: { context, turns, recacheTokens: context } })
    }
  }
  return out
}

export function textFor(kind: PaceKind, m: PaceMetrics): string {
  switch (kind) {
    case 'heavy':
      return `${k(m.context)} context · every turn re-reads it`
    case 'jump':
      return `${(m.tools ?? []).join(', ')} added ${k(m.delta ?? 0)}`
    case 'expiring':
      return `cache ${Math.max(1, Math.ceil((m.cacheRemainingMs ?? 0) / 60_000))}m left · ${k(m.context)} re-writes if it goes cold`
    case 'cold':
      return `cache cold · next prompt re-writes ${k(m.recacheTokens ?? m.context)}`
    case 'rewrite':
      return `cache re-written mid-session (${m.cause ?? 'cause unknown'}) · ${k(m.recacheTokens ?? 0)} at write price`
    case 'topic':
      return m.reminder
        ? `still carrying the old topic · ${k(m.context)} re-read each turn`
        : `new topic at ${k(m.context)}${m.why ? ` (${m.why})` : ''}`
  }
}

export function hintFor(kind: PaceKind, cfg: PaceConfig): string {
  if (kind === 'heavy' || kind === 'cold') return cfg.hint
  if (kind === 'expiring') return 'park before a break'
  if (kind === 'topic') return 'park, then start a new session (/pace-park)'
  return ''
}

const DOT = { green: '🟢', yellow: '🟡', red: '🔴' } as const
type Level = keyof typeof DOT

/**
 * The standing status line: context, turns, cache; the hint only once the session is heavy or a cold cache is big.
 * `colour` leads with a dot by cost: green under `warn`, yellow under `high`, red above, and red once the cache is cold and big.
 * The engine's status line draws no ANSI escapes (each byte shows as U+FFFD), so the dot is the colour.
 */
export function statusText(track: Track, now: number, turns: number, cfg: PaceConfig, style: StatusStyle = 'plain'): string | undefined {
  if (style === 'off') return undefined
  const left = remainingMs(track, now, cfg)
  if (left === undefined) return undefined
  const context = contextOf(track.last)
  let level: Level = context >= cfg.high ? 'red' : context >= cfg.warn ? 'yellow' : 'green'
  const parts = [`${level === 'green' ? '' : '⚠ '}ctx ${k(context)}`, `${turns} turn${turns === 1 ? '' : 's'}`]
  let hint = context >= cfg.high ? cfg.hint : ''
  if (left <= 0) {
    if (context >= cfg.cold_warn) {
      parts.push(`❄ cache cold · ${k(context)} re-write`)
      hint = cfg.hint
      level = 'red'
    } else {
      parts.push('cache cold')
    }
  } else if (left <= cfg.expiring * 1000) {
    parts.push(`⏳ cache ${Math.max(1, Math.ceil(left / 60_000))}m`)
    if (!hint) hint = 'park before a break'
    if (level === 'green') level = 'yellow'
  } else {
    parts.push(`cache ${Math.floor(left / 60_000)}m`)
  }
  if (hint) parts.push(`↻ ${hint}`)
  const line = parts.join(' · ')
  return style === 'colour' ? `${DOT[level]} ${line}` : line
}

export type Message = {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool: string; input: Record<string, unknown> }[]
}

export function lastPrompts(messages: readonly Message[], n: number): string[] {
  return messages
    .filter(m => m.role === 'user' && m.text.trim() !== '' && !m.text.trimStart().startsWith('<'))
    .map(m => clip(m.text.trim().replace(/\s+/g, ' '), 300))
    .slice(-n)
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function filesTouched(messages: readonly Message[], n: number): { edited: string[]; read: string[] } {
  const edited: string[] = []
  const readFiles: string[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path !== 'string') continue
      const list = EDIT_TOOLS.has(use.tool) ? edited : use.tool === 'Read' ? readFiles : undefined
      if (list && !list.includes(path)) list.push(path)
    }
  }
  return { edited: edited.slice(-n), read: readFiles.filter(p => !edited.includes(p)).slice(-n) }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export type NoteFacts = {
  sessionId: string
  cwd: string
  branch?: string
  context: number
  turns: number
  reason: string
  createdMs: number
  prompts: string[]
  edited: string[]
  read: string[]
}

export function noteTitle(facts: NoteFacts, summary?: string): string {
  const first = summary?.split('\n').find(line => line.trim() !== '')
  const base = first ?? facts.prompts.at(-1) ?? 'parked session'
  return clip(base.replace(/^#+\s*/, '').replace(/"/g, "'"), 80)
}

export function noteBody(facts: NoteFacts, summary?: string): string {
  const lines: string[] = []
  if (summary) lines.push('## Summary', '', summary.trim(), '')
  lines.push('## Facts', '')
  lines.push(`- session ${facts.sessionId} · ${k(facts.context)} context · ${facts.turns} turns · parked on ${facts.reason}`)
  lines.push(`- cwd ${facts.cwd}${facts.branch ? ` · branch ${facts.branch}` : ''}`)
  if (facts.edited.length > 0) lines.push(`- edited: ${facts.edited.join(', ')}`)
  if (facts.read.length > 0) lines.push(`- read: ${facts.read.join(', ')}`)
  if (facts.prompts.length > 0) {
    lines.push('', '## Last prompts', '')
    for (const p of facts.prompts) lines.push(`- ${p}`)
  }
  return lines.join('\n') + '\n'
}

export function noteFile(facts: NoteFacts, summary?: string): string {
  const created = new Date(facts.createdMs).toISOString()
  return [
    '---',
    'pace_resume: true',
    `title: "${noteTitle(facts, summary)}"`,
    `cwd: ${facts.cwd}`,
    `session: ${facts.sessionId}`,
    `created: ${created}`,
    `context: ${facts.context}`,
    '---',
    '',
    noteBody(facts, summary),
  ].join('\n')
}

export function noteName(createdMs: number, sessionId: string): string {
  const iso = new Date(createdMs).toISOString()
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `${stamp}-${sessionId.slice(0, 8)}.md`
}

export function splitNote(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^"(.*)"$/, '$1')
  }
  return { meta, body: text.slice(match[0].length) }
}

export function parsePoint(path: string, text: string): PaceResumePoint | undefined {
  const { meta } = splitNote(text)
  if (meta.pace_resume !== 'true') return undefined
  const createdMs = Date.parse(meta.created ?? '')
  return {
    path,
    title: meta.title ?? path,
    cwd: meta.cwd ?? '',
    createdMs: Number.isNaN(createdMs) ? 0 : createdMs,
    context: Number(meta.context ?? 0) || 0,
  }
}

export function resumeMarker(path: string): string {
  return `Resuming from pace resume point ${path.split('/').at(-1) ?? path}.`
}

export function resumeText(path: string, text: string): string {
  return `${resumeMarker(path)}\n\n${splitNote(text).body.trim()}\n`
}

export const OLD_MS = 7 * 24 * 3600 * 1000

export function age(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export const SUMMARY_PROMPT = [
  'Write a resume note for picking this session up in a fresh one.',
  'First line: a title of at most 10 words, no heading marks.',
  'Then four short sections in markdown: Goal, Done, Next step, Open questions.',
  'Plain facts only, at most 15 lines in total, name files and commands exactly.',
].join(' ')

const BAND_KINDS = ['heavy', 'expiring', 'cold', 'topic'] as const
export type PaceBandKind = (typeof BAND_KINDS)[number]

export function isBandKind(kind: PaceKind): kind is PaceBandKind {
  return (BAND_KINDS as readonly string[]).includes(kind)
}

export function withSignal(current: PaceBand, s: PaceSignal, high: number): PaceBand {
  if (!isBandKind(s.kind)) return current
  const next: PaceBand = { ...current }
  const shows = s.phase !== 'clear' && (s.kind !== 'heavy' || s.metrics.context >= high)
  if (shows) next[s.kind] = s
  else delete next[s.kind]
  return next
}

export function toastText(s: PaceSignal): string {
  return `pace: ${s.text}${s.hint ? ` · ${s.hint}` : ''}`
}

export const OWN_TARGETS = ['note', 'append']

export function targetList(lastFile: string | undefined): PaceTarget[] {
  const list: PaceTarget[] = [{ id: 'note', label: 'new resume point' }]
  if (lastFile) list.push({ id: 'append', label: `append to ${lastFile.split('/').at(-1)}` })
  return list
}

export function resolveDir(configured: unknown, home: string): string {
  const dir = typeof configured === 'string' && configured !== '' ? configured : `${home}/.local/state/pace/parked`
  return dir.startsWith('~/') ? `${home}${dir.slice(1)}` : dir
}

export function appendNote(existing: string, facts: NoteFacts, summary?: string): string {
  const stamp = new Date(facts.createdMs).toISOString().slice(0, 16).replace('T', ' ')
  return `${existing.trimEnd()}\n\n## Parked again ${stamp}\n\n${noteBody(facts, summary)}`
}

export const TOPIC_MODEL = 'claude-haiku-4-5-20251001'
export const TOPIC_REMIND_AT = [1, 3]

export function isSubstantive(text: string): boolean {
  const t = text.trim()
  if (t.startsWith('/') || t.startsWith('Resuming from pace resume point')) return false
  return t.split(/\s+/).filter(Boolean).length >= 6
}

export function shouldCheckTopic(text: string, prior: string[], context: number, cfg: PaceConfig, mode: unknown, blocked: boolean): boolean {
  return mode !== 'off' && !blocked && context >= cfg.warn && isSubstantive(text) && prior.length >= 3
}

export function topicPrompt(prior: string[], next: string): string {
  const earlier = prior.map((p, i) => `${i + 1}. ${p}`).join('\n')
  return [
    'Earlier requests in a coding session:',
    earlier,
    '',
    `New request: ${clip(next.trim().replace(/\s+/g, ' '), 600)}`,
    '',
    'Is the new request part of the same task as the earlier ones, or a different task?',
    'A follow-up, a fix, a test or a next step of the same work is the same task.',
    'Reply with JSON only: {"same_task": true|false, "why": "<at most 8 words naming old → new topic>"}',
  ].join('\n')
}

export function parseTopic(text: string): { sameTask: boolean; why: string } | undefined {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return undefined
  try {
    const raw = JSON.parse(match[0]) as { same_task?: unknown; why?: unknown }
    if (typeof raw.same_task !== 'boolean') return undefined
    return { sameTask: raw.same_task, why: typeof raw.why === 'string' ? clip(raw.why, 60) : '' }
  } catch {
    return undefined
  }
}
