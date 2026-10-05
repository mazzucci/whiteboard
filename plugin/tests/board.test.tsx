import { expect, test } from 'claude-code/testing'

const SOURCE = `flowchart LR
  app([Mobile app]) -->|POST /orders| api[Orders API]
  api --> db[(Orders DB)]
  classDef slow stroke:#c0392b,stroke-width:3px
  class api slow`

const READY = { ready: true, url: 'http://127.0.0.1:4711/?t=tok', port: 4711, token: 'tok' }

type On = Parameters<Parameters<typeof test>[1]>[1]
type Posted = { ok: boolean; viewers: number; drawn: boolean; error?: string }

/**
 * The machine beneath the plugin: Node on PATH, `open` for the browser, and
 * a board process that is ready at once, says what `says` holds, and stays
 * up until `stop()`. The page answers each post with `page(body)`.
 */
function host(
  on: On,
  options: {
    surfaces?: string[]
    hasNode?: boolean
    says?: string[]
    /** Holds the board's messages back until this resolves. */
    sayAfter?: Promise<void>
    page?: (body: Record<string, unknown>) => Posted
  } = {},
) {
  const spawned: string[][] = []
  const opened: string[] = []
  const posts: Record<string, unknown>[] = []
  const prompts: { text: string; asUser?: boolean }[] = []
  const boards: (() => void)[] = []
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }))
  on('env.get', (_$, e) => ({ value: e.name === 'PATH' ? '/usr/local/bin' : undefined }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/usr/bin/open' || (e.path === '/usr/local/bin/node' && options.hasNode !== false) }))
  on('process.run', (_$, e) => {
    opened.push(String(e.argv[1]))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    const alive = new Promise<void>(resolve => boards.push(resolve))
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ ...READY, port: READY.port + spawned.length - 1 })}\n` }
    await options.sayAfter
    for (const say of options.says ?? []) yield { stream: 'stdout' as const, text: `${JSON.stringify({ say })}\n` }
    await alive
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', (_$, e) => {
    expect(e.init?.headers).toMatchObject({ 'x-board-token': 'tok' })
    const body = JSON.parse(String(e.init?.body)) as Record<string, unknown>
    posts.push({ ...body, port: Number(new URL(e.url).port) })
    if (body.end === true) boards.shift()?.()
    const posted = options.page?.(body) ?? { ok: true, viewers: 1, drawn: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(posted) } }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push({ text: e.text })
    return { text: e.text }
  })
  return { spawned, opened, posts, prompts, stop: () => boards.splice(0).forEach(end => end()) }
}

const said = (result: unknown) => JSON.stringify(result)

test('from a terminal, the first diagram starts the board and opens it in the browser, once', async ($, on) => {
  const { spawned, opened, posts, stop } = host(on)
  const first = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', title: 'Orders', mermaid: SOURCE })
  expect(said(first)).toContain('Drawn on the whiteboard page, which just opened in the browser')
  // Node runs the plugin's own server; nothing else is needed.
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.[0]).toBe('/usr/local/bin/node')
  expect(spawned[0]?.[1]).toMatch(/\/board\/server\.mjs$/)
  expect(opened).toEqual([READY.url])
  // A page that is just opening is waited for, so the first diagram is checked too.
  expect(posts[0]).toMatchObject({ title: 'Orders', mermaid: SOURCE, waitForPage: true })

  const second = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'The **API** is the slow part.' })
  expect(said(second)).toContain('Posted to the whiteboard page.')
  expect(spawned).toHaveLength(1)
  expect(opened).toHaveLength(1)
  expect(posts[1]).toMatchObject({ text: 'The **API** is the slow part.', waitForPage: false })
  stop()
})

test("Mermaid's error on the page goes back to Claude", async ($, on) => {
  const { stop } = host(on, {
    page: () => ({ ok: false, viewers: 1, drawn: false, error: 'Parse error on line 2:\n...A --> call\nExpecting NODE_STRING, got CALLBACKNAME' }),
  })
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: 'flowchart LR\n  A --> call' })
  expect(said(shown)).toContain('Mermaid could not draw this diagram')
  expect(said(shown)).toContain('got CALLBACKNAME')
  expect(said(shown)).toContain('taken off the page')
  stop()
})

test('with no page open, Claude is told how the user opens it', async ($, on) => {
  const { stop } = host(on, { page: () => ({ ok: true, viewers: 0, drawn: false }) })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'first' })
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'second' })
  expect(said(shown)).toContain('no whiteboard page is open')
  expect(said(shown)).toContain('/whiteboard opens it')
  stop()
})

test("the legend carries each class's colour, and names classes with no classDef", async ($, on) => {
  const { posts, stop } = host(on)
  const shown = await $.tool.call({
    tool: 'mcp__whiteboard__post_to_board',
    mermaid: SOURCE,
    legend: [
      { label: 'Slow', class: 'slow' },
      { label: 'Missing', class: 'nowhere' },
    ],
  })
  expect(posts[0]?.legend).toEqual([
    { label: 'Slow', isDashed: false, stroke: '#c0392b' },
    { label: 'Missing', isDashed: false },
  ])
  expect(said(shown)).toContain('classes with no classDef: nowhere')
  stop()
})

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20))

test('what the person types on the page is submitted as their own words', async ($, on) => {
  let release = () => {}
  const { prompts, stop } = host(on, { says: ['why 1,240 calls?'], sayAfter: new Promise(r => (release = r)) })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  release()
  await tick()
  expect(prompts.map(p => p.text)).toContain('(on the whiteboard) why 1,240 calls?')
  stop()
})

test('typed while Claude is mid-call: kept, not lost, and submitted when the turn completes', async ($, on) => {
  const { prompts, stop } = host(on, { says: ['wait, what about retries?'] })
  on('turn.complete', () => ({ text: '' }))
  // The board says it while the tool call still holds the turn.
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  await tick()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await tick()
  expect(prompts.map(p => p.text)).toContain('(on the whiteboard) wait, what about retries?')
  stop()
})

test('wrap-up closes the page, and the next post starts a new one', async ($, on) => {
  const { spawned, opened, posts, stop } = host(on)
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  const ended = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', end: true, text: 'Summary is in the conversation.' })
  expect(said(ended)).toContain('closing')
  expect(posts[1]).toMatchObject({ end: true, text: 'Summary is in the conversation.' })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'a new discussion' })
  expect(spawned).toHaveLength(2)
  expect(opened).toHaveLength(2)
  stop()
})

test('/whiteboard focus opens the board and tells Claude to answer there', async ($, on) => {
  const { opened, stop } = host(on)
  const out = await $.command.run({ command: 'whiteboard', args: 'focus' })
  expect(said(out)).toContain('opened in your browser')
  expect(said(out)).toContain('(on the whiteboard)')
  // Asked again: the tab may have been closed, so it opens again.
  await $.command.run({ command: 'whiteboard', args: '' })
  expect(opened).toHaveLength(2)
  stop()
})

test('without a screen (claude -p) or without Node, the call says so', async ($, on) => {
  host(on, { surfaces: [] })
  expect(said(await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'x' }))).toContain('Nobody can see the whiteboard')
})

test('without Node, Claude is told what to install', async ($, on) => {
  host(on, { hasNode: false })
  expect(said(await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'x' }))).toContain('install Node.js')
})

test('an empty post is refused', async ($, on) => {
  host(on)
  expect(said(await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', title: 'only a title' }))).toContain('Nothing posted')
})

test('sticky notes go with a diagram, or on the latest one; with no diagram yet, Claude is told', async ($, on) => {
  let hasDiagram = false
  const { posts, stop } = host(on, {
    page: body =>
      body.mermaid
        ? ((hasDiagram = true), { ok: true, viewers: 1, drawn: true })
        : body.notes && !hasDiagram
          ? { ok: false, viewers: 1, drawn: false, noDiagram: true }
          : { ok: true, viewers: 1, drawn: false },
  })
  const early = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', notes: [{ on: 'api', text: 'Proposal: cache it' }] })
  expect(said(early)).toContain('No diagram on the board')
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE, notes: [{ on: 'api', text: 'slow here' }] })
  expect(posts[1]).toMatchObject({ mermaid: SOURCE, notes: [{ on: 'api', text: 'slow here' }] })
  const later = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', notes: [{ on: 'db', text: 'Proposal: an index' }, { text: '' }] })
  expect(said(later)).toContain('Posted')
  expect(posts[2]?.notes).toEqual([{ on: 'db', text: 'Proposal: an index' }])
  stop()
})
