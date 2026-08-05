/**
 * Tests for unattended task rules and execution.
 *
 * Two concerns, and they fail differently. The rules decide what a task running
 * at 3am is allowed to touch — getting those wrong is a security problem. The
 * runner decides what gets recorded about a run — getting that wrong means a
 * task silently reports success for a turn that produced nothing.
 */
import assert from 'node:assert/strict'
import { SessionManager } from '../src/main/agent/manager'
import type { SessionDeps } from '../src/main/agent/session'
import { TaskRunner } from '../src/main/task-runner'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import {
  decideForTask,
  describeTask,
  normaliseTask,
  settingsForTask,
  validateTask
} from '../src/shared/tasks'
import type { ScheduledTask, Settings } from '../src/shared/types'

const MODEL = 'anthropic:test-model'
const KINDS = ['edit', 'write', 'shell', 'external', 'mcp'] as const

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    activeModel: MODEL,
    providers: [
      {
        id: 'anthropic',
        name: 'Test',
        kind: 'anthropic',
        baseUrl: 'https://example.invalid',
        apiKey: 'test-key',
        headers: {},
        builtin: true,
        enabled: true,
        models: [
          {
            id: 'test-model',
            label: 'Test',
            contextWindow: 100_000,
            maxOutputTokens: 4_000,
            supportsTools: true,
            supportsVision: false,
            supportsThinking: false
          }
        ]
      }
    ],
    ...overrides
  }
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'Nightly check',
    prompt: 'summarise what changed today',
    schedule: { kind: 'interval', everyMinutes: 60 },
    enabled: true,
    permission: 'read-only',
    model: '',
    notify: false,
    createdAt: 0,
    nextRunAt: 0,
    ...overrides
  }
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const REPLY = (text: string, output = 7): string[] => [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${output}}}\n\n`
]

/** A manager whose sessions record every dep the runner replaced. */
function makeManager(base: Settings) {
  const seen = {
    settings: [] as Settings[],
    persisted: 0
  }

  const makeDeps = (currentId: () => string): SessionDeps => ({
    cwd: () => process.cwd(),
    settings: () => base,
    saveSettings: () => undefined,
    emit: () => undefined,
    askUser: async () => {
      throw new Error('the standard askUser must never be reached by a task')
    },
    mcpTools: () => [],
    skillTool: () => null,
    hostTools: () => [],
    skillCatalogue: () => '',
    gitContext: async () => '',
    persist: () => {
      seen.persisted += 1
      void currentId()
    }
  })

  return { manager: new SessionManager(makeDeps, () => undefined), seen }
}

export async function runTaskTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch

  /* ---------------- permission rules ---------------- */

  await test('a read-only task refuses every kind of side effect', () => {
    for (const kind of KINDS) {
      const decision = decideForTask('read-only', kind)
      assert.equal(decision.action, 'deny', `read-only allowed ${kind}`)
      assert.ok(
        decision.action === 'deny' && decision.reason && decision.reason.length > 0,
        'a denial must explain itself, or the model retries the same thing forever'
      )
    }
  })

  await test('an edit task may change files and nothing else', () => {
    assert.equal(decideForTask('edit', 'edit').action, 'allow')
    assert.equal(decideForTask('edit', 'write').action, 'allow')

    // Shell is the dangerous one: a task that may edit files must not thereby
    // be able to run arbitrary commands.
    assert.equal(decideForTask('edit', 'shell').action, 'deny')
    assert.equal(decideForTask('edit', 'external').action, 'deny')
    assert.equal(decideForTask('edit', 'mcp').action, 'deny')
  })

  await test('a full-access task allows everything, by definition', () => {
    for (const kind of KINDS) {
      assert.equal(decideForTask('full', kind).action, 'allow', `full denied ${kind}`)
    }
  })

  await test('no permission level ever answers "ask"', () => {
    // 'ask' would go to a dialog nobody is in front of, and the agent loop has
    // no timeout on that wait — the session would hang until the app restarts.
    for (const permission of ['read-only', 'edit', 'full'] as const) {
      for (const kind of KINDS) {
        const action = decideForTask(permission, kind).action
        assert.ok(action === 'allow' || action === 'deny', `${permission}/${kind} gave ${action}`)
      }
    }
  })

  /* ---------------- settings overlay ---------------- */

  await test('read-only takes the mutating tools away rather than refusing them', () => {
    const applied = settingsForTask(settings(), 'read-only', '')

    assert.equal(applied.readOnly, true)
    assert.equal(applied.bypassPermissions, false)
  })

  await test('full access bypasses, because approval modes alone are not enough', () => {
    const applied = settingsForTask(settings(), 'full', '')

    // Setting editApproval/commandApproval to 'auto' leaves `external` requests
    // going to the dialog, so only bypassPermissions actually covers everything.
    assert.equal(applied.bypassPermissions, true)
    assert.equal(applied.readOnly, false)
  })

  await test('an edit task applies its edits instead of stacking them for review', () => {
    const applied = settingsForTask(settings({ editApproval: 'review' }), 'edit', '')

    assert.equal(applied.editApproval, 'auto')
    assert.equal(applied.readOnly, false)
    assert.equal(applied.bypassPermissions, false)
  })

  await test('a task always saves its transcript, whatever the app setting is', () => {
    // The transcript is the only record of what an unattended run did.
    const applied = settingsForTask(settings({ autoSaveSessions: false }), 'read-only', '')
    assert.equal(applied.autoSaveSessions, true)
  })

  await test('a task model override wins, and an empty one changes nothing', () => {
    assert.equal(settingsForTask(settings(), 'read-only', 'openai:gpt-4.1').activeModel, 'openai:gpt-4.1')
    assert.equal(settingsForTask(settings(), 'read-only', '').activeModel, MODEL)
  })

  await test('the overlay never mutates the settings it was given', () => {
    const base = settings()
    const before = JSON.stringify(base)
    settingsForTask(base, 'full', 'openai:gpt-4.1')

    assert.equal(JSON.stringify(base), before, 'a task run must not change the app-wide settings')
  })

  await test('a deletion is never covered by "apply edits without asking"', () => {
    // The `edit` level exists to let a task tidy up files. Removing them is a
    // different promise, and it is the one edit the review screen cannot undo.
    assert.equal(decideForTask('edit', 'edit').action, 'allow')
    assert.equal(decideForTask('edit', 'edit', true).action, 'deny')
    assert.equal(decideForTask('edit', 'write', true).action, 'deny')

    // Full access means full access; that was the explicit choice.
    assert.equal(decideForTask('full', 'edit', true).action, 'allow')
  })

  await test('a task does not inherit permissions granted interactively', () => {
    const base = settings({
      // "Always allow" answers, given once with a dialog on screen.
      allowRules: ['Bash(git push *)', 'mcp__deploy__release(*)'],
      // A folder approved when the agent asked to read it, that time.
      externalRoots: ['C:\secrets'],
      denyRules: ['Bash(rm *)']
    })

    for (const level of ['read-only', 'edit'] as const) {
      const applied = settingsForTask(base, level, '')
      assert.deepEqual(applied.allowRules, [], `${level} inherited an allow rule`)
      assert.deepEqual(applied.externalRoots, [], `${level} inherited an approved folder`)
      assert.deepEqual(
        applied.denyRules,
        base.denyRules,
        'deny rules only ever narrow, so they must survive'
      )
    }
  })

  await test('full access keeps the deny rules that were set on purpose', () => {
    const base = settings({ denyRules: ['Bash(rm *)'] })
    const applied = settingsForTask(base, 'full', '')

    assert.deepEqual(applied.denyRules, ['Bash(rm *)'])
    assert.equal(applied.bypassPermissions, true)
  })

  /* ---------------- validation and shape ---------------- */

  await test('a task without a prompt cannot be saved', () => {
    assert.ok(validateTask({ prompt: '   ', schedule: { kind: 'interval', everyMinutes: 60 } }))
    assert.equal(
      validateTask({ prompt: 'do it', schedule: { kind: 'interval', everyMinutes: 60 } }),
      null
    )
    assert.ok(
      validateTask({ prompt: 'do it', schedule: { kind: 'weekly', days: [], atMinutes: 0 } }),
      'a bad schedule must be caught at save time, not at fire time'
    )
  })

  await test('a disabled task carries no next run', () => {
    const enabled = normaliseTask({ prompt: 'x', enabled: true }, 1_000, 5_000)
    const disabled = normaliseTask({ prompt: 'x', enabled: false }, 1_000, 5_000)

    assert.equal(enabled.nextRunAt, 5_000)
    assert.equal(
      disabled.nextRunAt,
      null,
      'so nothing downstream has to remember to check `enabled` before arming a timer'
    )
  })

  await test('an unnamed task still gets a name, and defaults are the safe ones', () => {
    const task = normaliseTask({ prompt: 'x' }, 1_000, null)

    assert.equal(task.name, 'Untitled task')
    assert.equal(task.permission, 'read-only', 'the default must be the level that cannot break anything')
    assert.equal(task.enabled, true)
  })

  await test('a task describes itself in one line', () => {
    const text = describeTask(makeTask({ schedule: { kind: 'daily', atMinutes: 9 * 60 } }))

    assert.ok(text.includes('09:00'))
    assert.ok(text.includes('read only'))
  })

  /* ---------------- running ---------------- */

  await test('a run records the agent’s closing message', async () => {
    globalThis.fetch = (async () => sseResponse(REPLY('Nothing changed today.'))) as typeof fetch

    const { manager } = makeManager(settings())
    const result = await new TaskRunner({ manager, settings }).run(makeTask())

    assert.equal(result.status, 'ok')
    assert.equal(result.summary, 'Nothing changed today.')
    assert.ok(result.durationMs >= 0)
    assert.ok(result.sessionId)

    globalThis.fetch = originalFetch
  })

  await test('a run does not steal the conversation you are reading', async () => {
    globalThis.fetch = (async () => sseResponse(REPLY('done'))) as typeof fetch

    const { manager } = makeManager(settings())
    const mine = manager.current()

    await new TaskRunner({ manager, settings }).run(makeTask())

    assert.equal(
      manager.activeId,
      mine.id,
      'a task firing while you work must not switch the view out from under you'
    )

    globalThis.fetch = originalFetch
  })

  await test('a provider failure is reported, not swallowed as success', async () => {
    // send() resolves normally on a failed turn — the error only ever appears
    // as an event. A runner that just awaits send() records a false success.
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"model not found"}}', {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch

    const { manager } = makeManager(settings())
    const result = await new TaskRunner({ manager, settings }).run(makeTask())

    assert.equal(result.status, 'error')
    assert.ok(result.error && result.error.length > 0)

    globalThis.fetch = originalFetch
  })

  await test('a retried turn does not leave its abandoned text in the summary', async () => {
    let call = 0
    globalThis.fetch = (async () => {
      call += 1
      // First attempt starts speaking, then fails with a retryable status.
      if (call === 1) {
        return new Response('{"error":{"message":"overloaded"}}', {
          status: 529,
          headers: { 'content-type': 'application/json' }
        })
      }
      return sseResponse(REPLY('The real answer.'))
    }) as typeof fetch

    const { manager } = makeManager(settings())
    const result = await new TaskRunner({ manager, settings }).run(makeTask())

    assert.equal(result.status, 'ok')
    assert.equal(result.summary, 'The real answer.')

    globalThis.fetch = originalFetch
  })

  await test('usage is summed per turn, not read off the cumulative total', async () => {
    globalThis.fetch = (async () => sseResponse(REPLY('ok', 7))) as typeof fetch

    const { manager } = makeManager(settings())
    const runner = new TaskRunner({ manager, settings })

    const first = await runner.run(makeTask())
    const second = await runner.run(makeTask())

    assert.equal(first.usage.output, 7)
    assert.equal(
      second.usage.output,
      7,
      'session totals accumulate across turns, so the second run must not report the first run too'
    )

    globalThis.fetch = originalFetch
  })

  await test('a long reply is trimmed to something a list can show', async () => {
    const long = 'x'.repeat(2_000)
    globalThis.fetch = (async () => sseResponse(REPLY(long))) as typeof fetch

    const { manager } = makeManager(settings())
    const result = await new TaskRunner({ manager, settings }).run(makeTask())

    assert.ok(result.summary.length < 500)
    assert.ok(result.summary.endsWith('…'))

    globalThis.fetch = originalFetch
  })

  await test('a run streams its progress to whoever is listening', async () => {
    globalThis.fetch = (async () => sseResponse(REPLY('hi'))) as typeof fetch

    const seen: string[] = []
    const { manager } = makeManager(settings())
    await new TaskRunner({
      manager,
      settings,
      emit: ({ taskId, event }) => {
        assert.equal(taskId, 'task-1')
        seen.push(event.type)
      }
    }).run(makeTask())

    assert.ok(seen.includes('turn_start'))
    assert.ok(seen.includes('idle'))

    globalThis.fetch = originalFetch
  })

  globalThis.fetch = originalFetch
}
