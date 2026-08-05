/**
 * Dependency-free smoke test for the pure logic that is easy to get subtly
 * wrong: diff rendering, permission rules, context trimming and SSE framing.
 * Run with: npm run smoke
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { effortToBudget } from '../src/shared/types'
import type { Message, ModelConfig, PermissionRequest } from '../src/shared/types'
import { ChangeTracker } from '../src/main/agent/changes'
import { estimateTokens, trimForContext } from '../src/main/agent/context'
import { countChanges, renderDiff } from '../src/main/agent/diff'
import { findMentionedPaths } from '../src/main/agent/paths'
import { evaluatePermission, matchesRule, ruleTarget } from '../src/main/agent/permissions'
import { readSse } from '../src/main/providers/sse'
import { composeMessage, isLargePaste, tooLarge } from '../src/renderer/attachments'
import { runManagerTests } from './manager-tests'
import { runScheduleTests } from './schedule-tests'
import { runSchedulerTests } from './scheduler-tests'
import { runTaskTests } from './task-tests'
import { runSessionTests } from './session-tests'

let passed = 0
let failed = 0
const pending: Promise<void>[] = []

function test(name: string, fn: () => void | Promise<void>): void {
  const ok = (): void => {
    passed++
    console.log(`  ok  ${name}`)
  }
  const bad = (error: unknown): void => {
    failed++
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`)
  }

  try {
    const value = fn()
    if (value instanceof Promise) pending.push(value.then(ok, bad))
    else ok()
  } catch (error) {
    bad(error)
  }
}

/* ------------------------------------------------------------------ */

console.log('diff')

test('renders an insertion with context', () => {
  const diff = renderDiff('a\nb\nc', 'a\nb\nX\nc')
  assert.ok(diff.includes('+X'), diff)
  assert.ok(diff.includes(' a'), diff)
})

test('renders a replacement as del + add', () => {
  const diff = renderDiff('one\ntwo\nthree', 'one\nTWO\nthree')
  assert.ok(diff.includes('-two') && diff.includes('+TWO'), diff)
})

test('counts changes', () => {
  const { added, removed } = countChanges('a\nb\nc\n', 'a\nc\nd\n')
  assert.equal(removed, 1)
  assert.equal(added, 1)
})

test('elides unchanged runs between hunks', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n')
  const after = before.replace('line5', 'FIRST').replace('line30', 'SECOND')
  const diff = renderDiff(before, after)

  assert.ok(diff.includes('⋮'), 'expected a gap marker between the two hunks')
  assert.ok(diff.includes('+FIRST') && diff.includes('+SECOND'), diff)
  assert.ok(!/^ line0$/m.test(diff), 'lines far from every hunk should be elided')
  assert.ok(/^ line4$/m.test(diff), 'context around a hunk should be kept')
})

test('keeps a single hunk contiguous with no gap marker', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n')
  const diff = renderDiff(before, before.replace('line20', 'CHANGED'))
  assert.ok(!diff.includes('⋮'), 'a single hunk needs no gap marker')
})

test('identical input yields an empty diff', () => {
  assert.equal(renderDiff('same\ntext', 'same\ntext'), '')
})

/* ------------------------------------------------------------------ */

console.log('permissions')

const perm = (
  overrides: Partial<Parameters<typeof evaluatePermission>[0]> & {
    request: Omit<PermissionRequest, 'id'>
  }
): ReturnType<typeof evaluatePermission> =>
  evaluatePermission({
    readOnly: false,
    bypassPermissions: false,
    editApproval: 'ask',
    commandApproval: 'ask',
    allowRules: [],
    denyRules: [],
    target: ruleTarget(overrides.request),
    ...overrides
  })

const req = (
  kind: PermissionRequest['kind'],
  toolName: string,
  value: string
): Omit<PermissionRequest, 'id'> => ({
  toolName,
  kind,
  title: kind === 'shell' ? 'Run command' : `Edit ${value}`,
  detail: value,
  suggestedRule: ''
})

test('bare namespace matches any target', () => {
  assert.equal(matchesRule('Bash', 'run_command', 'rm -rf build'), true)
})

test('glob pattern matches a command prefix', () => {
  assert.equal(matchesRule('Bash(git status *)', 'run_command', 'git status --short'), true)
  assert.equal(matchesRule('Bash(git status *)', 'run_command', 'git push origin main'), false)
})

test('rules are namespaced per tool', () => {
  assert.equal(matchesRule('Bash(*)', 'edit_file', 'src/app.ts'), false)
  assert.equal(matchesRule('Edit(src/**)', 'edit_file', 'src/deep/nested/app.ts'), true)
  assert.equal(matchesRule('Edit(src/*)', 'edit_file', 'src/deep/nested/app.ts'), false)
})

test('windows separators normalise to forward slashes', () => {
  assert.equal(matchesRule('Edit(src/**)', 'edit_file', 'src\\main\\index.ts'), true)
})

test('mcp tools match by their qualified name', () => {
  assert.equal(matchesRule('mcp__db__query(*)', 'mcp__db__query', 'anything'), true)
  assert.equal(matchesRule('mcp__db__query(*)', 'mcp__db__write', 'anything'), false)
})

test('deny beats every other setting', () => {
  assert.equal(
    perm({
      editApproval: 'auto',
      commandApproval: 'auto',
      allowRules: ['Bash'],
      denyRules: ['Bash(rm *)'],
      request: req('shell', 'run_command', 'rm -rf node_modules')
    }),
    'deny'
  )
})

test('read-only refuses edits even with an allow rule', () => {
  assert.equal(
    perm({
      readOnly: true,
      editApproval: 'auto',
      allowRules: ['Edit(**)'],
      request: req('edit', 'edit_file', 'src/app.ts')
    }),
    'deny'
  )
})

test('read-only refuses shell commands even on auto', () => {
  assert.equal(
    perm({ readOnly: true, commandApproval: 'auto', request: req('shell', 'run_command', 'ls') }),
    'deny'
  )
})

test('bypass approves everything, including paths outside the workspace', () => {
  for (const request of [
    req('edit', 'edit_file', 'src/app.ts'),
    req('shell', 'run_command', 'rm -rf build'),
    req('mcp', 'mcp__db__query', 'select 1'),
    req('external', 'external_path', 'C:/elsewhere/file.txt')
  ]) {
    assert.equal(perm({ bypassPermissions: true, request }), 'allow', request.toolName)
  }
})

test('a deny rule still beats bypass', () => {
  assert.equal(
    perm({
      bypassPermissions: true,
      denyRules: ['Bash(rm *)'],
      request: req('shell', 'run_command', 'rm -rf build')
    }),
    'deny'
  )
})

test('read-only still beats bypass', () => {
  assert.equal(
    perm({
      readOnly: true,
      bypassPermissions: true,
      request: req('edit', 'edit_file', 'src/app.ts')
    }),
    'deny'
  )
})

test('read-only still lets the user approve an outside path', () => {
  assert.equal(
    perm({ readOnly: true, request: req('external', 'external_path', 'C:/notes/todo.md') }),
    'ask'
  )
})

test('auto edits skip the prompt but commands still ask', () => {
  assert.equal(
    perm({ editApproval: 'auto', request: req('edit', 'edit_file', 'src/app.ts') }),
    'allow'
  )
  assert.equal(
    perm({ editApproval: 'auto', request: req('shell', 'run_command', 'npm test') }),
    'ask'
  )
})

test('auto commands skip the prompt', () => {
  assert.equal(
    perm({ commandApproval: 'auto', request: req('shell', 'run_command', 'npm test') }),
    'allow'
  )
})

test('an allow rule satisfies ask mode', () => {
  assert.equal(
    perm({
      allowRules: ['Bash(npm test *)'],
      request: req('shell', 'run_command', 'npm test --watch')
    }),
    'allow'
  )
  assert.equal(
    perm({
      allowRules: ['Bash(npm test *)'],
      request: req('shell', 'run_command', 'npm run build')
    }),
    'ask'
  )
})

test('an external path is always the user’s call', () => {
  assert.equal(
    perm({
      editApproval: 'auto',
      commandApproval: 'auto',
      allowRules: ['*'],
      request: req('external', 'external_path', 'C:/other/file.txt')
    }),
    'ask'
  )
})

/* ------------------------------------------------------------------ */

console.log('attachments')

test('a plain message passes through untouched', () => {
  const out = composeMessage('fix the parser', [])
  assert.equal(out.text, 'fix the parser')
  assert.deepEqual(out.images, [])
})

test('file attachments become paths the agent can act on', () => {
  const out = composeMessage('what does this do?', [
    { kind: 'file', id: '1', name: 'a.ts', path: 'C:\\proj\\a.ts', bytes: 10 }
  ])
  assert.ok(out.text.includes('C:\\proj\\a.ts'), out.text)
  assert.ok(out.text.includes('what does this do?'), out.text)
})

test('several files are listed one per line', () => {
  const out = composeMessage('', [
    { kind: 'file', id: '1', name: 'a.ts', path: '/p/a.ts', bytes: 1 },
    { kind: 'file', id: '2', name: 'b.ts', path: '/p/b.ts', bytes: 1 }
  ])
  assert.ok(out.text.includes('/p/a.ts') && out.text.includes('/p/b.ts'), out.text)
  assert.equal(out.text.split('\n').length, 3)
})

test('images travel as image blocks, not as text', () => {
  const out = composeMessage('look', [
    {
      kind: 'image',
      id: '1',
      name: 'shot.png',
      mediaType: 'image/png',
      data: 'AAAA',
      preview: 'blob:x',
      bytes: 100
    }
  ])
  assert.equal(out.text, 'look')
  assert.deepEqual(out.images, [{ mediaType: 'image/png', data: 'AAAA' }])
})

test('a long paste is fenced so it cannot be mistaken for instructions', () => {
  const out = composeMessage('explain this', [
    { kind: 'text', id: '1', name: 'p', text: 'line1\nline2', lines: 2 }
  ])
  assert.ok(out.text.includes('```\nline1\nline2\n```'), out.text)
})

test('an image-only message still sends', () => {
  const out = composeMessage('', [
    {
      kind: 'image',
      id: '1',
      name: 's.png',
      mediaType: 'image/png',
      data: 'B',
      preview: 'blob:y',
      bytes: 1
    }
  ])
  assert.equal(out.text, '')
  assert.equal(out.images.length, 1)
})

test('large-paste detection triggers on lines or on length', () => {
  assert.equal(isLargePaste('short'), false)
  assert.equal(isLargePaste('x\n'.repeat(30)), true)
  assert.equal(isLargePaste('y'.repeat(3000)), true)
})

test('oversized images are flagged', () => {
  const image = {
    kind: 'image' as const,
    id: '1',
    name: 'big.png',
    mediaType: 'image/png',
    data: '',
    preview: '',
    bytes: 9 * 1024 * 1024
  }
  assert.equal(tooLarge(image), true)
  assert.equal(tooLarge({ ...image, bytes: 1024 }), false)
})

/* ------------------------------------------------------------------ */

console.log('reasoning effort')

test('off means no thinking budget at all', () => {
  assert.equal(effortToBudget('off', 64_000), 0)
})

test('budget rises with effort', () => {
  const budgets = (['low', 'medium', 'high', 'max'] as const).map((level) =>
    effortToBudget(level, 64_000)
  )
  for (let i = 1; i < budgets.length; i++) {
    assert.ok(budgets[i] > budgets[i - 1], `${budgets[i - 1]} -> ${budgets[i]}`)
  }
})

test('every level stays below the output limit', () => {
  for (const maxOutput of [4_000, 8_000, 32_000, 64_000, 200_000]) {
    for (const level of ['low', 'medium', 'high', 'max'] as const) {
      const budget = effortToBudget(level, maxOutput)
      assert.ok(
        budget < maxOutput,
        `${level} at maxOutput ${maxOutput} produced ${budget}, which the API would reject`
      )
    }
  }
})

test('a small model clamps rather than overshooting', () => {
  // 24k of thinking does not fit in an 8k answer; it must come down.
  assert.equal(effortToBudget('high', 8_000), 6_000)
  assert.equal(effortToBudget('max', 8_000), 6_000)
})

/* ------------------------------------------------------------------ */

console.log('mentioned paths')

test('picks up a real path the user typed and ignores prose', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-paths-'))
  const file = path.join(dir, 'notes.md')
  await fs.writeFile(file, 'hi', 'utf8')

  const found = await findMentionedPaths(
    `please fix ${file}. also look at ${path.join(dir, 'does-not-exist.md')} and /nope/nope.txt`
  )

  assert.deepEqual(found, [path.normalize(file)])
  await fs.rm(dir, { recursive: true, force: true })
})

test('strips trailing punctuation and finds a named directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-paths-'))
  const found = await findMentionedPaths(`work in ${dir}, then stop.`)
  assert.deepEqual(found, [path.normalize(dir)])
  await fs.rm(dir, { recursive: true, force: true })
})

test('returns nothing when no path is mentioned', async () => {
  assert.deepEqual(await findMentionedPaths('refactor the auth module and add tests'), [])
})

/* ------------------------------------------------------------------ */

console.log('context')

const model: ModelConfig = {
  id: 'test',
  label: 'test',
  contextWindow: 4_000,
  maxOutputTokens: 500,
  supportsTools: true,
  supportsVision: false,
  supportsThinking: false
}

const userMessage = (text: string): Message => ({
  id: `u-${text.slice(0, 6)}`,
  role: 'user',
  content: [{ type: 'text', text }],
  createdAt: 0
})

const assistantWithTool = (id: string): Message => ({
  id: `a-${id}`,
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'x' } }],
  createdAt: 0
})

const toolResult = (id: string, size: number): Message => ({
  id: `r-${id}`,
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content: 'x'.repeat(size), isError: false }],
  createdAt: 0
})

test('a short conversation is left alone', () => {
  const messages = [userMessage('hello')]
  const result = trimForContext('system', messages, model, 500)
  assert.equal(result.notice, null)
  assert.equal(result.messages, messages)
})

test('old tool results are compacted before turns are dropped', () => {
  const messages = [
    userMessage('start'),
    assistantWithTool('t1'),
    toolResult('t1', 20_000),
    userMessage('next'),
    assistantWithTool('t2'),
    toolResult('t2', 200),
    userMessage('again'),
    assistantWithTool('t3'),
    toolResult('t3', 200)
  ]

  const result = trimForContext('system', messages, model, 500)
  assert.ok(result.notice?.includes('tool result'), result.notice ?? 'no notice')
  assert.equal(result.messages.length, messages.length, 'nothing should have been dropped yet')

  const compacted = result.messages[2].content[0]
  assert.equal(compacted.type, 'tool_result')
  assert.ok(compacted.type === 'tool_result' && compacted.content.length < 1000)
})

test('dropping stops on a clean user turn so tool pairing survives', () => {
  const messages: Message[] = []
  for (let i = 0; i < 12; i++) {
    messages.push(userMessage(`request ${i} ${'y'.repeat(2000)}`))
    messages.push(assistantWithTool(`t${i}`))
    messages.push(toolResult(`t${i}`, 2000))
  }

  const result = trimForContext('system', messages, model, 500)
  assert.ok(result.messages.length < messages.length, 'expected messages to be dropped')

  const head = result.messages[0]
  assert.equal(head.role, 'user')
  assert.ok(
    !head.content.some((block) => block.type === 'tool_result'),
    'the first kept message must not be an orphaned tool result'
  )
  assert.ok(
    head.content.some((block) => block.type === 'text' && block.text.includes('condensed')),
    'the agent should be told earlier turns were condensed'
  )
  assert.ok(
    head.content.some((block) => block.type === 'text' && /You asked|I ran/.test(block.text)),
    'the summary should carry what actually happened, not just that something was lost'
  )

  // Every tool_result kept must still have its tool_use earlier in the list.
  const seen = new Set<string>()
  for (const message of result.messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') seen.add(block.id)
      if (block.type === 'tool_result') {
        assert.ok(seen.has(block.toolUseId), `orphaned tool_result ${block.toolUseId}`)
      }
    }
  }
})

test('token estimate grows with content', () => {
  const small = estimateTokens('sys', [userMessage('hi')])
  const large = estimateTokens('sys', [userMessage('hi'.repeat(1000))])
  assert.ok(large > small * 10, `${small} vs ${large}`)
})

/* ------------------------------------------------------------------ */

console.log('change tracker')

test('keeps the original snapshot across repeated edits', () => {
  const tracker = new ChangeTracker()
  tracker.record({ absolutePath: '/x/a.ts', displayPath: 'a.ts', before: 'v1', after: 'v2' })
  tracker.record({ absolutePath: '/x/a.ts', displayPath: 'a.ts', before: 'v2', after: 'v3' })

  const [change] = tracker.list()
  assert.equal(tracker.count, 1, 'one file, one entry')
  assert.equal(change.before, 'v1', 'reject must restore the pre-agent content')
  assert.equal(change.after, 'v3')
  assert.equal(change.kind, 'modify')
})

test('a created file is reported as a creation', () => {
  const tracker = new ChangeTracker()
  tracker.record({ absolutePath: '/x/new.ts', displayPath: 'new.ts', before: null, after: 'a\nb' })
  const [change] = tracker.list()
  assert.equal(change.kind, 'create')
  assert.equal(change.added, 2)
  assert.equal(change.removed, 0)
})

test('reject restores the file and rejectAll clears the list', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-smoke-'))
  const existing = path.join(dir, 'existing.txt')
  const created = path.join(dir, 'created.txt')

  await fs.writeFile(existing, 'original', 'utf8')
  await fs.writeFile(existing, 'modified', 'utf8')
  await fs.writeFile(created, 'brand new', 'utf8')

  const tracker = new ChangeTracker()
  tracker.record({
    absolutePath: existing,
    displayPath: 'existing.txt',
    before: 'original',
    after: 'modified'
  })
  tracker.record({
    absolutePath: created,
    displayPath: 'created.txt',
    before: null,
    after: 'brand new'
  })

  await tracker.rejectAll()

  assert.equal(await fs.readFile(existing, 'utf8'), 'original')
  assert.equal(await fs.stat(created).then(() => true, () => false), false, 'created file removed')
  assert.equal(tracker.count, 0)

  await fs.rm(dir, { recursive: true, force: true })
})

test('accept drops the record without touching the file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-smoke-'))
  const file = path.join(dir, 'a.txt')
  await fs.writeFile(file, 'new content', 'utf8')

  const tracker = new ChangeTracker()
  const change = tracker.record({
    absolutePath: file,
    displayPath: 'a.txt',
    before: 'old content',
    after: 'new content'
  })
  tracker.accept(change.id)

  assert.equal(tracker.count, 0)
  assert.equal(await fs.readFile(file, 'utf8'), 'new content')

  await fs.rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */

console.log('sse')

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })

test('parses framed events and ignores keep-alives', async () => {
  const seen: Array<{ event: string; data: string }> = []
  for await (const frame of readSse(
    streamOf([': ping\n\n', 'event: message_start\ndata: {"a":1}\n\n', 'data: {"b":', '2}\n\ndata: [DONE]\n\n'])
  )) {
    seen.push(frame)
  }

  assert.deepEqual(seen, [
    { event: 'message_start', data: '{"a":1}' },
    { event: 'message', data: '{"b":2}' },
    { event: 'message', data: '[DONE]' }
  ])
})

test('handles CRLF frame separators', async () => {
  const seen = []
  for await (const frame of readSse(streamOf(['data: {"x":1}\r\n\r\n']))) seen.push(frame)
  assert.deepEqual(seen, [{ event: 'message', data: '{"x":1}' }])
})

test('joins multi-line data fields', async () => {
  const seen = []
  for await (const frame of readSse(streamOf(['data: line1\ndata: line2\n\n']))) seen.push(frame)
  assert.deepEqual(seen, [{ event: 'message', data: 'line1\nline2' }])
})

/* ------------------------------------------------------------------ */

console.log('agent session')

/**
 * These stub the global `fetch`, so they cannot overlap — the parallel `test`
 * helper would let each one clobber the previous stub.
 */
async function serialTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`)
  }
}

await runSessionTests(serialTest)

console.log('schedules')
await runScheduleTests(serialTest)

console.log('scheduler')
await runSchedulerTests(serialTest)

console.log('scheduled tasks')
await runTaskTests(serialTest)

console.log('parallel conversations')
await runManagerTests(serialTest)

/* ------------------------------------------------------------------ */

void Promise.allSettled(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
})
