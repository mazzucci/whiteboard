import type { EngineInterface, Register } from 'claude-code'

// The whiteboard is a page in the person's browser (board/server.mjs: Node's
// standard library, loopback only, a random token). Claude posts notes and
// Mermaid diagrams to it; the page draws them with the Mermaid vendored in
// board/vendor, and tells the plugin how each one drew, so Mermaid's errors
// come back to Claude. What the person types there is submitted into this
// session as their own words, so the whole discussion is in the conversation.

const TOOL = 'post_to_board'

type Doc = { title: string; source: string }

const SAMPLE: Doc = {
  title: 'Sample: checkout',
  source: `flowchart LR
  shopper([Shopper]) --> web[Storefront]
  web --> api[Orders API]
  api --> pay{{Payment provider}}
  api --> db[(Orders DB)]
  api -. order placed .-> mail[Email service]`,
}

/** What Claude is told when the person asks to discuss on the board. */
const FOCUS_NOTE =
  'Focus mode is on: the person is discussing on the whiteboard page, not in this conversation. Messages from them ' +
  `start with "(on the whiteboard)". Answer them ON THE BOARD with ${TOOL}: a short note, a diagram (mermaid), ` +
  'or both; keep your reply in the conversation to a line. Ask questions there too. When they wrap up, write a ' +
  `summary of what was concluded in the conversation itself, then call ${TOOL} with end: true to close the page.`

// ---------------------------------------------------------------- the board

type Board = { url: string; port: number; token: string }
let board: Promise<Board> | null = null

/** The node binary: on PATH, or where installers put it when the app's PATH is thin. */
async function nodePath($: EngineInterface): Promise<string> {
  const dirs = ((await $.env.get('PATH')) ?? '').split(':').filter(Boolean)
  for (const dir of [...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (await $.fs.exists(`${dir}/node`)) return `${dir}/node`
  }
  throw new Error('Node.js was not found. The whiteboard runs a small local server with it: install Node.js 18 or later (nodejs.org).')
}

/** Starts the board for this session; its stdout carries the person's messages. */
function startBoard($: EngineInterface): Promise<Board> {
  const self: Promise<Board> = new Promise<Board>((resolve, reject) => {
    void (async () => {
      try {
        const argv = [await nodePath($), `${$.plugin.root}/board/server.mjs`]
        let buffer = ''
        let err = ''
        // The loop is the board's life: it ends with the child or the module.
        for await (const piece of $.process.spawn({ argv })) {
          if (piece.stream !== 'stdout') {
            err = (err + piece.text).slice(-2000)
            continue
          }
          buffer += piece.text
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines.filter(Boolean)) {
            let message: { ready?: boolean; url?: string; port?: number; token?: string; say?: string }
            try {
              message = JSON.parse(line)
            } catch {
              continue
            }
            if (message.ready) resolve(message as Board)
            // The person's own words, marked so Claude answers on the board.
            else if (typeof message.say === 'string') {
              said.push(message.say)
              void deliver($)
            }
          }
        }
        // Only this board: after a wrap-up, a new one may already be starting.
        if (board === self) board = null
        reject(new Error(`The whiteboard page stopped. ${err.trim().split('\n').slice(-2).join(' ')}`))
      } catch (error) {
        if (board === self) board = null
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
  return self
}

/** Ends the discussion: the page says so and closes its tab, and the board stops. */
async function endBoard($: EngineInterface, text: string | undefined): Promise<boolean> {
  const current = board
  if (!current) return false
  board = null
  const open = await current
  await $.http.fetch(`http://127.0.0.1:${open.port}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board-token': open.token },
    body: JSON.stringify({ end: true, text }),
  })
  return true
}

/**
 * What the person typed on the page, not yet in the conversation. Each is
 * submitted as their own words, a turn of its own once the session is idle.
 * One that arrives while a hook holds the turn (Claude waiting on a diagram,
 * say) cannot be submitted then: it waits here for the turn to complete.
 */
const said: string[] = []
async function deliver($: EngineInterface) {
  while (said.length) {
    try {
      await $.prompt.submit({ text: `(on the whiteboard) ${said[0]}`, asUser: true })
    } catch {
      return
    }
    said.shift()
  }
}

/** Tells an open board whether Claude is in a turn; nothing when no board is open. */
async function boardStatus($: EngineInterface, status: 'working' | 'idle') {
  if (!board) return
  try {
    const open = await board
    await $.http.fetch(`http://127.0.0.1:${open.port}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-token': open.token },
      body: JSON.stringify({ status }),
    })
  } catch {
    // The board stopped: nothing to tell.
  }
}

/** Opens a URL in the person's browser: `open` on macOS, `xdg-open` elsewhere. */
async function openInBrowser($: EngineInterface, url: string): Promise<boolean> {
  const opener = (await $.fs.exists('/usr/bin/open')) ? '/usr/bin/open' : 'xdg-open'
  try {
    return (await $.process.run([opener, url])).exitCode === 0
  } catch {
    return false
  }
}

type Started = { open: Board; isNew: boolean; isOpened: boolean }

/**
 * The board for this session, started on first use. A new board opens in the
 * person's browser by itself, so the first post is seen; later posts go to the
 * tab they already have.
 */
async function boardOpen($: EngineInterface): Promise<Started> {
  const isNew = !board
  board ??= startBoard($)
  const open = await board
  return { open, isNew, isOpened: isNew && (await openInBrowser($, open.url)) }
}

type Legend = { label: string; stroke?: string; isDashed: boolean }
type Card = { title?: string; text?: string; mermaid?: string; legend?: Legend[] }
/** How the page drew a diagram: drawn, Mermaid's error, or not seen (no page open, or it did not answer). */
type Posted = { ok: boolean; viewers: number; drawn: boolean; error?: string }

async function postToBoard($: EngineInterface, card: Card): Promise<{ started: Started; posted: Posted }> {
  const started = await boardOpen($)
  const res = await $.http.fetch(`http://127.0.0.1:${started.open.port}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board-token': started.open.token },
    // A page that is just opening is waited for, so the first diagram is checked too.
    body: JSON.stringify({ ...card, waitForPage: started.isOpened }),
  })
  if (!res.ok) throw new Error(`the page answered ${res.status}`)
  return { started, posted: JSON.parse(res.text) as Posted }
}

/** Where the post went, said to Claude. */
function postedWhere({ started, posted }: { started: Started; posted: Posted }, isDiagram: boolean): string {
  if (started.isNew && !started.isOpened) {
    return `Posted to the whiteboard page, but the browser could not be opened: give the user this link: ${started.open.url}`
  }
  if (!posted.viewers) {
    return 'Posted, but no whiteboard page is open, so nobody has seen it yet. Tell the user that /whiteboard opens it.'
  }
  const opened = started.isNew ? ', which just opened in the browser' : ''
  if (!isDiagram) return `Posted to the whiteboard page${opened}.`
  if (posted.drawn) return `Drawn on the whiteboard page${opened}.`
  return `Posted to the whiteboard page${opened}; the page did not confirm the drawing in time.`
}

// ---------------------------------------------------------------- diagrams

/** A classDef's stroke colour and dash, for the legend's swatch. */
function classStyle(source: string, name: string): { stroke?: string; isDashed: boolean } | undefined {
  const def = new RegExp(`^\\s*classDef\\s+${name.replace(/[^\w-]/g, '')}\\s+([^\\n]+)`, 'm').exec(source)
  if (!def) return undefined
  const props = def[1] ?? ''
  const stroke = /(?:^|,)\s*stroke\s*:\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/.exec(props)?.[1]
  return { stroke, isDashed: /stroke-dasharray/.test(props) }
}

/** The legend Claude passed, at most six short entries, with the unknown classes it names. */
function legendOf(value: unknown, source: string): { legend?: Legend[]; unknown: string[] } {
  if (!Array.isArray(value)) return { unknown: [] }
  const entries = value
    .filter((x): x is { label: string; class: string } => typeof x?.label === 'string' && typeof x?.class === 'string')
    .map(x => ({ label: x.label.trim().slice(0, 40), class: x.class.trim() }))
    .filter(x => x.label && /^[\w-]+$/.test(x.class))
    .slice(0, 6)
  const unknown = entries.filter(x => !classStyle(source, x.class)).map(x => x.class)
  const legend = entries.map(x => ({ label: x.label, isDashed: false, ...classStyle(source, x.class) }))
  return { legend: legend.length ? legend : undefined, unknown }
}

/** Mermaid's message without the stack. */
function mermaidError(error: string): string {
  return error.replace(/\s+at\s.*$/s, '').trim().slice(0, 1200)
}

/** The diagram in a file: a fenced mermaid block in Markdown, or the whole file. */
function mermaidOf(text: string): string {
  const fence = /```mermaid\s*\n([\s\S]*?)```/.exec(text)
  return (fence?.[1] ?? text).trim()
}

const failed = (error: unknown) => `The whiteboard page could not start: ${error instanceof Error ? error.message : String(error)}`

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'whiteboard',
      description: 'A whiteboard page in your browser, beside the conversation: /whiteboard [focus|sample|file.mmd|file.md]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        "Post to the whiteboard: a page in the user's browser beside this conversation, where you draw and they " +
        'can answer. A card is a Mermaid diagram, a short Markdown note (paragraphs, bullets, **bold**, `code`), ' +
        'or both. Draw whenever a picture explains code or a system better than prose: architecture, data flow, ' +
        'call sequences, state machines, schemas. Any Mermaid 12 diagram type works, with classDef, themes and ' +
        'front-matter config; the page has browser zoom and scrolling, so size is not a problem. Each post adds a ' +
        'card below the last, so a sequence of posts tells a story. Before drawing, read the whiteboard:drawing ' +
        'skill. The first post opens the page in the browser. If Mermaid rejects the source, the call fails with ' +
        'its error and the card is taken off the page: fix the source and post again. ' +
        'Messages that begin "(on the whiteboard)" were typed by the user on the page: answer them there with ' +
        'this tool, and keep what you write in the conversation to a line. When they wrap up, write the summary in ' +
        'the conversation itself, then call this tool with end: true: the page says the discussion is over and closes.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short heading for the card' },
          text: { type: 'string', description: 'A note, in simple Markdown, above the diagram if there is one' },
          mermaid: { type: 'string', description: 'A Mermaid diagram, starting with the diagram type' },
          end: {
            type: 'boolean',
            description:
              'Only after the user wraps up and your summary is in the conversation: closes the page. `text` may ' +
              'carry one line for the page, such as where the summary is.',
          },
          legend: {
            type: 'array',
            maxItems: 6,
            description:
              "A key to the diagram's colours, drawn above it instead of inside it: " +
              'one entry per classDef the diagram uses, in reading order.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'What the colour means, in a few words' },
                class: { type: 'string', description: 'The name of a classDef in the diagram' },
              },
              required: ['label', 'class'],
            },
          },
        },
      },
    })
    return next(e)
  })

  // The page shows whether Claude is working, so a message sent there is
  // never met with silence.
  on('turn.start', async ($, e, next) => {
    void boardStatus($, 'working')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    void boardStatus($, 'idle')
    if (said.length) void deliver($)
    return done
  })

  on('tool.call', { tool: 'mcp__whiteboard__post_to_board' }, async ($, e) => {
    const text = typeof e.text === 'string' ? e.text.trim() : ''
    const mermaid = typeof e.mermaid === 'string' ? mermaidOf(e.mermaid) : ''
    if (e.end === true) {
      try {
        const isEnded = await endBoard($, text || undefined)
        return { result: isEnded ? 'The whiteboard page is closing; the discussion is over.' : 'No whiteboard page was open.' }
      } catch (error) {
        return { result: `The whiteboard page had already stopped (${error instanceof Error ? error.message : String(error)}).` }
      }
    }
    if (!text && !mermaid) return { deny: 'Nothing posted: give `text`, `mermaid` or both.' }
    if (!(await $.session.surfaces()).length) {
      return { deny: 'Nobody can see the whiteboard from this session (it has no screen attached). Explain in prose instead.' }
    }
    const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : undefined
    const { legend, unknown } = legendOf(e.legend, mermaid)
    let out: Awaited<ReturnType<typeof postToBoard>>
    try {
      out = await postToBoard($, { title, text: text || undefined, mermaid: mermaid || undefined, legend })
    } catch (error) {
      return { deny: failed(error) }
    }
    if (out.posted.error) {
      return {
        deny: `Mermaid could not draw this diagram:\n${mermaidError(out.posted.error)}\nIt was taken off the page. Fix the source and post again.`,
      }
    }
    const unknownNote = unknown.length ? ` The legend names classes with no classDef: ${unknown.join(', ')}.` : ''
    return { result: `${postedWhere(out, Boolean(mermaid))}${unknownNote}` }
  })

  on('command.run', { command: 'whiteboard' }, async ($, e) => {
    const arg = e.args.trim()
    const draw = async (d: Doc, said: string) => {
      try {
        const out = await postToBoard($, { title: d.title, mermaid: d.source })
        if (out.posted.error) return { text: `Mermaid could not draw ${d.title}: ${mermaidError(out.posted.error)}` }
        const where = out.started.isNew && !out.started.isOpened ? ` Open it in your browser: ${out.started.open.url}` : ''
        return { text: `${said} on the whiteboard page.${where}` }
      } catch (error) {
        return { text: failed(error) }
      }
    }
    if (!arg || arg === 'focus') {
      try {
        const started = await boardOpen($)
        // Asked for: open it again, in case the tab was closed.
        const isOpened = started.isNew ? started.isOpened : await openInBrowser($, started.open.url)
        const where = isOpened ? 'opened in your browser' : `open it in your browser: ${started.open.url}`
        if (arg === 'focus') return { text: `Whiteboard ${where}. Discuss there; Claude answers on the board.`, context: [FOCUS_NOTE] }
        return { text: `Whiteboard ${where}.` }
      } catch (error) {
        return { text: failed(error) }
      }
    }
    if (arg === 'sample') return draw(SAMPLE, 'Sample diagram drawn')
    let text: string
    try {
      text = await $.fs.read(arg)
    } catch (err) {
      return { text: `Couldn't read ${arg}: ${err instanceof Error ? err.message : String(err)}` }
    }
    const next = { title: arg.split('/').at(-1) ?? arg, source: mermaidOf(text) }
    const shown = await draw(next, `Diagram from ${arg} drawn`)
    return { ...shown, context: [`The diagram the user is looking at (Mermaid):\n${next.source}`] }
  })
}
