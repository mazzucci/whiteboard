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
    /** `node --version`'s answer. */
    nodeVersion?: string
    env?: Record<string, string>
    /** Directories that exist, as `$.fs.list` answers them. */
    dirs?: Record<string, string[]>
    /** Extra paths that exist. */
    paths?: string[]
    /** How long a prompt takes to be submitted. */
    submitMs?: number
    /** Commands `command -v` finds. */
    browsers?: string[]
    /** How many pages show the board, asked before each post (1 unless said). */
    viewers?: () => number
    /** What the board holds, for read_board. */
    cards?: Record<string, unknown>[]
    /** Edited diagrams' summaries, by card id. */
    scenes?: Record<string, unknown>
    /** The board's mode, as /cards reads it. */
    mode?: string
  } = {},
) {
  const spawned: string[][] = []
  const opened: string[] = []
  const posts: Record<string, unknown>[] = []
  const prompts: { text: string; context?: readonly string[] }[] = []
  const boards: (() => void)[] = []
  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }))
  const env: Record<string, string> = { PATH: '/usr/local/bin', HOME: '/Users/someone', ...options.env }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('fs.exists', (_$, e) => ({
    value:
      e.path === '/usr/bin/open' ||
      (e.path === '/usr/local/bin/node' && options.hasNode !== false) ||
      (options.paths ?? []).includes(e.path),
  }))
  on('fs.list', (_$, e) => {
    const names = options.dirs?.[String(e.path)]
    if (!names) throw new Error('ENOENT')
    return { value: names.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_$, e) => {
    if (e.argv[1] === '--version') return { value: { exitCode: 0, stdout: `${options.nodeVersion ?? 'v22.12.0'}\n`, stderr: '' } }
    // $BROWSER: looked up with `command -v`, then started detached through sh.
    if (e.argv[0] === '/bin/sh') {
      const script = String(e.argv[2])
      if (script.startsWith('command -v')) return { value: { exitCode: (options.browsers ?? []).includes(String(e.argv[4])) ? 0 : 1, stdout: '', stderr: '' } }
      opened.push(`detached:${e.argv.slice(4).join(' ')}`)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    opened.push(String(e.argv[1]))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('process.spawn', async function* (_$, e) {
    // A browser started through $BROWSER: recorded, and done at once.
    if (!String(e.argv[1] ?? '').endsWith('server.mjs')) {
      opened.push(`spawn:${e.argv.join(' ')}`)
      return { value: { code: 0, signal: null } }
    }
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
    if (e.init?.method === 'GET') {
      const path = new URL(e.url).pathname
      const value = path === '/viewers' ? { viewers: options.viewers?.() ?? 1 } : { viewers: 1, cards: options.cards ?? [], scenes: options.scenes ?? {}, mode: options.mode ?? 'diagrams' }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } }
    }
    const body = JSON.parse(String(e.init?.body)) as Record<string, unknown>
    posts.push({ ...body, port: Number(new URL(e.url).port) })
    if (body.end === true) boards.shift()?.()
    const posted = options.page?.(body) ?? { ok: true, viewers: 1, drawn: true }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(posted) } }
  })
  on('prompt.submit', async (_$, e) => {
    prompts.push({ text: e.text, context: e.context })
    if (options.submitMs) await new Promise(resolve => setTimeout(resolve, options.submitMs))
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

test('a closed tab opens again with the next post, which waits for the page', async ($, on) => {
  let viewers = 1
  const { opened, posts, stop } = host(on, { viewers: () => viewers })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'first' })
  expect(opened).toHaveLength(1)
  // The person closed the tab.
  viewers = 0
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE })
  expect(opened).toHaveLength(2)
  expect(said(shown)).toContain('opened again in the browser')
  expect(posts[1]).toMatchObject({ waitForPage: true })
  // With a tab showing it, nothing opens.
  viewers = 1
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'third' })
  expect(opened).toHaveLength(2)
  stop()
})

test('a page that never shows up: Claude is told how the user opens it', async ($, on) => {
  const { stop } = host(on, { page: () => ({ ok: true, viewers: 0, drawn: false }), browsers: [], env: { BROWSER: 'nosuchbrowser' } })
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'first' })
  expect(said(shown)).toContain('give the user this link')
  stop()
})

test('read_board gives Claude back each diagram with its source and sticky notes, and what the user wrote', async ($, on) => {
  const cards = [
    { id: 1, kind: 'diagram', title: 'Orders', mermaid: SOURCE, notes: [{ on: 'api', text: 'slow here' }] },
    { id: 2, kind: 'sticky', by: 'claude', diagram: 1, on: 'db', text: 'Proposal: an index' },
    { id: 3, kind: 'you', text: 'what about the cache?' },
    { id: 4, kind: 'note', text: 'The cache is cold.' },
  ]
  const { stop } = host(on, { cards })
  const empty = await $.tool.call({ tool: 'mcp__whiteboard__read_board' })
  expect(said(empty)).toContain('no whiteboard page in this session')
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  const read = said(await $.tool.call({ tool: 'mcp__whiteboard__read_board' }))
  expect(read).toContain('Diagram 1 of 1, \\"Orders\\"')
  expect(read).toContain('api[Orders API]')
  expect(read).toContain('sticky note on api: slow here')
  expect(read).toContain('sticky note on db: Proposal: an index')
  expect(read).toContain('The user wrote: what about the cache?')
  expect(read).toContain('Your note: The cache is cold.')
  const latest = said(await $.tool.call({ tool: 'mcp__whiteboard__read_board', latest: true }))
  expect(latest).toContain('latest diagram')
  expect(latest).not.toContain('The user wrote')
  stop()
})

test('/whiteboard sample tells Claude what it drew, node ids and all', async ($, on) => {
  const { stop } = host(on)
  const out = await $.command.run({ command: 'whiteboard', args: 'sample' })
  expect(said(out)).toContain('Sample diagram drawn')
  expect(said(out)).toContain('mail[Email service]')
  expect(said(out)).toContain('node id')
  stop()
})

test('a message from the page is answered on the page, even when Claude replied only in the conversation', async ($, on) => {
  const { prompts, posts, stop } = host(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  await $.prompt.submit({ text: '(on the whiteboard) why is it slow?' } as never)
  expect(prompts.at(-1)?.context?.join(' ')).toContain('answer there with post_to_board')
  // Answered only in the conversation: the plugin posts the answer.
  await $.turn.start({ text: '(on the whiteboard) why is it slow?', turnId: 't1' })
  await $.turn.complete({ answer: 'The cache is cold.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  expect(posts.filter(p => p.text === 'The cache is cold.')).toHaveLength(1)
  // Answered on the board: nothing more is posted.
  await $.turn.start({ text: '(on the whiteboard) and now?', turnId: 't2' })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'Warm it at deploy.' })
  await $.turn.complete({ answer: 'Answered on the board.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  expect(posts.some(p => p.text === 'Answered on the board.')).toBe(false)
  // Typed in the conversation after that: Claude is told the user is back, once.
  await $.prompt.submit({ text: 'what time is it?', origin: { kind: 'composer' } } as never)
  expect(prompts.at(-1)?.context?.join(' ')).toContain('back in this conversation')
  await $.prompt.submit({ text: 'and the date?', origin: { kind: 'composer' } } as never)
  expect((prompts.at(-1)?.context ?? []).join(' ')).not.toContain('back in this conversation')
  // A prompt typed in the conversation is answered there.
  await $.turn.start({ text: 'what time is it?', turnId: 't3' })
  await $.turn.complete({ answer: 'Noon.', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as never)
  expect(posts.some(p => p.text === 'Noon.')).toBe(false)
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
  const early = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', sticky_notes: [{ on: 'api', text: 'Proposal: cache it' }] })
  expect(said(early)).toContain('No diagram on the board')
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE, sticky_notes: [{ on: 'api', text: 'slow here' }] })
  expect(posts[1]).toMatchObject({ mermaid: SOURCE, notes: [{ on: 'api', text: 'slow here' }] })
  const later = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', sticky_notes: [{ on: 'db', text: 'Proposal: an index' }, { text: '' }] })
  expect(said(later)).toContain('Posted')
  expect(posts[2]?.notes).toEqual([{ on: 'db', text: 'Proposal: an index' }])
  stop()
})

test('a message is submitted once, even when two deliveries start together', async ($, on) => {
  const { prompts, stop } = host(on, { says: ['first', 'second'], submitMs: 30 })
  on('turn.complete', () => ({ text: '' }))
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  // The turn ends while the first submission is still on its way.
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await new Promise<void>(resolve => setTimeout(resolve, 150))
  expect(prompts.map(p => p.text)).toEqual(['(on the whiteboard) first', '(on the whiteboard) second'])
  stop()
})

test('node from nvm is found when the PATH has none, newest version first', async ($, on) => {
  const nvm = '/Users/someone/.nvm/versions/node'
  const { spawned, stop } = host(on, {
    hasNode: false,
    dirs: { [nvm]: ['v20.11.1', 'v22.3.0', 'v18.20.4'] },
    paths: [`${nvm}/v22.3.0/bin/node`, `${nvm}/v20.11.1/bin/node`],
  })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  expect(spawned[0]?.[0]).toBe(`${nvm}/v22.3.0/bin/node`)
  stop()
})

test('a node older than 18 is named, with what to install', async ($, on) => {
  host(on, { nodeVersion: 'v16.20.2' })
  const shown = said(await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'x' }))
  expect(shown).toContain('needs Node.js 18 or later')
  expect(shown).toContain('v16.20.2')
})

test('$BROWSER starts detached, %s standing for the URL', async ($, on) => {
  const { opened, stop } = host(on, { env: { BROWSER: 'firefox --new-tab %s' }, browsers: ['firefox'] })
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  expect(said(shown)).toContain('which just opened in the browser')
  expect(opened).toEqual([`detached:firefox --new-tab ${READY.url}`])
  stop()
})

test('a $BROWSER that does not exist is not reported as opened: Claude gets the link', async ($, on) => {
  const { opened, stop } = host(on, { env: { BROWSER: 'no-such-browser' } })
  const shown = said(await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' }))
  expect(shown).toContain('the browser could not be opened')
  expect(shown).toContain(READY.url)
  expect(opened).toEqual([])
  stop()
})

test('node from asdf installs is found ahead of its shim, symlinked nvm versions count', async ($, on) => {
  const asdf = '/Users/someone/.asdf/installs/nodejs'
  const { spawned, stop } = host(on, {
    hasNode: false,
    dirs: { [asdf]: ['20.11.1', '22.9.0'] },
    paths: [`${asdf}/22.9.0/bin/node`, '/Users/someone/.asdf/shims/node'],
  })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  expect(spawned[0]?.[0]).toBe(`${asdf}/22.9.0/bin/node`)
  stop()
})

test('edit_board amends a diagram in place: the board applies the ops and says which failed', async ($, on) => {
  const { posts, stop } = host(on, {
    page: body => (body.ops ? ({ ok: true, diagram: 'Orders', tab: 1, done: ['#1 (add)'], errors: ['#2 (connect): no box `nope`'] } as never) : { ok: true, viewers: 1, drawn: true }),
  })
  const early = await $.tool.call({ tool: 'mcp__whiteboard__edit_board', ops: [{ op: 'add', id: 'cache', text: 'Cache' }] })
  expect(said(early)).toContain('draw the diagram with post_to_board first')
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE })
  const out = await $.tool.call({ tool: 'mcp__whiteboard__edit_board', diagram: 1, ops: [{ op: 'add', id: 'cache', text: 'Cache', near: 'api' }, { op: 'connect', from: 'db', to: 'nope' }] })
  expect(posts.at(-1)).toMatchObject({ diagram: 1, ops: [{ op: 'add', id: 'cache' }, { op: 'connect', from: 'db' }] })
  expect(said(out)).toContain('1 of 2 applied')
  expect(said(out)).toContain('no box `nope`')
  expect(said(await $.tool.call({ tool: 'mcp__whiteboard__edit_board', ops: [] }))).toContain('Nothing to amend')
  stop()
})

test('read_board shows an edited diagram as it now is, and a picture when asked', async ($, on) => {
  const cards = [{ id: 1, kind: 'diagram', title: 'Orders', mermaid: SOURCE, notes: [{ on: 'api', text: 'old note' }] }]
  const scenes = {
    1: {
      boxes: [{ ref: 'api', text: 'Orders API', class: 'plain' }, { ref: 'redis', text: 'Redis?', class: 'proposed' }],
      arrows: [{ from: 'api', to: 'redis', text: '' }],
      notes: [{ ref: 'n1', text: 'TTL?', on: 'redis' }],
      texts: [],
      drawings: [{ near: 'api' }],
    },
  }
  const { stop } = host(on, { cards, scenes, page: body => (body.snapshot ? ({ ok: true, png: 'iVBORw0KGgo=', diagram: 'Orders' } as never) : { ok: true, viewers: 1, drawn: true }) })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  const read = said(await $.tool.call({ tool: 'mcp__whiteboard__read_board' }))
  expect(read).toContain('Edited on the canvas')
  expect(read).toContain('box `redis` \\"Redis?\\" (proposed)')
  expect(read).toContain('arrow `api` → `redis`')
  expect(read).toContain('sticky note `n1` by `redis`')
  expect(read).toContain('1 freehand mark')
  // The canvas has the notes now; the old ones are not repeated.
  expect(read).not.toContain('old note')
  const pictured = (await $.tool.call({ tool: 'mcp__whiteboard__read_board', image: true })) as { result: { type: string; source?: { data: string } }[] }
  expect(pictured.result[1]).toMatchObject({ type: 'image', source: { media_type: 'image/png', data: 'iVBORw0KGgo=' } })
  stop()
})

test('Claude picks the mode with a post, alone or with a diagram; /whiteboard canvas switches it and says so', async ($, on) => {
  const { posts, stop } = host(on)
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE, mode: 'canvas' })
  expect(posts[0]).toMatchObject({ mermaid: SOURCE, mode: 'canvas' })
  const alone = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mode: 'diagrams' })
  expect(said(alone)).toContain('diagrams mode now')
  const out = await $.command.run({ command: 'whiteboard', args: 'canvas' })
  expect(said(out)).toContain('canvas mode')
  expect(said(out)).toContain('edit_board')
  expect(posts.at(-1)).toMatchObject({ mode: 'canvas' })
  stop()
})

test('on a canvas, drawing the same diagram again is refused: Claude amends it, unless it says it is new', async ($, on) => {
  let mode = 'canvas'
  const { posts, stop } = host(on, { cards: [{ id: 1, kind: 'diagram', title: 'Orders', mermaid: SOURCE }], get mode() { return mode } } as never)
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', text: 'hello' })
  const again = await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE.replace('Orders API', 'Orders API · 3,400 ms') })
  expect(said(again)).toContain('Amend it with edit_board')
  expect(said(again)).toContain('`api`')
  const n = posts.length
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE, as_new: true })
  expect(posts.length).toBe(n + 1)
  // A different diagram is fine.
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: 'flowchart LR\n  x[X] --> y[Y]' })
  expect(posts.length).toBe(n + 2)
  // In diagrams mode a redraw is a new tab, as before.
  mode = 'diagrams'
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE })
  expect(posts.length).toBe(n + 3)
  stop()
})

test('edit_board comes back with a small picture of the result, unless look: false', async ($, on) => {
  const { posts, stop } = host(on, { page: body => (body.ops ? ({ ok: true, diagram: 'Orders', tab: 1, done: ['#1 (text)'], errors: [], ...(body.look === false ? {} : { look: '/9j/4AAQ' }) } as never) : { ok: true, viewers: 1, drawn: true }) })
  await $.tool.call({ tool: 'mcp__whiteboard__post_to_board', mermaid: SOURCE })
  const out = (await $.tool.call({ tool: 'mcp__whiteboard__edit_board', ops: [{ op: 'text', id: 'api', text: 'API' }] })) as { result: { type: string }[] }
  expect(out.result[1]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg', data: '/9j/4AAQ' } })
  const quiet = await $.tool.call({ tool: 'mcp__whiteboard__edit_board', look: false, ops: [{ op: 'text', id: 'api', text: 'API' }] })
  expect(posts.at(-1)).toMatchObject({ look: false })
  expect(said(quiet)).toContain('1 of 1 applied')
  stop()
})
