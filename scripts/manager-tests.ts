/**
 * Tests for running several conversations at once.
 *
 * The thing worth guarding here is not that a second session can be created —
 * it is that leaving a conversation does not disturb it. Before the manager
 * existed, opening another chat loaded its history into the one live session
 * object, which silently killed whatever the previous one was doing and mixed
 * its events into the new transcript.
 */
import assert from 'node:assert/strict'
import { SessionManager } from '../src/main/agent/manager'
import type { AgentSession, SessionDeps } from '../src/main/agent/session'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { AgentEvent, SessionRecord, Settings } from '../src/shared/types'

const MODEL = 'anthropic:test-model'

function settings(): Settings {
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
    ]
  }
}

type Tagged = { sessionId: string; event: AgentEvent }

function makeManager(): { manager: SessionManager; events: Tagged[]; listChanges: number } {
  const events: Tagged[] = []
  const counter = { listChanges: 0 }

  const makeDeps = (currentId: () => string): SessionDeps => ({
    cwd: () => process.cwd(),
    settings,
    saveSettings: () => undefined,
    // The id is read at emit time, not at construction: a session that adopts a
    // stored conversation takes on its id, and events must follow.
    emit: (event) => events.push({ sessionId: currentId(), event }),
    askUser: async () => ({ action: 'allow' }),
    mcpTools: () => [],
    skillTool: () => null,
    hostTools: () => [],
    skillCatalogue: () => '',
    gitContext: async () => '',
    persist: () => undefined
  })

  const manager = new SessionManager(makeDeps, () => {
    counter.listChanges += 1
  })

  return {
    manager,
    events,
    get listChanges() {
      return counter.listChanges
    }
  }
}

/** A stream that never resolves until released, so a turn can be held open. */
function pendingResponse(): { response: Promise<Response>; release: () => void } {
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(
        encoder.encode(
          'event: message_start\ndata: {"type":"message_start","message":' +
            '{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n'
        )
      )
      await gate
      controller.enqueue(
        encoder.encode(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
            '"delta":{"type":"text_delta","text":"done"}}\n\n'
        )
      )
      controller.enqueue(
        encoder.encode(
          'event: message_delta\ndata: {"type":"message_delta","delta":' +
            '{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'
        )
      )
      controller.close()
    }
  })

  return {
    response: Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    ),
    release: () => release()
  }
}

export async function runManagerTests(
  test: (name: string, fn: () => Promise<void> | void) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch

  await test('constructing a manager does not call back into itself', () => {
    // The real wiring is `const manager = new SessionManager(deps, () =>
    // send(manager.list()))`. If the constructor announces the conversation it
    // creates, that callback runs while `manager` is still in its temporal
    // dead zone and throws — which reaches the app as an unhandled rejection
    // and a session list that never arrives at the renderer.
    let manager: SessionManager | null = null
    let announced = 0

    assert.doesNotThrow(() => {
      manager = new SessionManager(
        (currentId) => ({
          cwd: () => process.cwd(),
          settings,
          saveSettings: () => undefined,
          emit: () => void currentId(),
          askUser: async () => ({ action: 'allow' }),
          mcpTools: () => [],
          skillTool: () => null,
    hostTools: () => [],
          skillCatalogue: () => '',
          gitContext: async () => '',
          persist: () => undefined
        }),
        () => {
          announced += 1
          // Exactly what ipc.ts does, and the thing that used to blow up.
          ;(manager as SessionManager | null)?.list()
        }
      )
    })

    assert.equal(announced, 0, 'there is no listener yet, so there is nothing to announce')
    assert.ok((manager as SessionManager | null)?.current())

    // And it still announces normally once construction is done.
    ;(manager as unknown as SessionManager).create()
    assert.equal(announced, 1)
  })

  await test('a conversation keeps running after you switch away from it', async () => {
    const gate = pendingResponse()
    globalThis.fetch = (async () => gate.response) as typeof fetch

    const { manager } = makeManager()
    const first = manager.current()
    const turn = first.send('take your time')

    // Leave it mid-turn for a new conversation, exactly as the sidebar does.
    const second = manager.create()
    assert.notEqual(second.id, first.id)
    assert.equal(manager.activeId, second.id)
    assert.ok(first.isRunning, 'switching away must not stop the turn in flight')

    gate.release()
    await turn

    assert.equal(first.isRunning, false)
    assert.ok(
      first.messages.some((message) => message.role === 'assistant'),
      'the reply belongs to the conversation that asked for it'
    )
    assert.equal(second.messages.length, 0, 'the new conversation stays empty')

    globalThis.fetch = originalFetch
  })

  await test('events are tagged with the conversation that produced them', async () => {
    const gate = pendingResponse()
    globalThis.fetch = (async () => gate.response) as typeof fetch

    const { manager, events } = makeManager()
    const background = manager.current()
    const turn = background.send('hello')

    const foreground = manager.create()
    gate.release()
    await turn

    assert.ok(events.length > 0)
    assert.ok(
      events.every((entry) => entry.sessionId === background.id),
      'a background turn must not report under the conversation now on screen'
    )
    assert.ok(
      !events.some((entry) => entry.sessionId === foreground.id),
      'the foreground conversation produced nothing, so it should have no events'
    )

    globalThis.fetch = originalFetch
  })

  await test('activating a conversation leaves the others alone', () => {
    const { manager } = makeManager()
    const first = manager.current()
    const second = manager.create()

    assert.equal(manager.activate(first.id), true)
    assert.equal(manager.activeId, first.id)
    assert.equal(manager.get(second.id), second, 'the other conversation is still open')
    assert.equal(manager.activate('missing'), false)
    assert.equal(manager.activeId, first.id, 'a bad id must not change what is active')
  })

  await test('a restored conversation is keyed by its stored id', () => {
    const { manager } = makeManager()
    const record: SessionRecord = {
      id: 'stored-1',
      title: 'From disk',
      updatedAt: Date.now(),
      messageCount: 0,
      messages: [],
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 }
    }

    const restored = manager.adopt(record)
    assert.equal(restored.id, 'stored-1')
    assert.equal(manager.get('stored-1'), restored, 'lookups by the stored id must resolve')
    assert.equal(manager.activeId, 'stored-1')

    // Opening it a second time reuses the same live session rather than
    // creating a duplicate that would fight over the same file.
    assert.equal(manager.adopt(record), restored)
  })

  await test('closing the last conversation leaves a usable one behind', () => {
    const { manager } = makeManager()
    const only = manager.current()

    manager.close(only.id)

    const next = manager.current()
    assert.notEqual(next.id, only.id)
    assert.equal(manager.get(only.id), undefined)
    assert.equal(manager.list().length, 1)
  })

  await test('the sidebar list merges live conversations with saved ones', () => {
    const { manager } = makeManager()
    const live = manager.current()
    live.title = 'Working'
    live.messages = [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0 }
    ]

    const merged = manager.mergeSummaries([
      { id: 'saved-1', title: 'Yesterday', updatedAt: 1, messageCount: 4 }
    ])

    assert.equal(merged.length, 2, 'an unsaved conversation still has to be reachable')
    const entry = merged.find((item) => item.id === live.id)
    assert.ok(entry)
    assert.equal(entry?.open, true)
    assert.equal(merged.find((item) => item.id === 'saved-1')?.open, false)
    assert.ok(
      merged[0].updatedAt >= merged[1].updatedAt,
      'the list is newest first so the sidebar needs no second sort'
    )
  })

  await test('an empty new conversation is not offered as history', () => {
    const { manager } = makeManager()
    manager.current()

    assert.deepEqual(manager.mergeSummaries([]), [])
  })

  await test('stopping everything stops the background conversations too', async () => {
    const gate = pendingResponse()
    globalThis.fetch = (async () => gate.response) as typeof fetch

    const { manager } = makeManager()
    const background: AgentSession = manager.current()
    const turn = background.send('hold')
    manager.create()

    manager.abortAll()
    gate.release()
    await turn

    assert.equal(background.isRunning, false)

    globalThis.fetch = originalFetch
  })

  globalThis.fetch = originalFetch
}
