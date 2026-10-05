import { expect, mock, test } from 'claude-code/testing'
import type { On, Register } from 'claude-code'

const driver: Register = on => {
  on('command.run', { command: 'drive-signal' }, async $ => {
    await $.pace.signal({
      kind: 'heavy',
      phase: 'enter',
      sessionId: 's1',
      metrics: { context: 262_000, turns: 88 },
      text: '262K context · every turn re-reads it',
      hint: 'suggestion: start a new session',
    })
    return { text: 'signalled' }
  })
  on('command.run', { command: 'drive-targets' }, async $ => {
    const targets = await $.pace.targets()
    return { text: targets.map(t => t.id).join(',') }
  })
}

const watch: Register = on => {
  on('pace.signal', async ($, e, next) => {
    const result = await next(e)
    $.ui.toast(`observed ${e.kind}:${e.phase}`)
    return result
  })
}

const silence: Register = on => {
  on('pace.signal', () => ({ value: false }))
}

const tracker: Register = on => {
  on('pace.targets', async ($, e, next) => {
    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) return result
    return { value: [...result.value, { id: 'tracker:item-1', label: 'tracker: item 1' }] }
  })
}

const DRIVER = { name: 'pace-driver', register: driver }

async function run($: { command: { run: (e: never) => Promise<unknown> } }, command: string): Promise<string> {
  const result = (await $.command.run({ command, args: '', origin: { kind: 'user' }, presentation: {} } as never)) as {
    text?: string
  }
  return result.text ?? ''
}

function quiet(on: On, toasts: string[]): void {
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="beneath" />
  })
}

test('pace.signal: default shows a toast and a band row', { plugins: [DRIVER] }, async ($, on) => {
  const toasts: string[] = []
  quiet(on, toasts)
  expect(await run($, 'drive-signal')).toBe('signalled')
  expect(toasts).toEqual(['pace: 262K context · every turn re-reads it · suggestion: start a new session'])
})

test(
  'an extension observes pace.signal and pace still shows it',
  { plugins: [DRIVER, { name: 'pace-watch', register: watch }] },
  async ($, on) => {
    const toasts: string[] = []
    quiet(on, toasts)
    await run($, 'drive-signal')
    expect(toasts).toContain('observed heavy:enter')
    expect(toasts).toContain('pace: 262K context · every turn re-reads it · suggestion: start a new session')
  },
)

test(
  'an extension that answers replaces the display',
  { plugins: [DRIVER, { name: 'pace-silence', register: silence }] },
  async ($, on) => {
    const toasts: string[] = []
    quiet(on, toasts)
    await run($, 'drive-signal')
    expect(toasts).toEqual([])
  },
)

test('an extension adds a park target', { plugins: [DRIVER, { name: 'pace-tracker', register: tracker }] }, async ($, on) => {
  mock.store(on)
  expect(await run($, 'drive-targets')).toBe('note,tracker:item-1')
})

test('the band draws the signal row, and dismiss hides it', { plugins: [DRIVER] }, async ($, on) => {
  const toasts: string[] = []
  quiet(on, toasts)
  mock.clock(on, { now: 1_000_000 })
  await run($, 'drive-signal')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'pace',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    })
    expect(await ui.find({ type: 'Text', text: /262K context/ })).toBeDefined()
    expect(await ui.find({ key: 'park' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({
    plugin: 'pace',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
  })
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /262K context/ })).toBeUndefined()
  await ui.unmount()
})

test('the band stays out of the way while a turn runs', { plugins: [DRIVER] }, async ($, on) => {
  quiet(on, [])
  mock.clock(on, { now: 1_000_000 })
  await run($, 'drive-signal')
  const ui = await $.ui.mount({
    plugin: 'pace',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 },
  })
  expect(await ui.find({ type: 'Text', text: /262K context/ })).toBeUndefined()
  await ui.unmount()
})

function answerStep(on: On, usages: { read: number; write: number; tools: string[] }[]): void {
  let i = 0
  on('turn.step', async function* ($, e) {
    const u = usages[Math.min(i, usages.length - 1)]
    i += 1
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: u.tools.map((tool, n) => ({ id: `t${n}`, tool, input: {} })),
      stopReason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 500, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, model: 'm' },
    } as never
  })
  on('session.turns', () => ({ value: 3 }))
  on('session.id', () => ({ value: 'session-1' }))
}

async function step($: { turn: { step: (e: never) => AsyncGenerator<unknown, unknown> & { result: Promise<unknown> } } }, index: number) {
  const stream = $.turn.step({ turnId: 'turn-1', index, model: 'm', messageCount: index + 1 } as never)
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

test('a big tool result between two requests is a jump toast', async ($, on) => {
  const toasts: string[] = []
  quiet(on, toasts)
  const clock = mock.clock(on, { now: 1_000_000 })
  answerStep(on, [
    { read: 40_000, write: 1_000, tools: ['Read'] },
    { read: 41_000, write: 45_000, tools: [] },
  ])
  await step($, 0)
  await step($, 1)
  await clock.advance(0)
  expect(toasts).toContain('pace: Read added 45K')
})

test('a new topic in a heavy session toasts, then reminds twice', async ($, on) => {
  const toasts: string[] = []
  quiet(on, toasts)
  const clock = mock.clock(on, { now: 1_000_000 })
  answerStep(on, [{ read: 200_000, write: 1_000, tools: [] }])
  const said = (text: string) => ({ role: 'user', text, toolUses: [] })
  on('session.messages', () => ({
    value: [
      said('build the pace mod signals and band'),
      said('add park and resume to the pace mod'),
      said('write tests for the pace mod topic check'),
    ],
  }))
  let asked = ''
  on('model.complete', ($, e) => {
    asked = e.model
    return { value: { isAnswered: true, text: '{"same_task": false, "why": "pace mod → k8s alerts"}', usage: {} } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  await step($, 0)
  await $.prompt.submit({ text: 'now lets look at why the k8s alerts fire on prod', wait: false, origin: { kind: 'composer' } } as never)
  await clock.advance(0)
  expect(asked).toBe('claude-haiku-4-5-20251001')
  expect(toasts).toContain('pace: new topic at 202K (pace mod → k8s alerts) · park, then start a new session (/pace-park)')
  for (let i = 0; i < 4; i++) {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `t${i}`, reason: 'answer' } as never)
    await clock.advance(0)
  }
  const reminders = toasts.filter(t => t.startsWith('pace: still carrying the old topic'))
  expect(reminders.length).toBe(2)
})

test('topic_check off never calls the model', { options: { topic_check: 'off' } }, async ($, on) => {
  quiet(on, [])
  mock.clock(on, { now: 1_000_000 })
  answerStep(on, [{ read: 200_000, write: 1_000, tools: [] }])
  const said = (text: string) => ({ role: 'user', text, toolUses: [] })
  on('session.messages', () => ({ value: [said('one two three four five six'), said('one two three four five six'), said('one two three four five six')] }))
  let calls = 0
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: '{"same_task": false}', usage: {} } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  await step($, 0)
  await $.prompt.submit({ text: 'now lets look at why the k8s alerts fire on prod', wait: false, origin: { kind: 'composer' } } as never)
  expect(calls).toBe(0)
})

function watchStatus(on: On, lines: (string | undefined)[]): void {
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
}

test('the status line follows each request and the clock', { options: { status_line: 'plain' } }, async ($, on) => {
  const lines: (string | undefined)[] = []
  quiet(on, [])
  watchStatus(on, lines)
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/nowhere' })
  on('session.cwd', () => ({ value: '/work' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  answerStep(on, [{ read: 180_000, write: 2_000, tools: [] }])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
  await step($, 0)
  await clock.advance(0)
  expect(lines.at(-1)).toBe('⚠ ctx 183K · 3 turns · cache 60m')
  await clock.advance(56 * 60_000)
  expect(lines.at(-1)).toBe('⚠ ctx 183K · 3 turns · ⏳ cache 4m · ↻ park before a break')
  await clock.advance(5 * 60_000)
  expect(lines.at(-1)).toBe('⚠ ctx 183K · 3 turns · ❄ cache cold · 183K re-write · ↻ suggestion: start a new session')
})

test('/clear drops the status line', { options: { status_line: 'plain' } }, async ($, on) => {
  const lines: (string | undefined)[] = []
  quiet(on, [])
  watchStatus(on, lines)
  const clock = mock.clock(on, { now: 1_000_000 })
  answerStep(on, [{ read: 50_000, write: 1_000, tools: [] }])
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  await step($, 0)
  await clock.advance(0)
  expect(lines.at(-1)).toBe('ctx 52K · 3 turns · cache 60m')
  await $.session.end({ reason: 'clear', sessionId: 'session-1' } as never)
  expect(lines.at(-1)).toBeUndefined()
})

test('status_line off never pins a line', { options: { status_line: 'off' } }, async ($, on) => {
  const lines: (string | undefined)[] = []
  quiet(on, [])
  watchStatus(on, lines)
  const clock = mock.clock(on, { now: 1_000_000 })
  answerStep(on, [{ read: 180_000, write: 2_000, tools: [] }])
  await step($, 0)
  await clock.advance(0)
  expect(lines.filter(l => l !== undefined)).toEqual([])
})

test('the status line is coloured by default', async ($, on) => {
  const lines: (string | undefined)[] = []
  quiet(on, [])
  watchStatus(on, lines)
  const clock = mock.clock(on, { now: 1_000_000 })
  answerStep(on, [{ read: 50_000, write: 1_000, tools: [] }])
  await step($, 0)
  await clock.advance(0)
  expect(lines.at(-1)).toBe('🟢 ctx 52K · 3 turns · cache 60m')
})
