/**
 * Integration tests for the agent loop, driven through a stubbed `fetch` so the
 * real Anthropic adapter runs end to end.
 *
 * These cover the failure modes that are invisible in unit tests and expensive
 * in practice: an interrupted turn corrupting the conversation, and a stopped
 * turn leaving the session wedged.
 */
import assert from 'node:assert/strict'
import { AgentSession } from '../src/main/agent/session'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { AgentEvent, PermissionDecision, PermissionRequest, Settings } from '../src/shared/types'

type Recorded = { events: AgentEvent[]; session: AgentSession }

const MODEL = 'anthropic:test-model'

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    activeModel: MODEL,
    commandApproval: 'ask',
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

/** Builds an Anthropic SSE body from a list of frames. */
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

/** Turns event objects into the SSE frames an adapter expects. */
function frames(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => `event: ${String(event.type)}
data: ${JSON.stringify(event)}

`)
}

const TEXT_THEN_TOOL = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"working"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"run_command"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo hi\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n'
]

function makeSession(options: {
  fetchImpl: typeof fetch
  askUser?: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>
  config?: Settings
  /** Extra tools, for exercising how the loop copes with a badly behaved one. */
  tools?: Array<Record<string, unknown>>
}): Recorded {
  globalThis.fetch = options.fetchImpl
  const events: AgentEvent[] = []
  let config = options.config ?? settings()

  const session = new AgentSession({
    cwd: () => process.cwd(),
    settings: () => config,
    saveSettings: (next) => {
      config = next
    },
    emit: (event) => events.push(event),
    askUser: options.askUser ?? (async () => ({ action: 'allow' })),
    mcpTools: () => (options.tools ?? []) as never,
    skillTool: () => null,
    hostTools: () => [],
    skillCatalogue: () => '',
    gitContext: async () => '',
    persist: () => undefined
  })

  return { events, session }
}

/** Every tool_result must have a tool_use earlier in the conversation, and vice versa. */
function assertToolPairing(session: AgentSession): void {
  const uses = new Set<string>()
  const results = new Set<string>()

  for (const message of session.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') uses.add(block.id)
      if (block.type === 'tool_result') results.add(block.toolUseId)
    }
  }

  for (const id of uses) {
    assert.ok(
      results.has(id),
      `tool_use ${id} has no tool_result — the next request would be rejected outright`
    )
  }
  for (const id of results) {
    assert.ok(uses.has(id), `tool_result ${id} has no matching tool_use`)
  }
}

/**
 * `test` must run each case to completion before starting the next: every case
 * replaces the global `fetch`, so overlapping them means the last stub wins.
 */
export async function runSessionTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch

  await test('interrupting mid-stream leaves a conversation the provider will accept', async () => {
    // Abort while the tool_use block is still arriving.
    const { session } = makeSession({
      fetchImpl: (async () => {
        queueMicrotask(() => session.abort())
        return sseResponse(TEXT_THEN_TOOL)
      }) as typeof fetch
    })

    await session.send('do something')

    assertToolPairing(session)
    assert.equal(session.isRunning, false, 'the session must not stay running after an abort')
  })

  await test('a tool that never finishes does not wedge the session', async () => {
    /*
     * The guarantee: stop stops, whatever a tool does.
     *
     * A tool is handed the abort signal and is expected to wind up, but that is
     * an expectation, not a guarantee — a shell command whose grandchild still
     * holds the output pipe, an MCP server that stopped answering. This one
     * simply never settles, which is the worst case and the easiest to be sure
     * about. Without a bound on the wait the turn hangs forever, the session
     * stays marked running, and the stop button appears to do nothing.
     */
    const stuck = {
      name: 'stuck_tool',
      description: 'Never returns.',
      parameters: { type: 'object', properties: {}, required: [] },
      readOnly: true,
      title: () => 'Stuck()',
      run: () => new Promise(() => undefined)
    }

    const calling = frames([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_stuck', name: 'stuck_tool' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' }
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 5 }
      }
    ])

    const { session, events } = makeSession({
      fetchImpl: (async () => sseResponse(calling)) as typeof fetch,
      tools: [stuck]
    })

    const turn = session.send('call the stuck tool')
    setTimeout(() => session.abort(), 200)

    const outcome = await Promise.race([
      turn.then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 12_000))
    ])

    assert.equal(outcome, 'done', 'the turn never ended after stop was pressed')
    assert.equal(session.isRunning, false, 'the session is still marked as running')
    assert.ok(
      events.some((event) => event.type === 'idle'),
      'nothing told the UI the turn was over'
    )
    assertToolPairing(session)
  })

  await test('a stop during a permission prompt does not wedge the session', async () => {
    let session: AgentSession | undefined

    const made = makeSession({
      fetchImpl: (async () => sseResponse(TEXT_THEN_TOOL)) as typeof fetch,
      // Mimics the real dialog: it only ever settles if something cancels it.
      askUser: (_request, signal) =>
        new Promise<PermissionDecision>((resolve) => {
          if (signal.aborted) {
            resolve({ action: 'deny', reason: 'Interrupted.' })
            return
          }
          signal.addEventListener('abort', () => resolve({ action: 'deny', reason: 'Interrupted.' }), {
            once: true
          })
          // Nobody answers; the only way out is the abort above.
          setTimeout(() => session?.abort(), 40)
        })
    })
    session = made.session

    const finished = await Promise.race([
      made.session.send('run something').then(() => 'finished'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 8_000))
    ])

    assert.equal(finished, 'finished', 'stopping while a prompt is open must release the turn')
    assert.equal(made.session.isRunning, false)
    assertToolPairing(made.session)
    assert.ok(
      made.events.some((event) => event.type === 'idle'),
      'the UI needs an idle event or it shows a spinner forever'
    )
  })

  await test('a rejected tool still produces a result, keeping history valid', async () => {
    let calls = 0
    const { session } = makeSession({
      fetchImpl: (async () => {
        calls++
        // Second round: the model gives up and answers in prose.
        return calls === 1
          ? sseResponse(TEXT_THEN_TOOL)
          : sseResponse([
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"understood"}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'
            ])
      }) as typeof fetch,
      askUser: async () => ({ action: 'deny', reason: 'not now' })
    })

    await session.send('run something')

    assertToolPairing(session)
    const results = session.messages.flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_result')
    )
    assert.equal(results.length, 1)
    assert.ok(results[0].type === 'tool_result' && results[0].isError)
  })

  await test('a transient failure retries and withdraws the empty turn it announced', async () => {
    let calls = 0
    const { session, events } = makeSession({
      fetchImpl: (async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error('socket hang up'), { status: 503 })
        return sseResponse([
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
        ])
      }) as typeof fetch
    })

    await session.send('hello')

    assert.equal(calls, 2, 'a retryable failure should be retried once')
    assert.ok(
      events.some((event) => event.type === 'turn_abandoned'),
      'the abandoned attempt must be withdrawn or it lingers as an empty bubble'
    )

    const assistantTurns = session.messages.filter((message) => message.role === 'assistant')
    assert.equal(assistantTurns.length, 1, 'the failed attempt must not be recorded')
  })

  await test('a non-retryable failure surfaces and still releases the session', async () => {
    const { session, events } = makeSession({
      fetchImpl: (async () =>
        new Response('{"error":{"message":"bad key"}}', { status: 401 })) as typeof fetch
    })

    await session.send('hello')

    assert.equal(session.isRunning, false)
    assert.ok(events.some((event) => event.type === 'error'))
    assert.ok(events.some((event) => event.type === 'idle'))
  })

  globalThis.fetch = originalFetch
}
