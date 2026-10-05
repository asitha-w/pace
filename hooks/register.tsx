import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Pace, PaceKind, PaceNow, PaceParkDraft, PaceResumePoint, PaceSignal } from '../types'
import {
  OLD_MS,
  TOPIC_MODEL,
  TOPIC_REMIND_AT,
  OWN_TARGETS,
  SUMMARY_PROMPT,
  age,
  appendNote,
  configFrom,
  contextOf,
  filesTouched,
  hintFor,
  isBandKind,
  k,
  lastPrompts,
  newTrack,
  noteFile,
  noteName,
  onStep,
  onTick,
  parsePoint,
  parseTopic,
  remainingMs,
  resolveDir,
  resumeMarker,
  resumeText,
  shouldCheckTopic,
  statusText,
  targetList,
  textFor,
  toastText,
  topicPrompt,
  withSignal,
} from './logic'
import type { Detected, Message, PaceConfig, Track } from './logic'

const BAND = { plugin: 'pace', key: 'band' } as const
const DISMISSED = { plugin: 'pace', key: 'dismissed' } as const
const RESUME = { plugin: 'pace', key: 'resume' } as const
const DRAFT = { plugin: 'pace', key: 'draft' } as const
const NOW = { plugin: 'pace', key: 'now' } as const

const band = atom(BAND, {})
const dismissed = atom(DISMISSED, [])
const resume = atom(RESUME, [])
const draft = atom(DRAFT, null)
const nowState = atom(NOW, null)

const HELP = [
  'status line: ctx (context size) · turns · cache (minutes left, or cold); green under warn, yellow under high, red above;',
  '  ⚠ past the heavy level, ❄ cold and big, ⏳ about to expire',
  'commands: /pace-now figures · /pace-park write a resume point · /pace-resume list resume points ·',
  '  /pace-dismiss hide the alert row · /pace-close close the panes · /pace-help this',
  'keys: Ctrl+X then Tab focuses the alert row and panes · Tab/arrows move · Enter or the digit presses ·',
  '  Esc back to the prompt · Ctrl+X then X closes a pane',
  'signals: heavy (big context) · jump (one step added a lot) · expiring (cache about to go cold) ·',
  '  cold (next prompt re-writes the context) · rewrite (cache rebuilt mid-session) · topic (new task in a big session)',
  'turn off: /plugin configure pace (or /config) → "New topic check" = off stops the Haiku check;',
  '  "Status line" = plain drops the colour, off hides the line; the thresholds are there too; /plugin disable pace turns the whole mod off',
].join('\n')

const NOW_PANE = 'pace-now'
const PARK_PANE = 'pace-park'
const RESUME_PANE = 'pace-resume'
const TICK_MS = 15_000
const BAND_ORDER: PaceKind[] = ['cold', 'expiring', 'topic', 'heavy']
const ICON: Record<PaceKind, string> = { heavy: '⚠', jump: '↑', expiring: '⏳', cold: '❄', rewrite: '↻', topic: '⇄' }

let cfg: PaceConfig = configFrom({})
let opts: PluginOptions = {}
let track: Track = newTrack()
let isTurn = false
let pending: { path: string; marker: string } | undefined
let ticker: { cancel: () => void } | undefined
let topic: { turnsSince: number; why: string } | undefined
let topicBlocked = false

async function emit($: EngineInterface, d: Detected) {
  await $.pace.signal({
    kind: d.kind,
    phase: d.phase,
    sessionId: await $.session.id(),
    metrics: d.metrics,
    text: textFor(d.kind, d.metrics),
    hint: hintFor(d.kind, cfg),
  })
}

async function refreshStatus($: EngineInterface) {
  $.ui.status(statusText(track, await $.clock.now(), await $.session.turns(), cfg, cfg.status_line))
}

async function scanResume($: EngineInterface) {
  const dir = resolveDir(opts.park_dir, (await $.env.get('HOME')) ?? '')
  const cwd = await $.session.cwd()
  const points: PaceResumePoint[] = []
  const entries = await $.fs.list(dir).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
    const path = `${dir}/${entry.name}`
    const text = await $.fs.read(path).catch(() => '')
    const point = parsePoint(path, text)
    if (point && (opts.resume_scope === 'everywhere' || point.cwd === cwd)) points.push(point)
  }
  points.sort((a, b) => b.createdMs - a.createdMs)
  await update($, resume, () => points)
}

async function removePoints($: EngineInterface, paths: string[]) {
  if (paths.length === 0) return
  await $.process.run(['rm', '-f', '--', ...paths])
  await update($, resume, list => list.filter(p => !paths.includes(p.path)))
}

async function openPark($: EngineInterface, reason: string) {
  const targets = await $.pace.targets()
  const left = remainingMs(track, await $.clock.now(), cfg)
  const isWarm = left !== undefined && left > 0
  const value: PaceParkDraft = {
    reason,
    targets,
    target: targets[0]?.id ?? 'note',
    summary: opts.summary === 'always' || (opts.summary !== 'never' && isWarm),
    isWarm,
  }
  await update($, draft, () => value)
  await $.ui.open({ id: PARK_PANE, title: 'pace · park', focus: true, closeOnEscape: true, rows: 9 })
}

async function doPark($: EngineInterface) {
  const d = await read($, draft)
  if (!d) return
  await $.ui.close({ id: PARK_PANE })
  $.ui.toast(d.summary ? 'pace: parking, writing the summary…' : 'pace: parking…')
  const parked = await $.pace.park({ target: d.target, reason: d.reason, summary: d.summary })
  await update($, draft, () => null)
  if (parked.location) await closeTopic($, false)
  $.ui.toast(parked.location ? `pace: parked → ${parked.location}` : `pace: nothing handled target ${d.target}`, {
    timeoutMs: 8000,
  })
}

async function doResume($: EngineInterface, point: PaceResumePoint) {
  const text = await $.fs.read(point.path).catch(() => undefined)
  if (text === undefined) {
    await update($, resume, list => list.filter(p => p.path !== point.path))
    $.ui.toast('pace: that resume point is gone')
    return
  }
  await $.prompt.fill({ text: resumeText(point.path, text), mode: 'replace' })
  pending = { path: point.path, marker: resumeMarker(point.path) }
  $.ui.toast('pace: resume point is in the prompt box; send it to resume (the file is then removed), clear it to keep it', {
    timeoutMs: 8000,
  })
}

async function checkTopic($: EngineInterface, text: string) {
  const context = contextOf(track.last)
  const messages = (await $.session.messages()) as unknown as Message[]
  const clipped = text.trim().replace(/\s+/g, ' ')
  const prior = lastPrompts(messages, 6).filter(p => !clipped.startsWith(p.replace(/…$/, ''))).slice(-5)
  if (!shouldCheckTopic(text, prior, context, cfg, opts.topic_check, topic !== undefined || topicBlocked)) return
  const answer = await $.model.complete({ model: TOPIC_MODEL, prompt: topicPrompt(prior, text), maxTokens: 120 })
  const verdict = answer.isAnswered ? parseTopic(answer.text) : undefined
  if (!verdict || verdict.sameTask || topic !== undefined) return
  topic = { turnsSince: 0, why: verdict.why }
  await emit($, { kind: 'topic', phase: 'enter', metrics: { context, turns: await $.session.turns(), why: verdict.why } })
}

async function closeTopic($: EngineInterface, blocked: boolean) {
  topicBlocked = blocked
  if (!topic) return
  topic = undefined
  await emit($, { kind: 'topic', phase: 'clear', metrics: { context: contextOf(track.last), turns: 0 } })
}

export const register: Register = (on, options) => {
  cfg = configFrom(options)
  opts = options
  track = newTrack()

  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    const pace: Pace = {
      signal: async (s: PaceSignal) => {
        if (isBandKind(s.kind)) {
          const current = await built.state.get(BAND)
          await built.state.set(BAND, withSignal(current.value ?? {}, s, cfg.high))
          if (s.phase === 'clear') {
            const hidden = await built.state.get(DISMISSED)
            await built.state.set(DISMISSED, (hidden.value ?? []).filter(kind => kind !== s.kind))
          }
        }
        const isTopic = s.kind === 'topic'
        if ((s.phase === 'enter' && s.kind !== 'cold') || (isTopic && s.phase === 'update')) {
          built.ui.toast(toastText(s), { timeoutMs: isTopic ? 10_000 : 6000 })
        }
        return true
      },
      targets: async () => {
        const last = await built.store.get('lastFile')
        const hasLast = typeof last === 'string' && (await built.fs.exists(last))
        return targetList(hasLast ? (last as string) : undefined)
      },
      park: async request => {
        if (!OWN_TARGETS.includes(request.target)) return { location: '' }
        const messages = (await built.session.messages()) as unknown as Message[]
        const touched = filesTouched(messages, 15)
        const git = await built.process
          .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
          .catch(() => undefined)
        const usage = await built.session.usage()
        const facts = {
          sessionId: await built.session.id(),
          cwd: await built.session.cwd(),
          branch: git && git.exitCode === 0 ? git.stdout.trim() : undefined,
          context: usage.context.tokens ?? contextOf(track.last),
          turns: await built.session.turns(),
          reason: request.reason,
          createdMs: await built.clock.now(),
          prompts: lastPrompts(messages, 5),
          edited: touched.edited,
          read: touched.read,
        }
        const answer = request.summary ? await built.model.fork({ prompt: SUMMARY_PROMPT }) : undefined
        const summary = answer && answer.isAnswered ? answer.text : undefined
        const last = await built.store.get('lastFile')
        if (request.target === 'append' && typeof last === 'string') {
          const existing = await built.fs.read(last)
          await built.fs.write(last, appendNote(existing, facts, summary))
          return { location: last }
        }
        const dir = resolveDir(options.park_dir, (await built.env.get('HOME')) ?? '')
        const path = `${dir}/${noteName(facts.createdMs, facts.sessionId)}`
        await built.fs.write(path, noteFile(facts, summary))
        await built.store.set('lastFile', path)
        return { location: path }
      },
      now: async () => {
        const usage = await built.session.usage()
        const bandNow = await built.state.get(BAND)
        const shown = bandNow.value ?? {}
        const value: PaceNow = {
          sessionId: await built.session.id(),
          context: usage.context.tokens ?? contextOf(track.last),
          window: usage.context.window,
          percent: usage.context.percent,
          turns: await built.session.turns(),
          cacheRemainingMs: remainingMs(track, await built.clock.now(), cfg),
          lastRead: track.last?.read ?? 0,
          lastWrite: track.last?.write ?? 0,
          rewrites: track.rewrites,
          rateLimits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
          costUsd: usage.cost?.usd,
          active: BAND_ORDER.filter(kind => isBandKind(kind) && shown[kind] !== undefined),
        }
        await built.state.set(NOW, value)
        return value
      },
    }
    return { ...{ pace }, ...built }
  })

  on('session.start', async ($, e, next) => {
    for (const [name, description] of [
      ['pace-now', 'pace: context, cache, limits and cost of this session'],
      ['pace-park', 'pace: write a resume point for this session'],
      ['pace-resume', 'pace: list resume points'],
      ['pace-dismiss', 'pace: hide the alert row until it clears'],
      ['pace-close', 'pace: close the pace panes'],
      ['pace-help', 'pace: commands, keys and how to turn signals off'],
    ] as const) {
      await $.command.register({ name, description, immediate: true })
    }
    await scanResume($)
    await refreshStatus($)
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      void (async () => {
        if (!isTurn) {
          const detected = onTick(track, await $.clock.now(), await $.session.turns(), cfg)
          for (const d of detected) await emit($, d)
        }
        await refreshStatus($)
      })().catch(() => undefined)
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    isTurn = true
    if (pending && e.text.includes(pending.marker)) {
      const path = pending.path
      pending = undefined
      await removePoints($, [path])
    }
    if (e.origin.kind === 'composer') void checkTopic($, e.text).catch(() => undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const u = result.usage
      const step = {
        at: await $.clock.now(),
        prompt: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        read: u.cache_read_input_tokens,
        write: u.cache_creation_input_tokens,
        output: u.output_tokens,
        model: u.model,
        tools: result.toolUses.map(use => use.tool),
      }
      const detected = onStep(track, step, await $.session.turns(), cfg)
      if (contextOf(step) < cfg.warn) topicBlocked = false
      void (async () => {
        for (const d of detected) await emit($, d)
        await refreshStatus($)
      })().catch(() => undefined)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurn = false
      if (topic) {
        topic.turnsSince += 1
        const reminder = TOPIC_REMIND_AT.indexOf(topic.turnsSince) + 1
        if (reminder > 0) {
          const metrics = { context: contextOf(track.last), turns: await $.session.turns(), why: topic.why, reminder }
          void emit($, { kind: 'topic', phase: 'update', metrics }).catch(() => undefined)
        }
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      for (const kind of BAND_ORDER) await emit($, { kind, phase: 'clear', metrics: { context: 0, turns: 0 } })
      track = newTrack()
      isTurn = false
      topic = undefined
      topicBlocked = false
      $.ui.status(undefined)
      await scanResume($)
    }
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await scanResume($)
    return next(e)
  })

  on('command.run', { command: 'pace-now' }, async $ => {
    await $.pace.now()
    await $.ui.open({ id: NOW_PANE, title: 'pace', focus: true, closeOnEscape: true })
    return { text: 'figures opened in a pane.' }
  })

  on('command.run', { command: 'pace-park' }, async $ => {
    await openPark($, 'request')
    return { text: 'choose where to park.' }
  })

  on('command.run', { command: 'pace-help' }, async () => ({ text: HELP }))

  on('command.run', { command: 'pace-close' }, async $ => {
    for (const id of [NOW_PANE, PARK_PANE, RESUME_PANE]) await $.ui.close({ id })
    return { text: 'panes closed.' }
  })

  on('command.run', { command: 'pace-dismiss' }, async $ => {
    const shown = await read($, band)
    const kinds = BAND_ORDER.filter(kind => isBandKind(kind) && shown[kind] !== undefined)
    if (kinds.length === 0) return { text: 'no alert row to hide.' }
    if (kinds.includes('topic')) await closeTopic($, true)
    await update($, dismissed, list => [...new Set([...list, ...kinds.filter(kind => kind !== 'topic')])])
    return { text: `hid ${kinds.join(', ')} until it clears.` }
  })

  on('command.run', { command: 'pace-resume' }, async $ => {
    await scanResume($)
    const count = (await read($, resume)).length
    if (count === 0) return { text: 'no resume points here.' }
    await $.ui.open({ id: RESUME_PANE, title: 'pace · resume points', focus: true, closeOnEscape: true })
    return { text: `${count} resume point${count === 1 ? '' : 's'}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const b = await read($, band)
    const hidden = await read($, dismissed)
    const points = await read($, resume)
    const now = await $.clock.now()
    const kind = BAND_ORDER.find(one => isBandKind(one) && b[one] !== undefined && !hidden.includes(one))
    const fresh = points.filter(p => now - p.createdMs < OLD_MS)
    const old = points.length - fresh.length
    if (!kind && points.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const s = kind && isBandKind(kind) ? b[kind] : undefined
    const beneath = await next(e)

    return (
      <Box flexDirection="column">
        {s && kind && (
          <Box key="signal" flexDirection="row" gap={1}>
            <Text color={kind === 'cold' ? 'red' : 'yellow'} wrap="truncate">
              {`${ICON[kind]} pace ${s.text}${s.hint ? ` · ${s.hint}` : ''}`}
            </Text>
            <Button key="park" label="1 park" hotkey="1" onPress={() => void openPark($, kind)} />
            <Button key="dismiss" label="2 dismiss" hotkey="2" onPress={() => void (kind === 'topic' ? closeTopic($, true) : update($, dismissed, l => [...l, kind]))} />
          </Box>
        )}
        {fresh[0] && (
          <Box key="resume" flexDirection="row" gap={1}>
            <Text dimColor wrap="truncate">
              {`pace: resume point ${age(now - fresh[0].createdMs)} · ${fresh[0].title} · ${k(fresh[0].context)}`}
            </Text>
            <Button key="resume-go" label="3 resume" hotkey="3" onPress={() => void doResume($, fresh[0])} />
            <Button key="resume-drop" label="4 discard" hotkey="4" onPress={() => void removePoints($, [fresh[0].path])} />
            {points.length > 1 && (
              <Button
                key="resume-list"
                label={`5 all ${points.length}`}
                hotkey="5"
                onPress={() => void $.ui.open({ id: RESUME_PANE, title: 'pace · resume points', focus: true, closeOnEscape: true })}
              />
            )}
          </Box>
        )}
        {old > 0 && (
          <Box key="old" flexDirection="row" gap={1}>
            <Text dimColor>{`pace: ${old} resume point${old === 1 ? '' : 's'} older than 7 days`}</Text>
            <Button
              key="old-clear"
              label="6 clear"
              hotkey="6"
              onPress={() => void removePoints($, points.filter(p => now - p.createdMs >= OLD_MS).map(p => p.path))}
            />
          </Box>
        )}
        {beneath}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: NOW_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const n = await read($, nowState)
    if (!n) return <Text dimColor>pace: no figures yet.</Text>
    const left = n.cacheRemainingMs
    const cache = left === undefined ? 'no request yet' : left > 0 ? `${Math.ceil(left / 60_000)}m left` : 'cold'
    const rows: [string, string][] = [
      ['context', `${k(n.context)} of ${k(n.window)}${n.percent !== undefined ? ` (${Math.round(n.percent)}%)` : ''}`],
      ['turns', String(n.turns)],
      ['cache', cache],
      ['last request', `read ${k(n.lastRead)} · wrote ${k(n.lastWrite)}`],
      ['re-writes', String(n.rewrites)],
      ...n.rateLimits.map(
        r => [r.kind, `${Math.round(r.percentUsed)}%${r.resetsAt ? ` · resets ${r.resetsAt}` : ''}`] as [string, string],
      ),
      ['cost', n.costUsd !== undefined ? `$${n.costUsd.toFixed(2)}` : '—'],
      ['signals', n.active.length > 0 ? n.active.join(', ') : 'none'],
    ]
    return (
      <Box flexDirection="column">
        <Button key="close" label="close" role="dismiss" onPress={() => void $.ui.close({ id: NOW_PANE })} />
        {rows.map(([label, value]) => (
          <Box key={label} flexDirection="row">
            <Text dimColor>{label.padEnd(14)}</Text>
            <Text>{value}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PARK_PANE }, async ($, e) => {
    const { Box, Button, Select, Text } = $.ui.resolve(e)
    const d = await read($, draft)
    if (!d) return <Text dimColor>pace: nothing to park.</Text>
    return (
      <Box flexDirection="column" gap={1}>
        <Select
          key="target"
          label="Park to"
          autoFocus
          value={d.target}
          options={d.targets.map(t => ({ value: t.id, label: t.label }))}
          onSelect={value => void update($, draft, cur => (cur ? { ...cur, target: value } : cur))}
        />
        <Box flexDirection="row" gap={1}>
          <Button
            key="summary"
            label={`summary: ${d.summary ? 'on' : 'off'}`}
            hotkey="s"
            onPress={() => void update($, draft, cur => (cur ? { ...cur, summary: !cur.summary } : cur))}
          />
          <Text dimColor>{d.isWarm ? 'cache warm: cheap' : 'cache cold: costs a full re-write'}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="go" label="park" hotkey="k" variant="primary" onPress={() => void doPark($)} />
          <Button key="cancel" label="cancel" role="dismiss" onPress={() => void $.ui.close({ id: PARK_PANE })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: RESUME_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const points = await read($, resume)
    const now = await $.clock.now()
    if (points.length === 0) return <Text dimColor>pace: no resume points.</Text>
    return (
      <Box flexDirection="column">
        {points.map((p, i) => (
          <Box key={`p${i}`} flexDirection="row" gap={1}>
            <Text dimColor={now - p.createdMs >= OLD_MS} wrap="truncate">
              {`${age(now - p.createdMs).padEnd(8)} ${k(p.context).padStart(5)} ${p.title}`}
            </Text>
            <Button
              key={`go${i}`}
              label="resume"
              onPress={() => {
                void $.ui.close({ id: RESUME_PANE })
                void doResume($, p)
              }}
            />
            <Button key={`drop${i}`} label="discard" onPress={() => void removePoints($, [p.path])} />
          </Box>
        ))}
      </Box>
    )
  })
}
