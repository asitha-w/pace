export type PaceKind = 'heavy' | 'jump' | 'expiring' | 'cold' | 'rewrite' | 'topic'

export type PacePhase = 'enter' | 'update' | 'clear'

export type PaceMetrics = {
  context: number
  turns: number
  cacheRemainingMs?: number
  recacheTokens?: number
  delta?: number
  tools?: string[]
  cause?: string
  why?: string
  captures?: PaceCapture[]
}

/** One reading of what the work is: taken at `context`, as a short line; `drifted` when it is not the baseline's task. */
export type PaceCapture = {
  context: number
  turns: number
  text: string
  drifted: boolean
  why: string
}

export type PaceSignal = {
  kind: PaceKind
  phase: PacePhase
  sessionId: string
  metrics: PaceMetrics
  text: string
  hint: string
}

export type PaceTarget = { id: string; label: string }

export type PaceParkRequest = { target: string; reason: string; summary: boolean }

export type PaceParked = { location: string }

export type PaceRateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type PaceNow = {
  sessionId: string
  context: number
  window: number
  percent?: number
  turns: number
  cacheRemainingMs?: number
  lastRead: number
  lastWrite: number
  rewrites: number
  rateLimits: PaceRateLimit[]
  costUsd?: number
  active: PaceKind[]
  captures: PaceCapture[]
}

export type PaceResumePoint = {
  path: string
  title: string
  cwd: string
  createdMs: number
  context: number
}

export type PaceParkDraft = {
  reason: string
  targets: PaceTarget[]
  target: string
  summary: boolean
  isWarm: boolean
}

export type PaceBand = { heavy?: PaceSignal; expiring?: PaceSignal; cold?: PaceSignal }

export type Pace = {
  signal: (signal: PaceSignal) => Promise<boolean>
  targets: () => Promise<PaceTarget[]>
  park: (request: PaceParkRequest) => Promise<PaceParked>
  now: () => Promise<PaceNow>
}

declare module 'claude-code' {
  interface EngineInterface {
    pace: Pace
  }
  interface PluginState {
    pace: {
      band: PaceBand
      dismissed: PaceKind[]
      resume: PaceResumePoint[]
      draft: PaceParkDraft | null
      now: PaceNow | null
    }
  }
}
