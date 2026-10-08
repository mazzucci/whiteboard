import type { EngineInterface, Register } from 'claude-code'

// The whiteboard is a page in the person's browser (board/server.mjs: Node's
// standard library, loopback only, a random token). Claude posts notes and
// Mermaid diagrams to it; the page draws them with the Mermaid vendored in
// board/vendor, and tells the plugin how each one drew, so Mermaid's errors
// come back to Claude. What the person types there is submitted into this
// session as their own words, so the whole discussion is in the conversation.

const TOOL = 'post_to_board'
const READ_TOOL = 'read_board'
const EDIT_TOOL = 'edit_board'

type Doc = { title: string; source: string }

const SAMPLE: Doc = {
  title: 'Sample: checkout',
  // Told to Claude with its node ids, so "the email box" is `mail` when the person asks about it.
  source: `flowchart LR
  shopper([Shopper]) --> web[Storefront]
  web --> api[Orders API]
  api --> pay{{Payment provider}}
  api --> db[(Orders DB)]
  api -. order placed .-> mail[Email service]`,
}

/**
 * Said to Claude once, with the session's first prompt: plugin tools may be
 * loaded only when Claude looks for one, so without this a plain "how does
 * OAuth work?" gets prose and no picture.
 */
const INTRO =
  `The whiteboard plugin is available: ${TOOL} draws Mermaid diagrams and notes on a page in the user's browser ` +
  'beside this conversation. Use it whenever a picture explains better than prose, in this project or not: how a ' +
  'protocol, standard or system works (OAuth, TLS, DNS), architecture, request flows, sequences, state machines, ' +
  'schemas, an investigation. Draw first, then keep your written answer short and point at the board. Read the ' +
  `whiteboard:drawing skill before the first diagram. ${READ_TOOL} reads back what is on the page, Mermaid source ` +
  'and sticky notes included, when the user talks about something there you did not draw in this conversation. ' +
  `The board has two modes: diagrams (yours, as drawn; each new one a tab) for explaining and investigating, and ` +
  'canvas (every diagram editable by both of you) for designing or brainstorming together; pick one with `mode` ' +
  `when you post, or the user switches. On a canvas, ${EDIT_TOOL} amends a diagram in place (add, connect, ` +
  'recolour, rename, remove boxes) instead of drawing it again.'
let isIntroduced = false

/** What Claude is told when the person switches the board to a canvas from the conversation. */
const CANVAS_NOTE =
  'The user switched the whiteboard to canvas mode: every diagram on it is editable by both of you. Their edits reach ' +
  `you in words with their messages; amend diagrams with ${EDIT_TOOL} instead of drawing them again, and draw a new ` +
  `one with ${TOOL} only when the picture changes as a whole.`

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
  nodeFound ??= findNode($).catch(error => {
    nodeFound = null
    throw error
  })
  return nodeFound
}
let nodeFound: Promise<string> | null = null

const NODE_MAJOR = 18

/** The first node 18 or later: on PATH, where installers put it, then where version managers do. */
async function findNode($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const dirs = [
    ...((await $.env.get('PATH')) ?? '').split(':').filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    ...(await managedNodeDirs($, home)),
  ]
  let tooOld = ''
  for (const dir of [...new Set(dirs)]) {
    const node = `${dir}/node`
    if (!(await $.fs.exists(node))) continue
    const version = await nodeVersion($, node)
    if (version.major >= NODE_MAJOR) return node
    tooOld ||= `${node} is ${version.text || 'an unknown version'}`
  }
  throw new Error(
    tooOld
      ? `The whiteboard needs Node.js ${NODE_MAJOR} or later; ${tooOld}. Install a newer one (nodejs.org, or your version manager).`
      : `Node.js was not found. The whiteboard runs a small local server with it: install Node.js ${NODE_MAJOR} or later (nodejs.org).`,
  )
}

/**
 * Where nvm, volta, fnm, asdf and mise keep node: their installs first, newest
 * version first (a shim may need a fuller PATH than the app gives), then their
 * shims and default aliases.
 */
async function managedNodeDirs($: EngineInterface, home: string): Promise<string[]> {
  if (!home) return []
  const installs = [
    `${home}/.nvm/versions/node`,
    `${home}/.asdf/installs/nodejs`,
    `${home}/.local/share/mise/installs/node`,
  ]
  const dirs: string[] = []
  for (const base of installs) dirs.push(...(await versionDirs($, base)).map(v => `${base}/${v}/bin`))
  return [
    ...dirs,
    `${home}/.volta/bin`,
    `${home}/.fnm/aliases/default/bin`,
    `${home}/.local/share/fnm/aliases/default/bin`,
    `${home}/Library/Application Support/fnm/aliases/default/bin`,
    `${home}/.asdf/shims`,
    `${home}/.local/share/mise/shims`,
  ]
}

/** The version folders in a version manager's install folder, newest first; links count. */
async function versionDirs($: EngineInterface, base: string): Promise<string[]> {
  try {
    return (await $.fs.list(base))
      .filter(e => (e.kind === 'dir' || e.isLink) && /^v?\d+/.test(e.name))
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    return []
  }
}

async function nodeVersion($: EngineInterface, node: string): Promise<{ major: number; text: string }> {
  try {
    const text = (await $.process.run([node, '--version'])).stdout.trim()
    return { major: Number(/^v(\d+)/.exec(text)?.[1] ?? 0), text }
  } catch {
    return { major: 0, text: '' }
  }
}

/** Starts the board for this session; its stdout carries the person's messages. */
function startBoard($: EngineInterface): Promise<Board> {
  const self: Promise<Board> = new Promise<Board>((resolve, reject) => {
    void (async () => {
      try {
        // Each session has its own board; its folder's name tells their tabs apart.
        const folder = ((await $.env.get('PWD')) ?? '').split('/').filter(Boolean).at(-1)
        const argv = [await nodePath($), `${$.plugin.root}/board/server.mjs`, ...(folder ? ['--label', folder] : [])]
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
/** How the person's words from the page start, in the conversation. */
const FROM_BOARD = '(on the whiteboard)'
/** Said beside each of them: they are looking at the page, not here. */
const BOARD_NOTE =
  `The user typed this on the whiteboard page and is watching the page, not this conversation: answer there with ${TOOL} ` +
  '(a note, a diagram, sticky notes), and keep what you write here to a line. When it is about a section of the brief ' +
  `("About the brief's section \`id\`"), answer under that section with ${EDIT_TOOL} ` +
  "(sections: [{ op: 'answer', id, text }]), and update the section's line, or the bottom line, if the answer changes it. " +
  "When it asks for more detail, write it as that section's body (sections: [{ op: 'update', id, body }]). " +
  '"My choices on the board: …" are what the user settled there, suggestions they took or turned down included: ' +
  'they are settled already (do not settle them again; anything the board could not settle is said after). Update ' +
  'the diagram and the brief for them, and once none is open, write your proposal as the bottom line. A message that ' +
  'starts "(On the side board `id`, …)" was typed there: answer on that board (it is where your posts go). ' +
  '"I decide on the side board …" has settled its constraint on the main board and brought the user back there: ' +
  'carry the decision into the main board (its line, the diagram).'
/** Said when the person, after talking on the page, types in the conversation again. */
const BACK_NOTE =
  'The user is back in this conversation: they typed this here, not on the whiteboard. Focus mode, if it was on, ' +
  `is over: answer here, and use ${TOOL} again only where a picture helps, as before.`
/** Whether the person's last words came from the page (or they asked for focus mode). */
let isOnBoard = false

/**
 * The turn answering a message from the page, while nothing of it has
 * reached the page: if it ends that way, its answer is posted there, so the
 * person never waits on a reply that went only to the conversation.
 */
let boardTurn: { turnId: string; isPosted: boolean } | null = null
let delivering: Promise<void> | null = null
/** One delivery at a time: a second caller waits on the first, so nothing is submitted twice. */
function deliver($: EngineInterface): Promise<void> {
  delivering ??= (async () => {
    try {
      while (said.length) {
        try {
          await $.prompt.submit({ text: `${FROM_BOARD} ${said[0]}`, asUser: true })
        } catch {
          return
        }
        said.shift()
      }
    } finally {
      delivering = null
    }
  })()
  return delivering
}

/** Posts the answer of a turn that came from the page and reached only the conversation. */
async function postAnswer($: EngineInterface, answer: string) {
  if (!board || !answer.trim()) return
  try {
    const open = await board
    await $.http.fetch(`http://127.0.0.1:${open.port}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-token': open.token },
      body: JSON.stringify({ text: answer.trim().slice(0, 20_000) }),
    })
  } catch {
    // The board stopped: the answer is in the conversation.
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

/**
 * Opens a URL in the person's browser: the command in $BROWSER when they set
 * one (the usual convention), else `open` on macOS and `xdg-open` elsewhere.
 */
async function openInBrowser($: EngineInterface, url: string): Promise<boolean> {
  const chosen = ((await $.env.get('BROWSER')) ?? '').split(':')[0]?.trim()
  if (chosen) {
    // `%s` stands for the URL, as in xdg-open's convention; words split on spaces.
    const parts = chosen.split(/\s+/).filter(Boolean)
    const argv = parts.includes('%s') ? parts.map(p => (p === '%s' ? url : p)) : [...parts, url]
    try {
      // The command must exist; then it starts detached, through sh with its
      // words as arguments (never as script), so it neither holds up the call
      // nor goes down with this plugin, which would close the person's browser.
      const found = await $.process.run(['/bin/sh', '-c', 'command -v "$1" >/dev/null 2>&1', 'sh', argv[0] ?? ''])
      if (found.exitCode !== 0) return false
      const started = await $.process.run(['/bin/sh', '-c', 'nohup "$@" >/dev/null 2>&1 </dev/null &', 'sh', ...argv])
      return started.exitCode === 0
    } catch {
      return false
    }
  }
  const opener = (await $.fs.exists('/usr/bin/open')) ? '/usr/bin/open' : 'xdg-open'
  try {
    return (await $.process.run([opener, url])).exitCode === 0
  } catch {
    return false
  }
}

/** A GET on the board, with its token: what it answers, as JSON. */
async function boardGet<T>($: EngineInterface, open: Board, path: string): Promise<T> {
  const res = await $.http.fetch(`http://127.0.0.1:${open.port}${path}`, { method: 'GET', headers: { 'x-board-token': open.token } })
  if (!res.ok) throw new Error(`the page answered ${res.status}`)
  return JSON.parse(res.text) as T
}

/** A POST to the board, with its token: what it answers, as JSON. */
async function boardPost<T>($: EngineInterface, open: Board, body: Record<string, unknown>): Promise<T> {
  const res = await $.http.fetch(`http://127.0.0.1:${open.port}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board-token': open.token },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`the page answered ${res.status}`)
  return JSON.parse(res.text) as T
}

/** How many pages are showing the board; 0 when the person closed its tab. */
async function viewersOf($: EngineInterface, open: Board): Promise<number> {
  try {
    return (await boardGet<{ viewers: number }>($, open, '/viewers')).viewers
  } catch {
    return 0
  }
}

/** Whether the browser was asked to open the board (`isTried`), and whether it did. */
type Started = { open: Board; isNew: boolean; isTried: boolean; isOpened: boolean }

/**
 * The board for this session, started on first use. It opens in the person's
 * browser when it is new, when no page is showing it (they closed the tab), or
 * always when they asked for it (`isAsked`); otherwise posts go to the tab
 * they have.
 */
async function boardOpen($: EngineInterface, isAsked = false): Promise<Started> {
  const isNew = !board
  board ??= startBoard($)
  const open = await board
  const isTried = isNew || isAsked || (await viewersOf($, open)) === 0
  return { open, isNew, isTried, isOpened: isTried && (await openInBrowser($, open.url)) }
}

type Legend = { label: string; stroke?: string; isDashed: boolean }
type Note = { on?: string; text: string }
type Card = { title?: string; text?: string; mermaid?: string; legend?: Legend[]; notes?: Note[]; mode?: Mode; brief?: BriefInput; isNew?: boolean; sideBoard?: { id: string; title?: string; for?: string }; board?: string }
type Mode = 'diagrams' | 'canvas'

/** Claude's sticky notes (`sticky_notes`), as the page takes them: text, and the node id each is pinned to. */
function notesOf(value: unknown): Note[] | undefined {
  if (!Array.isArray(value)) return undefined
  const notes = value
    .filter((n): n is { on?: unknown; text: string } => typeof n?.text === 'string' && n.text.trim() !== '')
    .map(n => ({ text: n.text.trim(), ...(typeof n.on === 'string' && n.on.trim() ? { on: n.on.trim() } : {}) }))
  return notes.length ? notes : undefined
}
/** How the page drew a diagram: drawn, Mermaid's error, or not seen (no page open, or it did not answer). */
type Posted = { ok: boolean; viewers: number; drawn: boolean; error?: string; noDiagram?: boolean; noteError?: string; noteErrors?: string[]; briefError?: string; boardError?: string; board?: string }

// ---------------------------------------------------------------- the brief

/** A section of the brief, as Claude writes it. */
type SectionInput = {
  id: string
  title?: string
  line: string
  body?: string
  focus?: string[]
  cites?: { label: string; url?: string }[]
  kind?: 'point' | 'constraint' | 'idea'
  choices?: { id: string; label: string; hint?: string }[]
  lean?: string
  status?: 'open' | 'assumed' | 'settled'
  by?: 'you'
  suggested?: boolean
}
type BriefInput = { bottomLine: string; sections: SectionInput[]; mode?: 'brief' | 'decide'; options?: { id: string; label: string; hint?: string }[] }
/** A section as the board holds it: with the person's questions and Claude's answers, the line it had before, and what was chosen. */
type Section = SectionInput & { was?: string; asks: { question?: string; answer?: string }[]; why?: string; chosen?: string; settledBy?: 'you' | 'claude' }
type Brief = { bottomLine: string; wasBottomLine?: string; mode?: 'brief' | 'decide'; options?: { id: string; label: string }[]; sections: Section[]; dropped: Section[] }
/** A board: the main one, or a side board opened from it for one question. */
type BoardInfo = { id: string; title?: string; for?: string; state: 'open' | 'decided' | 'parked' | 'dropped'; why?: string; brief: Brief | null }

/** Every board, as Claude reads them back: the one the user is on in full, the main board's lines, the rest in a line each. */
function boardsText(all: BoardInfo[], viewing: string): string {
  const main = all.find(b => b.id === 'main')
  const sides = all.filter(b => b.id !== 'main')
  const on = all.find(b => b.id === viewing) ?? main
  const parts: string[] = []
  if (on && on.id !== 'main') parts.push(`The user is on the side board \`${on.id}\`, "${on.title}"${on.for ? ` (opened to decide the main board's \`${on.for}\`)` : ''}. Your posts and edits go there unless you name another board.`)
  if (on?.brief) parts.push(briefText(on.brief, on.id === 'main' ? '' : ` on the side board \`${on.id}\``))
  if (on?.id !== 'main' && main?.brief) parts.push(briefText(main.brief, ' on the main board'))
  const others = sides.filter(b => b !== on)
  if (others.length) parts.push(`Side boards: ${others.map(b => `\`${b.id}\` "${b.title}" (${b.state}${b.for ? `, for ${b.for}` : ''}${b.why ? `: ${b.why}` : ''})`).join('; ')}`)
  return parts.join('\n\n')
}

/** Sections as given, kept to what the board takes; the server checks the rest. */
function sectionsOf(value: unknown): SectionInput[] {
  if (!Array.isArray(value)) return []
  return value.filter((s): s is SectionInput => !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.line === 'string')
}

/** A constraint's state, an idea's or a suggestion's, in a few words before its line. */
function stateOf(s: Section): string {
  const label = (id?: string) => s.choices?.find(c => c.id === id)?.label ?? id
  if (s.suggested) return `[your suggestion, not yet taken${s.choices?.length ? `; choices ${s.choices.map(c => c.id).join(', ')}` : ''}] `
  if (s.kind === 'idea') return `[idea${s.by === 'you' ? ' from the user' : ''}] `
  if (s.kind !== 'constraint') return ''
  const options = s.choices?.length ? `; choices ${s.choices.map(c => c.id).join(', ')}` : ''
  if (s.status === 'settled') return `[settled by ${s.settledBy === 'you' ? 'the user' : 'you'}: ${label(s.chosen) ?? 'yes'}] `
  const mine = s.by === 'you' ? '; the user\'s' : ''
  return `[${s.status === 'assumed' ? `assumed${s.lean ? `: ${label(s.lean)}` : ''}` : 'open'}${options}${s.lean && s.status !== 'assumed' ? `; you lean ${s.lean}` : ''}${mine}] `
}

/** The brief as Claude reads it back: the bottom line and each section's line, never the bodies. */
function briefText(b: Brief, where = ''): string {
  const open = (s: Section) => s.asks.filter(a => a.question && !a.answer).length
  const lines = [
    `The brief${where} beside the diagrams (each section by id: its line; bodies and answers left out):`,
    ...(b.options?.length ? [`A comparison of: ${b.options.map(o => `\`${o.id}\` ${o.label}`).join(', ')}`] : []),
    `Bottom line: ${b.bottomLine}`,
    ...b.sections.map(s => {
      const waiting = open(s)
      return `- \`${s.id}\` ${stateOf(s)}${s.title && s.title !== s.id ? `${s.title}: ` : ''}${s.line}${s.focus?.length ? ` (on ${s.focus.join(', ')})` : ''}${waiting ? ` — ${waiting} question${waiting === 1 ? '' : 's'} from the user waiting for an answer` : ''}`
    }),
  ]
  if (b.mode === 'decide') {
    const open = b.sections.filter(s => s.kind === 'constraint' && s.status === 'open' && !s.suggested)
    lines.splice(1, 0, `A decision: ${open.length ? `${open.length} constraint${open.length === 1 ? '' : 's'} still open (${open.map(s => s.id).join(', ')}); propose the design once none is` : 'every constraint is settled: the bottom line should be the proposal'}.`)
  }
  if (b.dropped.length) lines.push(`Dropped: ${b.dropped.map(s => `\`${s.id}\`${s.why ? ` (${s.why})` : ''}`).join(', ')}`)
  return lines.join('\n')
}

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
  if (started.isTried && !started.isOpened) {
    return `Posted to the whiteboard page, but the browser could not be opened: give the user this link: ${started.open.url}`
  }
  if (!posted.viewers && !started.isOpened) {
    return 'Posted, but no whiteboard page is open, so nobody has seen it yet. Tell the user that /whiteboard opens it.'
  }
  const opened = started.isNew
    ? ', which just opened in the browser'
    : started.isOpened
      ? ', which opened again in the browser (its tab had been closed)'
      : ''
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

/** An edited diagram's canvas, as the page summarizes it. */
type Scene = {
  boxes?: { ref: string; text: string; class: string }[]
  notes?: { ref: string; text: string; on?: string }[]
  arrows?: { from: string | null; to: string | null; text: string }[]
  texts?: { text: string; near: string | null }[]
  drawings?: { near: string | null }[]
  images?: number
  selected?: string[]
}

/** A canvas in lines: every box by its ref, the arrows between them, notes, text and drawings. */
function sceneText(s: Scene): string[] {
  const q = (t: string) => `"${t.replace(/\s+/g, ' ').trim()}"`
  const lines = ['Edited on the canvas; as it is now (the Mermaid above is where it started; amend it with edit_board):']
  for (const b of s.boxes ?? []) lines.push(`- box \`${b.ref}\` ${q(b.text)}${b.class !== 'plain' ? ` (${b.class})` : ''}`)
  for (const a of s.arrows ?? []) lines.push(`- arrow ${a.from ? `\`${a.from}\`` : '(loose)'} → ${a.to ? `\`${a.to}\`` : '(loose)'}${a.text ? ` ${q(a.text)}` : ''}`)
  for (const n of s.notes ?? []) lines.push(`- sticky note \`${n.ref}\`${n.on ? ` by \`${n.on}\`` : ''}: ${q(n.text)}`)
  for (const t of s.texts ?? []) lines.push(`- text ${q(t.text)}${t.near ? ` near \`${t.near}\`` : ''}`)
  const drawn = s.drawings?.length ?? 0
  if (drawn) lines.push(`- ${drawn} freehand mark${drawn === 1 ? '' : 's'} (only a picture shows them: ${READ_TOOL} with image: true)`)
  if (s.selected?.length) lines.push(`- selected on the page now: ${s.selected.join(', ')}`)
  if (s.images) lines.push(`- ${s.images} pasted image${s.images === 1 ? '' : 's'} (not in pictures yet: ask the user what they show)`)
  return lines
}

type BoardCard = {
  id: number
  board?: string
  kind: 'diagram' | 'note' | 'sticky' | 'you' | 'end'
  title?: string
  text?: string
  mermaid?: string
  notes?: Note[]
  on?: string
  diagram?: number
}

/** A sticky note, as Claude reads it back. */
const noteLine = (n: Note) => `- sticky note${n.on ? ` on ${n.on}` : ''}: ${n.text}`

/** The board as Claude reads it back: every card in order, diagrams with their source and sticky notes. */
function boardText(viewers: number, cards: BoardCard[], isLatest: boolean, scenes: Record<string, Scene> = {}, mode: Mode = 'diagrams', brief: Brief | null = null): string {
  const said = boardCardsText(viewers, cards, isLatest, scenes, mode)
  return brief ? `${said}\n\n${briefText(brief)}` : said
}

function boardCardsText(viewers: number, cards: BoardCard[], isLatest: boolean, scenes: Record<string, Scene>, mode: Mode): string {
  const diagrams = cards.filter(c => c.kind === 'diagram')
  // Diagrams are numbered on their own board, as the page's tabs are.
  const boardOf = (c: BoardCard) => c.board ?? 'main'
  const onItsBoard = (c: BoardCard) => diagrams.filter(d => boardOf(d) === boardOf(c))
  const stickiesOf = (id: number) => cards.filter(c => c.kind === 'sticky' && c.diagram === id).map(c => noteLine({ on: c.on, text: c.text ?? '' }))
  const diagramText = (c: BoardCard) => {
    const n = onItsBoard(c).indexOf(c) + 1
    const scene = scenes[String(c.id)]
    // An edited diagram's notes are on its canvas.
    const notes = scene ? [] : [...(c.notes ?? []).map(noteLine), ...stickiesOf(c.id)]
    return [
      `Diagram ${n} of ${onItsBoard(c).length}${boardOf(c) !== 'main' ? ` on the side board \`${boardOf(c)}\`` : ''}${c.title ? `, "${c.title}"` : ''}:`,
      ...(c.text ? [c.text] : []),
      '```mermaid',
      c.mermaid ?? '',
      '```',
      ...notes,
      ...(scene ? sceneText(scene) : []),
    ].join('\n')
  }
  const seen = `${viewers ? `open in ${viewers === 1 ? 'one tab' : `${viewers} tabs`}` : 'not open in any tab'}; ${mode === 'canvas' ? `canvas mode: every diagram is editable, amend with ${EDIT_TOOL}` : 'diagrams mode'}`
  if (isLatest) {
    const last = diagrams.at(-1)
    return last ? `The whiteboard page (${seen}); its latest diagram:\n\n${diagramText(last)}` : `The whiteboard page (${seen}) has no diagram yet.`
  }
  const parts = cards.flatMap(c =>
    c.kind === 'diagram'
      ? [diagramText(c)]
      : c.kind === 'note' && c.text
        ? [`Your note${c.title ? `, "${c.title}"` : ''}: ${c.text}`]
        : c.kind === 'you' && c.text
          ? [`The user wrote: ${c.text}`]
          : [],
  )
  return parts.length ? `The whiteboard page (${seen}), oldest first:\n\n${parts.join('\n\n')}` : `The whiteboard page (${seen}) is empty.`
}

const KEYWORDS = new Set(['flowchart', 'graph', 'subgraph', 'end', 'classDef', 'class', 'style', 'linkStyle', 'click', 'direction'])
/** The node ids a diagram's Mermaid names with a shape (`api[...]`, `db[(...)]`, `x{...}`), or its participants. */
function nodeIdsOf(source: string): Set<string> {
  const ids = new Set<string>()
  for (const m of source.matchAll(/(?:^|[\s;&|>-])([A-Za-z_][\w.-]*?)\s*(?:\[|\(|\{|>(?![>-]))/gm)) if (!KEYWORDS.has(m[1] ?? '')) ids.add(m[1] ?? '')
  for (const m of source.matchAll(/^\s*(?:participant|actor)\s+([\w.-]+)/gm)) ids.add(m[1] ?? '')
  return ids
}

/**
 * The diagram already on the board that a new one mostly redraws (60% of
 * their boxes in common), when it is editable: any on a canvas board, an
 * edited one on a drawing board. Claude amends that one instead, keeping the
 * person's layout. Null when there is none.
 */
async function redrawnOnCanvas($: EngineInterface, mermaid: string): Promise<string | null> {
  if (!board) return null
  let read: { mode?: Mode; cards: BoardCard[]; scenes?: Record<string, Scene> }
  try {
    read = await boardGet($, await board, '/cards')
  } catch {
    return null
  }
  const fresh = nodeIdsOf(mermaid)
  if (fresh.size < 2) return null
  const diagrams = read.cards.filter(c => c.kind === 'diagram')
  for (const c of diagrams) {
    // Numbered on its own board, as edit_board takes it.
    const i = diagrams.filter(d => (d.board ?? 'main') === (c.board ?? 'main')).indexOf(c)
    const where = (c.board ?? 'main') !== 'main' ? ` on the side board \`${c.board}\`` : ''
    const scene = read.scenes?.[String(c.id)]
    // On a drawing board only an edited diagram is amended; the rest are a story told in tabs.
    if (read.mode !== 'canvas' && !scene) continue
    const old = scene?.boxes ? new Set(scene.boxes.map(b => b.ref)) : nodeIdsOf(c.mermaid ?? '')
    const common = [...fresh].filter(id => old.has(id))
    if (old.size >= 2 && common.length >= 0.6 * Math.max(fresh.size, old.size)) {
      return (
        `${read.mode === 'canvas' ? 'The board is a canvas, and d' : 'D'}iagram ${i + 1}${where}${c.title ? ` "${c.title}"` : ''}${scene ? ', edited on the board,' : ''} already shows these boxes ` +
        `(${common.slice(0, 6).map(id => `\`${id}\``).join(', ')}${common.length > 6 ? ', …' : ''}). Amend it with ${EDIT_TOOL} ` +
        '(class or color to recolour as the evidence comes in, text to update a label, add, connect, remove): that keeps ' +
        'the layout the user may have arranged. If you mean a separate diagram, post again with as_new: true.'
      )
    }
  }
  return null
}

const failed = (error: unknown) => `The whiteboard page could not start: ${error instanceof Error ? error.message : String(error)}`

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'whiteboard',
      description: 'A whiteboard page in your browser, beside the conversation: /whiteboard [focus|canvas|sample|file.mmd|file.md]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        "Post to the whiteboard: a page in the user's browser beside this conversation, where you draw and they " +
        'can answer. A card is a Mermaid diagram, a short Markdown note (paragraphs, bullets, **bold**, `code`), ' +
        'or both. Draw whenever a picture explains something better than prose, in this project or not: how a ' +
        'protocol, standard or system works (OAuth, TLS, DNS, a consensus algorithm), architecture, data flow, call ' +
        'sequences, state machines, schemas. A "how does X work?" question is one: draw the flow, and keep your ' +
        'answer in the conversation short, pointing at the board. Any Mermaid 12 diagram type works, with ' +
        'classDef, themes and front-matter config; the page has zoom and panning, so size is not a problem. Each ' +
        'diagram becomes a tab, so a sequence of posts tells a story. Before drawing, read the whiteboard:drawing ' +
        'skill. The first post opens the page in the browser. If Mermaid rejects the source, the call fails with ' +
        'its error and the card is taken off the page: fix the source and post again. ' +
        'Sticky notes (`sticky_notes`) add a short note without changing the diagram: a proposal, a question or ' +
        'an aside. With `on` (a node id in the Mermaid source) a note sits beside that flowchart box, or on a ' +
        "chart's slice, bar or point named by its label; in other diagram types, or without `on`, notes line up " +
        'beside the diagram. Charts (pie, xychart-beta, quadrantChart) are clickable: what the user selects comes ' +
        'with their message ("Selected on the board, in …: the slice …"). Whenever you have a fix or a ' +
        'change to propose, pin it as a sticky note on the box it changes and ask on the board (in `text`) whether ' +
        'the user wants to see it; redraw the diagram with the change only once they say so. With a `mermaid` notes ' +
        'go on that diagram; without one, on the latest diagram. ' +
        'A brief (`bottom_line` and `sections`) sits beside the diagrams: the answer first, then up to nine ' +
        'one-line sections the user can open, question and steer, each pointing at the boxes it is about (`focus`). ' +
        `Post it once, with the diagram it explains, then change it in place with ${EDIT_TOOL} as the conversation ` +
        'goes on (see the drawing skill, "Briefs"). For a design or a choice still to make, post it with ' +
        "`brief_mode: 'decide'`: constraints with choices the user settles on the page, then your proposal " +
        '(the drawing skill, "Deciding"). ' +
        'Messages that begin "(on the whiteboard)" were typed by the user on the page: answer them there with ' +
        'this tool, and keep what you write in the conversation to a line. When they wrap up, write the summary in ' +
        'the conversation itself, then call this tool with end: true: the page says the discussion is over and closes.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short heading for the card' },
          text: { type: 'string', description: 'A note, in simple Markdown, above the diagram if there is one' },
          mermaid: { type: 'string', description: 'A Mermaid diagram, starting with the diagram type' },
          as_new: {
            type: 'boolean',
            description:
              `true to post a diagram as a new one even though it shares most boxes with one on a canvas (otherwise amend that one with ${EDIT_TOOL}), ` +
              `or a brief on another subject when one is on the board (otherwise change that one with ${EDIT_TOOL})`,
          },
          bottom_line: {
            type: 'string',
            description: 'A brief: the answer or verdict first, in one or two sentences of inline Markdown. With `sections`.',
          },
          brief_mode: {
            type: 'string',
            enum: ['brief', 'decide'],
            description: "brief (default): an explanation or a summary. decide: a design or a choice still to make: constraints first, settled on the page, then your proposal",
          },
          side_board: {
            type: 'object',
            description:
              'Open a side board for one question (when the user says "let\'s whiteboard this", or agrees to your offer): ' +
              'the rest of this post (its brief, its diagram) goes on it, and the user is taken there. `for`: the main ' +
              "board's constraint it decides; its decision settles that one. At most three open. A parked side board opens again " +
              'with its id alone (its brief as it was), or with a new brief.',
            properties: { id: { type: 'string' }, title: { type: 'string' }, for: { type: 'string', description: "The main board's constraint id this side board decides" } },
            required: ['id', 'title'],
          },
          board: { type: 'string', description: "Which board this goes on: 'main' or a side board's id (default: the one the user is looking at)" },
          options: {
            type: 'array',
            maxItems: 4,
            description: "A comparison (on a side board): the options compared, as columns; each section is a criterion, with `cells`. Pick the ids of the main board constraint's choices when they match",
            items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' } }, required: ['id', 'label'] },
          },
          sections: {
            type: 'array',
            maxItems: 9,
            description: "A brief's sections, in reading order: each one line the user can open, question or have you change",
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A short, stable id (letters, digits, - and _): how you and the user name it later' },
                title: { type: 'string', description: 'A label of one to three words' },
                line: { type: 'string', description: 'The section in one line of inline Markdown (under 160 characters)' },
                body: { type: 'string', description: 'More detail, in simple Markdown: only when asked for, or when the line cannot stand alone' },
                focus: { type: 'array', items: { type: 'string' }, description: "What on the diagram this section is about: flowchart node ids, sequence participant ids, or chart labels. They light up when the user points at it" },
                kind: { type: 'string', enum: ['point', 'constraint', 'idea'], description: 'point (default); constraint: a question to settle before the design (with `choices`); idea: one not yet weighed' },
                choices: { type: 'array', maxItems: 4, description: 'A constraint: its options, each `id` and a short `label` (`hint`: a few words more)', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' } }, required: ['id', 'label'] } },
                lean: { type: 'string', description: 'A constraint: the choice id you would pick, shown as your lean' },
                status: { type: 'string', enum: ['open', 'assumed'], description: 'A constraint: open (default), or assumed (your guess, on `lean`, for the user to confirm)' },
                by: { type: 'string', enum: ['you'], description: "'you' when the section is the user's own idea" },
                suggested: { type: 'boolean', description: 'true for a section you suggest: the user takes it or not' },
                cells: {
                  type: 'object',
                  description: 'A criterion in a comparison: by option id, `mark` (yes, part, no, unknown) and `text` (one short clause). A mark without a source is your judgement: cite one where it is a fact',
                  additionalProperties: { type: 'object', properties: { mark: { type: 'string', enum: ['yes', 'part', 'no', 'unknown'] }, text: { type: 'string' } } },
                },
                cites: {
                  type: 'array',
                  maxItems: 4,
                  description: 'Where it comes from: a spec, a doc, a file',
                  items: {
                    type: 'object',
                    properties: { label: { type: 'string', description: 'e.g. "RFC 7636" or "src/auth.ts:42"' }, url: { type: 'string', description: 'A web address, when there is one' } },
                    required: ['label'],
                  },
                },
              },
              required: ['id', 'line'],
            },
          },
          mode: {
            type: 'string',
            enum: ['diagrams', 'canvas'],
            description:
              'How the board works from now on: diagrams (yours, as drawn; each new one a tab: for explaining and ' +
              'investigating) or canvas (every diagram editable by both of you, amended in place: for designing or ' +
              'brainstorming together). Set it with your first post when the conversation calls for one; the user ' +
              'can switch it on the page.',
          },
          sticky_notes: {
            type: 'array',
            maxItems: 8,
            description: 'Sticky notes pinned beside boxes: a proposal, a question, an aside. Without `mermaid`, they go on the latest diagram.',
            items: {
              type: 'object',
              properties: {
                on: { type: 'string', description: "The node id of the flowchart box it is about, or the label of a chart's slice, bar or point, as written in the Mermaid source" },
                text: { type: 'string', description: 'The note: a line or two of inline Markdown' },
              },
              required: ['text'],
            },
          },
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
    await $.tool.register({
      name: READ_TOOL,
      description:
        "Read back what is on this session's whiteboard page: each diagram's Mermaid source (so its node ids), " +
        'its sticky notes, your notes, and what the user typed there, oldest first. Use it when the user talks ' +
        'about something on the board that you did not draw in this conversation (a /whiteboard sample or file ' +
        'they opened, or anything from before the conversation was summarized), or to check what a diagram says ' +
        `before changing it with ${TOOL}.`,
      inputSchema: {
        type: 'object',
        properties: {
          latest: { type: 'boolean', description: 'Only the latest diagram, with its sticky notes' },
          board: { type: 'string', description: "With `image` and `diagram`: the board the diagram is on, 'main' or a side board's id (default: the one the user is looking at)" },
          image: {
            type: 'boolean',
            description:
              'Also a picture of one diagram (the latest edited, else the latest, unless `diagram` says): for what words ' +
              'cannot carry, such as freehand marks the user drew or where things sit',
          },
          diagram: { type: 'integer', description: 'With `image`: which diagram, by its number on the board (1 is the first)' },
        },
      },
    })
    await $.tool.register({
      name: EDIT_TOOL,
      description:
        'Amend a diagram on the whiteboard in place, keeping everything else as it is, the layout the user arranged ' +
        `included, instead of drawing it again with ${TOOL}. Use it for changes to a diagram already on the board, ` +
        'above all one the user has edited (their changes reach you as "I changed … on the board"): add a box beside ' +
        'another, connect or disconnect two, rename one, recolour one with a drawing-skill class, remove one, or pin a ' +
        `sticky note. Text on the canvas is plain, no Markdown. Boxes are named by their ref: the node id from the ` +
        `Mermaid, or the ref ${READ_TOOL} shows for a ` +
        'box the user drew. A diagram that has not been edited yet becomes editable on the board when you amend it. ' +
        `Draw a new diagram with ${TOOL} when the picture changes as a whole. ` +
        'It also changes the brief in place (`sections`, `bottom_line`): answer a question the user asked about a ' +
        'section under that section, rewrite a line when what you learned changes it (the user sees the old one ' +
        'struck through), add a section for a new idea, drop one that no longer matters, with why.',
      inputSchema: {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            description: 'Changes to the brief, applied in order; each one that fails is reported and the rest still apply',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['add', 'update', 'drop', 'restore', 'answer', 'settle', 'reopen'],
                  description:
                    'add: a new section `id` with `line` (title, body, focus, cites; `after`: the id it goes after). ' +
                    'update: new `line`, `title`, `body`, `focus`, `cites`, `kind`, `choices`, `lean`, `status` (open or assumed), ' +
                    '`suggested: false` (the user took your suggestion in words) or `by` for section `id` (give only what changes; ' +
                    'an empty body, focus or cites clears it). drop: take section `id` out, saying `why`; it is listed as dropped. ' +
                    'restore: bring a dropped one back, at the end. ' +
                    "answer: `text` under section `id`, answering the user's oldest unanswered question there (a note under it when there is none). " +
                    'settle: settle constraint `id` on `choice` (when the user decided in words; their clicks on the page settle it already). ' +
                    'reopen: open a settled constraint again.',
                },
                id: { type: 'string' },
                title: { type: 'string' },
                line: { type: 'string' },
                body: { type: 'string' },
                focus: { type: 'array', items: { type: 'string' } },
                cites: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label'] } },
                after: { type: 'string', description: 'add: the id of the section it goes after (default: last)' },
                why: { type: 'string', description: 'drop: why it no longer matters, in a few words' },
                text: { type: 'string', description: 'answer: the answer, in simple Markdown' },
                kind: { type: 'string', enum: ['point', 'constraint', 'idea'] },
                choices: { type: 'array', maxItems: 4, description: 'A constraint: its options, each `id` and a short `label` (`hint`: a few words more)', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' } }, required: ['id', 'label'] } },
                lean: { type: 'string' },
                status: { type: 'string', enum: ['open', 'assumed'] },
                by: { type: 'string', enum: ['you'] },
                suggested: { type: 'boolean' },
                choice: { type: 'string', description: 'settle: the choice id' },
                cells: { type: 'object', description: 'A criterion in a comparison: by option id, { mark, text }; only the options given change' },
              },
              required: ['op', 'id'],
            },
          },
          bottom_line: { type: 'string', description: "The brief's new bottom line, when what you learned changes it (in a decision: your proposal, once every constraint is settled)" },
          brief_mode: { type: 'string', enum: ['brief', 'decide'], description: 'Turn the brief into a decision (decide) when the user starts choosing, or back; say so when you do' },
          board: { type: 'string', description: "Which board's brief or diagrams to change: 'main' or a side board's id (default: the one the user is looking at); diagrams are numbered on their own board" },
          side_board: {
            type: 'object',
            description:
              "Done with a side board: return (with `choice`, one of its options: that settles the main board's constraint it was opened for), " +
              'park (for later) or drop (with `why`). The user is back on the main board.',
            properties: { op: { type: 'string', enum: ['return', 'park', 'drop'] }, id: { type: 'string' }, choice: { type: 'string' }, why: { type: 'string' } },
            required: ['op', 'id'],
          },
          diagram: { type: 'integer', description: 'Which diagram, by its number on the board (1 is the first); default: the latest edited one, else the latest' },
          look: { type: 'boolean', description: 'false: no picture of the result (one comes back by default, small)' },
          ops: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            description: 'The amendments, applied in order; each one that fails is reported and the rest still apply',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: ['add', 'connect', 'disconnect', 'text', 'class', 'color', 'remove', 'note'],
                  description:
                    'add: a box `id` with `text` (near: a box to put it beside, joined to it by an arrow unless connect: false; side: right, below, left or above; class; shape: rectangle, ellipse or diamond). connect / disconnect: an arrow `from` → `to` (label). text: new `text` for box `id`. class: recolour box `id` with an evidence class (unverified, fine, problem, proposed, suspect, plain). color: any other colour for box `id`: `color` a name (blue, green, red, orange, yellow, purple, pink, teal, grey, white, black) or #hex, or `fill`, `stroke`, `ink` (text) in #hex; add takes these too. remove: box `id` and its arrows. note: a sticky note `id` with `text`, `on` a box.',
                },
                id: { type: 'string', description: "The box's ref (for add and note: a new, short ref)" },
                text: { type: 'string' },
                near: { type: 'string', description: 'add: the ref of the box to put it beside' },
                side: { type: 'string', enum: ['right', 'below', 'left', 'above'] },
                connect: { type: 'boolean', description: 'add: false for no arrow from `near`' },
                shape: { type: 'string', enum: ['rectangle', 'ellipse', 'diamond'] },
                class: { type: 'string', enum: ['unverified', 'fine', 'problem', 'proposed', 'suspect', 'plain'] },
                color: { type: 'string', description: 'color (or add): a colour name or #hex' },
                fill: { type: 'string', description: 'color (or add): the fill, #hex' },
                stroke: { type: 'string', description: 'color (or add): the border, #hex' },
                ink: { type: 'string', description: 'color (or add): the text, #hex' },
                from: { type: 'string' },
                to: { type: 'string' },
                label: { type: 'string', description: 'connect (or add with near): text on the arrow' },
                on: { type: 'string', description: 'note: the ref of the box it is about' },
              },
              required: ['op'],
            },
          },
        },
      },
    })
    return next(e)
  })

  // Never in the way of the prompt: anything going wrong here sends it on as typed.
  on('prompt.submit', async ($, e, next) => {
    if (e.text.startsWith(FROM_BOARD)) {
      isOnBoard = true
      return next({ ...e, context: [...(e.context ?? []), BOARD_NOTE] })
    }
    // Typed here after talking there: they are back, and Claude answers here.
    if (isOnBoard && ['composer', 'bridge', 'sdk'].includes(e.origin?.kind)) {
      isOnBoard = false
      return next({ ...e, context: [...(e.context ?? []), BACK_NOTE] })
    }
    if (isIntroduced) return next(e)
    let hasScreen = false
    try {
      hasScreen = (await $.session.surfaces()).length > 0
    } catch {
      // Unknown: say nothing this time.
    }
    if (!hasScreen) return next(e)
    isIntroduced = true
    return next({ ...e, context: [...(e.context ?? []), INTRO] })
  })

  // The page shows whether Claude is working, so a message sent there is
  // never met with silence.
  on('turn.start', async ($, e, next) => {
    boardTurn = e.text.startsWith(FROM_BOARD) ? { turnId: e.turnId, isPosted: false } : null
    void boardStatus($, 'working')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && boardTurn?.turnId === e.turnId) {
      if (!boardTurn.isPosted && e.reason === 'answer') await postAnswer($, e.answer)
      boardTurn = null
    }
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
    const notes = notesOf(e.sticky_notes)
    const sections = sectionsOf(e.sections)
    const given = Array.isArray(e.sections) ? e.sections.length : 0
    if (sections.length < given) {
      const bad = (e.sections as unknown[]).findIndex(s => !sectionsOf([s]).length) + 1
      return { deny: `Each section needs an \`id\` and a \`line\`: section #${bad} does not. Nothing was posted.` }
    }
    const bottomLine = typeof e.bottom_line === 'string' ? e.bottom_line.trim() : ''
    if (sections.length && !bottomLine) return { deny: 'A brief starts with its bottom line: give `bottom_line` with the sections.' }
    const options = Array.isArray(e.options) ? (e.options as { id: string; label: string }[]) : undefined
    const brief = bottomLine ? { bottomLine, sections, ...(e.brief_mode === 'decide' ? { mode: 'decide' as const } : {}), ...(options?.length ? { options } : {}) } : undefined
    const sideBoard = e.side_board && typeof e.side_board === 'object' ? (e.side_board as { id: string; title?: string; for?: string }) : undefined
    const onBoard = typeof e.board === 'string' ? e.board : undefined
    if (!text && !mermaid && !notes && !e.mode && !brief) return { deny: 'Nothing posted: give `text`, `mermaid`, `sticky_notes`, a brief, or a mix.' }

    if (!(await $.session.surfaces()).length) {
      return { deny: 'Nobody can see the whiteboard from this session (it has no screen attached). Explain in prose instead.' }
    }
    const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : undefined
    // On a canvas, the same diagram again is an amendment, not a new tab.
    if (mermaid && e.as_new !== true) {
      const redrawn = await redrawnOnCanvas($, mermaid)
      if (redrawn) return { deny: redrawn }
    }
    const { legend, unknown } = legendOf(e.legend, mermaid)
    let out: Awaited<ReturnType<typeof postToBoard>>
    try {
      const mode = e.mode === 'canvas' || e.mode === 'diagrams' ? e.mode : undefined
      out = await postToBoard($, { title, text: text || undefined, mermaid: mermaid || undefined, legend, notes, mode, brief, ...(e.as_new === true ? { isNew: true } : {}), ...(sideBoard ? { sideBoard } : {}), ...(onBoard ? { board: onBoard } : {}) })
    } catch (error) {
      return { deny: failed(error) }
    }
    if (out.posted.briefError === 'a brief is on the board already') {
      return {
        deny:
          `A brief is on the board already: change it in place with ${EDIT_TOOL} (sections: add, update, drop, restore, ` +
          'answer; bottom_line), which keeps what the user has read and asked there. Post with as_new: true only for a ' +
          'brief on another subject. Nothing was posted.',
      }
    }
    if (out.posted.briefError) return { deny: `The board could not take this brief: ${out.posted.briefError}. Nothing was posted.` }
    if (out.posted.boardError) return { deny: `The board could not do that: ${out.posted.boardError}. Nothing was posted.` }
    if (out.posted.error) {
      return {
        deny: `Mermaid could not draw this diagram:\n${mermaidError(out.posted.error)}\nIt was taken off the page${brief ? ', and the brief with it' : ''}. Fix the source and post again${brief ? ', brief and all' : ''}.`,
      }
    }
    if (out.posted.noDiagram) return { deny: 'No diagram on the board to pin these sticky notes to: post the diagram with them.' }
    if (out.posted.noteError) return { deny: `The board could not pin these sticky notes: ${out.posted.noteError}.` }
    if (!text && !mermaid && !notes && !brief) return { result: `The whiteboard is in ${e.mode} mode now.` }
    if (boardTurn) boardTurn.isPosted = true
    // Notes whose box is not on the canvas: the rest of the post is on the board.
    const notPinned = out.posted.noteErrors?.length ? ` Not pinned: ${out.posted.noteErrors.join('; ')}.` : ''
    const unknownNote = unknown.length ? ` The legend names classes with no classDef: ${unknown.join(', ')}.` : ''
    const briefNote = brief
      ? sideBoard
        ? ` The side board "${sideBoard.title ?? sideBoard.id}" is open and the user is on it: answer there; when it is decided (the user picks an option on the page, or you ${EDIT_TOOL} side_board return), they are back on the main board.`
        : ` The brief is beside the diagrams with ${sections.length} section${sections.length === 1 ? '' : 's'}: from now on change it in place with ${EDIT_TOOL}.`
      : ''
    // Where it went: the board the user is on, unless named.
    const onSide = out.posted.board && out.posted.board !== 'main' ? ` It went on the side board \`${out.posted.board}\`.` : ''
    return { result: `${postedWhere(out, Boolean(mermaid))}${onSide}${briefNote}${notPinned}${unknownNote}` }
  })

  on('tool.call', { tool: `mcp__whiteboard__${READ_TOOL}` }, async ($, e) => {
    if (!board) return { result: 'There is no whiteboard page in this session yet (or the last one was wrapped up): nothing is on it.' }
    let text: string
    let open: Board
    try {
      open = await board
      const read = await boardGet<{ viewers: number; cards: BoardCard[]; scenes?: Record<string, Scene>; mode?: Mode; brief?: Brief | null; boards?: BoardInfo[]; viewing?: string }>($, open, '/cards')
      text = boardText(read.viewers, read.cards, e.latest === true, read.scenes, read.mode, read.brief ?? null)
      // Side boards: the one the user is on in full, the main board's lines, the rest in a line each.
      if (read.boards?.some(b => b.id !== 'main')) text = `${boardCardsText(read.viewers, read.cards, e.latest === true, read.scenes ?? {}, read.mode ?? 'diagrams')}\n\n${boardsText(read.boards, read.viewing ?? 'main')}`
    } catch (error) {
      return { result: `The whiteboard page has stopped (${error instanceof Error ? error.message : String(error)}): nothing to read.` }
    }
    if (e.image !== true) return { result: text }
    // A picture as well, from the page: the image goes to Claude with the words.
    const shot = await boardPost<{ ok: boolean; png?: string; diagram?: string; error?: string }>($, open, {
      snapshot: true,
      ...(Number.isInteger(e.diagram) ? { diagram: e.diagram } : {}),
      ...(typeof e.board === 'string' ? { board: e.board } : {}),
    }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }) as { ok: boolean; png?: string; diagram?: string; error?: string })
    if (!shot.png) return { result: `${text}\n\n(No picture: ${shot.error ?? 'the page did not send one'}.)` }
    return {
      result: [
        { type: 'text', text: `${text}\n\nThe picture below is "${shot.diagram ?? ''}" as it is on the page.` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot.png } },
      ],
    }
  })

  on('tool.call', { tool: `mcp__whiteboard__${EDIT_TOOL}` }, async ($, e) => {
    const ops = Array.isArray(e.ops) ? e.ops.filter((op): op is Record<string, unknown> => !!op && typeof op === 'object') : []
    const briefOps = Array.isArray(e.sections) ? e.sections.filter((op): op is Record<string, unknown> => !!op && typeof op === 'object') : []
    const bottomLine = typeof e.bottom_line === 'string' && e.bottom_line.trim() ? e.bottom_line.trim() : undefined
    const briefMode = e.brief_mode === 'brief' || e.brief_mode === 'decide' ? e.brief_mode : undefined
    const onBoard = typeof e.board === 'string' ? e.board : undefined
    const side = e.side_board && typeof e.side_board === 'object' ? (e.side_board as { op: string; id: string; choice?: string; why?: string }) : undefined
    if (side) {
      if (!board) return { deny: `There is no whiteboard page in this session yet.` }
      let closed: { ok: boolean; boardError?: string }
      try {
        const started = await boardOpen($)
        closed = await boardPost($, started.open, { sideBoardOp: side })
      } catch (error) {
        return { deny: failed(error) }
      }
      if (closed.boardError) return { deny: `The board could not do that: ${closed.boardError}.` }
      if (!ops.length && !briefOps.length && !bottomLine && !briefMode) {
        return { result: `Side board ${side.id}: ${side.op === 'return' ? (side.choice ? `decided on ${side.choice}, which settles its constraint on the main board` : 'decided') : side.op === 'park' ? 'parked' : 'dropped'}; the user is back on the main board.` }
      }
    }
    if (!ops.length && !briefOps.length && !bottomLine && !briefMode) return { deny: 'Nothing to amend: give `ops` for a diagram, or `sections` or `bottom_line` for the brief.' }
    if (!board) return { deny: `There is no whiteboard page in this session yet: draw the diagram with ${TOOL} first.` }
    let briefSaid = ''
    if (briefOps.length || bottomLine || briefMode) {
      let changed: { ok: boolean; done?: number; errors?: string[]; briefError?: string; boardError?: string; board?: string }
      try {
        const started = await boardOpen($)
        changed = await boardPost($, started.open, { briefOps, ...(bottomLine ? { bottomLine } : {}), ...(briefMode ? { briefMode } : {}), ...(onBoard ? { board: onBoard } : {}) })
      } catch (error) {
        return { deny: failed(error) }
      }
      if (changed.boardError) return { deny: `The board could not do that: ${changed.boardError}.` }
      const where = changed.board && changed.board !== 'main' ? ` on the side board \`${changed.board}\`` : ''
      if (changed.briefError) return { deny: `There is no brief${where || ' on the board'} yet: post one with ${TOOL} (bottom_line and sections).` }
      // An answer under a section is Claude answering on the board: nothing more is posted for the turn.
      if (boardTurn && briefOps.some(op => op.op === 'answer') && (changed.done ?? 0) > 0) boardTurn.isPosted = true
      const errors = changed.errors?.length ? ` Not applied: ${changed.errors.join('; ')}.` : ''
      briefSaid = `Changed the brief${where}: ${changed.done ?? 0} of ${briefOps.length + (bottomLine ? 1 : 0) + (briefMode ? 1 : 0)} applied.${errors}`
      if (!ops.length) return { result: briefSaid }
    }
    let out: { ok: boolean; diagram?: string; tab?: number; done?: string[]; errors?: string[]; error?: string; look?: string }
    try {
      // A closed tab opens again, so the amendment is seen.
      const started = await boardOpen($)
      out = await boardPost($, started.open, { ops, ...(Number.isInteger(e.diagram) ? { diagram: e.diagram } : {}), ...(e.look === false ? { look: false } : {}), ...(onBoard ? { board: onBoard } : {}) })
    } catch (error) {
      return { deny: failed(error) }
    }
    if (out.error) return { deny: `The board could not apply it: ${out.error}.` }
    // Not counted as an answer on the board: what Claude then writes still goes there.
    const errors = out.errors?.length ? ` Not applied: ${out.errors.join('; ')}.` : ''
    const said = `${briefSaid ? `${briefSaid} ` : ''}Amended diagram ${out.tab ?? ''} "${out.diagram ?? ''}" on the board: ${out.done?.length ?? 0} of ${ops.length} applied.${errors}`
    if (!out.look) return { result: said }
    // A small picture of the result: worth a glance for crowded labels or arrows across boxes.
    return {
      result: [
        { type: 'text', text: `${said} Below, how it looks now; fix anything crowded or overlapping with another amendment.` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: out.look } },
      ],
    }
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
    if (!arg || arg === 'focus' || arg === 'canvas') {
      try {
        // Asked for: it opens again even with a tab showing it, which may be out of sight.
        const started = await boardOpen($, true)
        if (arg === 'canvas') {
          await boardPost($, started.open, { mode: 'canvas' })
          const where = started.isOpened ? 'opened in your browser' : `open it in your browser: ${started.open.url}`
          return { text: `Whiteboard ${where}, in canvas mode: edit the diagrams together.`, context: [CANVAS_NOTE] }
        }
        const where = started.isOpened ? 'opened in your browser' : `open it in your browser: ${started.open.url}`
        if (arg === 'focus') isOnBoard = true
        if (arg === 'focus') return { text: `Whiteboard ${where}. Discuss there; Claude answers on the board.`, context: [FOCUS_NOTE] }
        return { text: `Whiteboard ${where}.` }
      } catch (error) {
        return { text: failed(error) }
      }
    }
    if (arg === 'sample') {
      const shown = await draw(SAMPLE, 'Sample diagram drawn')
      // Claude did not draw it, so it is told what is there: the user's next
      // question is likely about it ("pin a note on the email service").
      return {
        ...shown,
        context: [
          `The user opened the whiteboard's sample diagram, "${SAMPLE.title}", to try the board; it is on the page now. ` +
            'It is a sample, not their project. If they ask about it or for a change, work from this source: pin ' +
            `sticky notes with \`on\` set to a node id, or redraw it with ${TOOL} keeping the ids and labels that ` +
            `stay the same.\n\n\`\`\`mermaid\n${SAMPLE.source}\n\`\`\``,
        ],
      }
    }
    let text: string
    try {
      text = await $.fs.read(arg)
    } catch (err) {
      return { text: `Couldn't read ${arg}: ${err instanceof Error ? err.message : String(err)}` }
    }
    const next = { title: arg.split('/').at(-1) ?? arg, source: mermaidOf(text) }
    const shown = await draw(next, `Diagram from ${arg} drawn`)
    return {
      ...shown,
      context: [
        `The user opened ${arg} on the whiteboard page. Its diagram, as Mermaid (pin sticky notes with \`on\` set ` +
          `to a node id, or redraw it with ${TOOL}):\n\n\`\`\`mermaid\n${next.source}\n\`\`\``,
      ],
    }
  })
}
