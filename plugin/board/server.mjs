#!/usr/bin/env node
// The whiteboard: a page on this machine where Claude posts notes and
// diagrams and the person answers. One per session, started by the plugin.
// Node's standard library only; Mermaid is vendored beside this file.
//
//   node server.mjs [--label <name>]   the label tells sessions' pages apart
//
// It listens on 127.0.0.1 only, on a free port, and every request needs the
// random token. On stdout, one JSON line each:
//
//   {"ready":true,"url":"http://127.0.0.1:PORT/?t=TOKEN","port":PORT,"token":"…"}
//   {"say":"…"}  a message the person typed on the page, for the plugin to submit
//
//   GET  /            the page (page/index.html, app.js, app.css)
//   GET  /mermaid.js  Mermaid, vendored (gzipped on disk, served as is)
//   GET  /editor.js, /editor.css, /editor/fonts/…  the canvas editor (Excalidraw),
//                     vendored the same way, loaded when a diagram is first edited
//   GET  /events      server-sent events: every card so far, then each new one
//   GET  /viewers     { viewers }: how many pages are open on this board
//   GET  /cards       { viewers, cards, scenes }: everything on the board, for Claude
//                     to read back; scenes: each edited diagram's summary, by its id
//   (the page and its files load without the token; the rest needs it, in the
//   x-board-token header, or ?t= for /events, and never from another site)
//   POST /post        a card from the plugin; answers once the page has drawn it
//                     { notes: [{ on?, text }] } with mermaid: Claude's sticky notes on
//                     that diagram; without: pinned to the latest diagram
//                     { status: 'working' | 'idle' }: whether Claude is in a turn
//                     { end: true, text? }: the discussion is over; the page
//                     says so and closes, and this server stops
//                     { ops: [...], diagram? }: Claude's amendments to a diagram's canvas
//                     (the latest edited one unless `diagram`, its tab number, says);
//                     answers once a page has applied them
//                     { snapshot: true, diagram? }: a PNG of a diagram, as base64
//                     { mode: 'diagrams' | 'canvas' }: how the board works (with a post or alone)
//   POST /rendered    { id, error? } from the page: how a card's diagram drew
//   POST /say         { text } from the page
//   POST /scene       { diagram, elements, summary } from the page: a diagram's canvas
//                     as it now is; kept, and sent to the board's other pages
//   POST /applied     { id, done, errors, look? } from the page: how Claude's amendments
//                     went, with a small JPEG of the result
//   POST /snapshot    { id, png } from the page: the image Claude asked for
//   POST /mode        { mode } from the page: the person switched the board's mode

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const mermaidGz = readFileSync(new URL('./vendor/mermaid.min.js.gz', import.meta.url))
// The page: read once at start, with this board's token written in.
const pageFile = name => readFileSync(new URL(`./page/${name}`, import.meta.url), 'utf8')
const STATIC = {
  '/app.js': ['text/javascript', pageFile('app.js')],
  '/editing.js': ['text/javascript', pageFile('editing.js')],
  '/app.css': ['text/css', pageFile('app.css')],
}
// The canvas editor, read when first asked for: most boards never edit.
const vendorFile = name => readFileSync(new URL(`./vendor/editor/${name}`, import.meta.url))
const EDITOR = { '/editor.js': ['text/javascript', 'editor.js.gz'], '/editor.css': ['text/css', 'editor.css.gz'] }
const FONT = /^\/editor\/fonts\/([A-Za-z]+)\/([\w.-]+\.woff2)$/
const token = randomBytes(16).toString('hex')
const labelAt = process.argv.indexOf('--label')
const label = labelAt > 0 ? String(process.argv[labelAt + 1] ?? '').slice(0, 80) : ''
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** How long a post waits for a page to draw its diagram. */
const DRAW_WAIT_MS = 10_000

const cards = []
/** Each edited diagram's canvas, by the diagram's card id: { elements, summary }. */
const scenes = new Map()
/** Whether Claude is in a turn: sent to each page as it connects, never stored as a card. */
let status = 'idle'
/**
 * How the board works: `diagrams`, Claude's diagrams as they are drawn (each
 * new one a tab); or `canvas`, every diagram editable by both, amended in place.
 */
let mode = 'diagrams'
const MODES = ['diagrams', 'canvas']
const listeners = new Set()
/** Each page's connection, by the id it chose; the one that last spoke is asked to edit. */
const pages = new Map()
let lastPage = null
/** Posts waiting for the page to say how their diagram drew: id → resolve. */
const drawing = new Map()
/** Amendments and image requests waiting for a page's answer: id → resolve. */
const asked = new Map()
let nextAsk = 1
let nextId = 1

function broadcast(event, except) {
  for (const res of listeners) if (res !== except) res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/**
 * Asks one page (the last to speak, else any) to do something, and waits for
 * its answer; a page that is just opening is waited for a few seconds.
 */
async function ask(event, waitMs = 15_000) {
  for (let i = 0; i < 40 && !listeners.size; i++) await new Promise(r => setTimeout(r, 200))
  const res = (lastPage && pages.get(lastPage)) ?? [...listeners].at(-1)
  if (!res) return { error: 'no page is open' }
  const id = nextAsk++
  res.write(`data: ${JSON.stringify({ ...event, id })}\n\n`)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      asked.delete(id)
      resolve({ error: 'the page did not answer in time' })
    }, waitMs)
    asked.set(id, answer => {
      clearTimeout(timer)
      asked.delete(id)
      resolve(answer)
    })
  })
}

/** A diagram by its tab number (1 is the first), or the latest edited one, else the latest. */
function diagramOf(tab) {
  const diagrams = cards.filter(c => c.kind === 'diagram')
  if (Number.isInteger(tab)) return diagrams[tab - 1]
  return diagrams.findLast(c => scenes.has(c.id)) ?? diagrams.at(-1)
}

function publish(card) {
  const stored = { id: nextId++, at: Date.now(), ...card }
  cards.push(stored)
  broadcast(stored)
  return stored
}

/** A card whose diagram failed: off the board, so the corrected one replaces it. */
function withdraw(id) {
  const i = cards.findIndex(c => c.id === id)
  if (i >= 0) cards.splice(i, 1)
  broadcast({ kind: 'remove', id })
}

const say = text => process.stdout.write(`${JSON.stringify({ say: text })}\n`)

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > limit) req.destroy()
    })
    req.on('end', () => {
      try {
        const value = JSON.parse(body || '{}')
        // Only a JSON object is a request; null, arrays and numbers are not.
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
        resolve(value)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined)

/** At most six legend entries, each a label and a CSS colour from the diagram's classDef. */
function legendOf(value) {
  if (!Array.isArray(value)) return undefined
  const entries = value
    .filter(x => typeof x?.label === 'string')
    .map(x => ({
      label: x.label.slice(0, 40),
      stroke: /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/.test(x.stroke ?? '') ? x.stroke : undefined,
      isDashed: x.isDashed === true,
    }))
    .slice(0, 6)
  return entries.length ? entries : undefined
}

/** Sticky notes from Claude: at most eight, each pinned to a node id or the diagram. */
function notesOf(value) {
  if (!Array.isArray(value)) return undefined
  const notes = value
    .filter(n => typeof n?.text === 'string' && n.text.trim())
    .map(n => ({ text: n.text.slice(0, 600), on: typeof n.on === 'string' && /^[\w-]{1,64}$/.test(n.on) ? n.on : undefined }))
    .slice(0, 8)
  return notes.length ? notes : undefined
}

/** Waits for the page to draw a card: { drawn: true }, { error }, or { drawn: false } with nobody looking. */
function drawn(id) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      drawing.delete(id)
      resolve({ drawn: false })
    }, DRAW_WAIT_MS)
    drawing.set(id, outcome => {
      clearTimeout(timer)
      drawing.delete(id)
      resolve(outcome)
    })
  })
}

// A request that goes wrong is answered with an error, never takes the board down.
const server = createServer((req, res) =>
  handle(req, res).catch(() => {
    try {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"failed"}')
    } catch {
      // The connection is gone.
    }
  }),
)

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src 'self'; " +
    "connect-src 'self'; worker-src 'self' blob:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const reply = (status, type, body, headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers })
    res.end(body)
  }
  const json = (status, value) => reply(status, 'application/json', JSON.stringify(value))
  // Loopback only, and only this server's own host name: a page elsewhere
  // that guesses the port (or rebinds a DNS name to 127.0.0.1) gets nothing.
  const host = req.headers.host ?? ''
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  if (!origins.includes(`http://${host}`)) return json(403, { error: 'forbidden' })

  // The page itself holds no secret: it loads without the token, so the token
  // can leave the address bar once the page has it.
  if (req.method === 'GET' && url.pathname === '/') return reply(200, 'text/html; charset=utf-8', PAGE)
  if (req.method === 'GET' && STATIC[url.pathname]) return reply(200, ...STATIC[url.pathname])
  if (req.method === 'GET' && url.pathname === '/mermaid.js') {
    return reply(200, 'text/javascript', mermaidGz, { 'content-encoding': 'gzip', 'cache-control': 'private, max-age=86400' })
  }
  if (req.method === 'GET' && EDITOR[url.pathname]) {
    const [type, name] = EDITOR[url.pathname]
    return reply(200, type, vendorFile(name), { 'content-encoding': 'gzip', 'cache-control': 'private, max-age=86400' })
  }
  const font = req.method === 'GET' ? FONT.exec(url.pathname) : null
  if (font) {
    let bytes
    try {
      bytes = vendorFile(`fonts/${font[1]}/${font[2]}`)
    } catch {
      return json(404, { error: 'not found' })
    }
    return reply(200, 'font/woff2', bytes, { 'cache-control': 'private, max-age=86400' })
  }

  // Everything else needs the token, and comes from this page or the plugin,
  // never from another site, even one that has the token.
  const given = req.headers['x-board-token'] ?? (req.method === 'GET' ? url.searchParams.get('t') : null)
  const origin = req.headers.origin
  const site = req.headers['sec-fetch-site']
  const isOtherSite = (origin !== undefined && !origins.includes(origin)) || (site !== undefined && site !== 'same-origin' && site !== 'none')
  if (given !== token || isOtherSite) return json(403, { error: 'forbidden' })
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    for (const card of cards) res.write(`data: ${JSON.stringify(card)}\n\n`)
    // Edited diagrams as they now are, after the cards they belong to.
    for (const [diagram, scene] of scenes) res.write(`data: ${JSON.stringify({ kind: 'scene', diagram, elements: scene.elements })}\n\n`)
    // The mode last, so a canvas board makes editable only the diagram on screen.
    res.write(`data: ${JSON.stringify({ kind: 'mode', mode })}\n\n`)
    res.write(`data: ${JSON.stringify({ kind: 'status', state: status })}\n\n`)
    listeners.add(res)
    const page = /^[\w-]{1,40}$/.test(url.searchParams.get('c') ?? '') ? url.searchParams.get('c') : null
    if (page) {
      pages.set(page, res)
      lastPage = page
    }
    req.on('close', () => {
      listeners.delete(res)
      if (page && pages.get(page) === res) pages.delete(page)
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/viewers') return json(200, { viewers: listeners.size })
  if (req.method === 'GET' && url.pathname === '/cards') {
    return json(200, { viewers: listeners.size, mode, cards, scenes: Object.fromEntries([...scenes].map(([id, s]) => [id, s.summary])) })
  }
  const POSTS = ['/post', '/say', '/rendered', '/scene', '/applied', '/snapshot', '/mode']
  if (req.method !== 'POST' || !POSTS.includes(url.pathname)) return json(404, { error: 'not found' })
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return json(415, { error: 'JSON only' })

  let input
  try {
    // A canvas or an image is bigger than a card.
    input = await readBody(req, ['/scene', '/snapshot'].includes(url.pathname) ? 20_000_000 : 1_000_000)
  } catch {
    return json(400, { error: 'not JSON' })
  }
  const from = /^[\w-]{1,40}$/.test(String(input.page ?? '')) ? String(input.page) : null
  if (from && pages.has(from) && url.pathname !== '/rendered') lastPage = from
  if (url.pathname === '/mode') {
    if (!MODES.includes(input.mode)) return json(400, { error: 'diagrams or canvas' })
    mode = input.mode
    broadcast({ kind: 'mode', mode }, from ? pages.get(from) : undefined)
    return json(200, { ok: true })
  }
  if (url.pathname === '/scene') {
    const diagram = Number(input.diagram)
    if (!cards.some(c => c.id === diagram && c.kind === 'diagram') || !Array.isArray(input.elements)) return json(400, { error: 'no such diagram' })
    const summary = input.summary && typeof input.summary === 'object' ? input.summary : {}
    scenes.set(diagram, { elements: input.elements, summary })
    broadcast({ kind: 'scene', diagram, elements: input.elements }, from ? pages.get(from) : undefined)
    return json(200, { ok: true })
  }
  if (url.pathname === '/applied' || url.pathname === '/snapshot') {
    const settle = asked.get(Number(input.id))
    if (!settle) return json(200, { ok: false })
    if (url.pathname === '/applied') {
      const look = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(input.look ?? ''))
      settle({
        done: Array.isArray(input.done) ? input.done.map(String) : [],
        errors: Array.isArray(input.errors) ? input.errors.map(String) : [],
        error: clip(input.error, 2000),
        ...(look ? { look: look[1] } : {}),
      })
    } else {
      const png = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(input.png ?? ''))
      settle(png ? { png: png[1] } : { error: clip(input.error, 2000) ?? 'no image' })
    }
    return json(200, { ok: true })
  }
  if (url.pathname === '/say') {
    const text = clip(input.text, 4000)?.trim()
    if (!text) return json(400, { error: 'empty' })
    publish({ kind: 'you', text })
    say(text)
    return json(200, { ok: true })
  }
  if (url.pathname === '/rendered') {
    const settle = drawing.get(Number(input.id))
    if (settle) settle(typeof input.error === 'string' ? { error: input.error.slice(0, 2000) } : { drawn: true })
    return json(200, { ok: true })
  }
  // Claude sets the mode with a post, or on its own.
  if (MODES.includes(input.mode) && input.mode !== mode) {
    mode = input.mode
    broadcast({ kind: 'mode', mode })
  }
  // `waitForPage` rides along with every post from the plugin: a mode alone is still no card.
  if (input.mode && Object.keys(input).every(k => k === 'mode' || k === 'waitForPage')) return json(200, { ok: MODES.includes(input.mode), mode, viewers: listeners.size })
  if (input.status === 'working' || input.status === 'idle') {
    status = input.status
    broadcast({ kind: 'status', state: status })
    return json(200, { ok: true })
  }
  if (Array.isArray(input.ops)) {
    const target = diagramOf(input.diagram)
    if (!target) return json(200, { ok: false, error: 'no diagram on the board' })
    const ops = input.ops.filter(op => op && typeof op === 'object' && !Array.isArray(op)).slice(0, 50)
    const answer = await ask({ kind: 'ops', diagram: target.id, ops, ...(input.look === false ? { look: false } : {}) })
    return json(200, { ok: !answer.error, diagram: target.title ?? '', tab: cards.filter(c => c.kind === 'diagram').indexOf(target) + 1, ...answer })
  }
  if (input.snapshot === true) {
    const target = diagramOf(input.diagram)
    if (!target) return json(200, { ok: false, error: 'no diagram on the board' })
    const answer = await ask({ kind: 'snapshot', diagram: target.id })
    return json(200, { ok: !answer.error, diagram: target.title ?? '', ...answer })
  }
  if (input.end === true) {
    publish({ kind: 'end', text: clip(input.text, 2000) })
    json(200, { ok: true, viewers: listeners.size })
    // Long enough for the page to get the event, then gone: the next
    // discussion starts on a new page.
    setTimeout(() => process.exit(0), 1500).unref()
    return
  }
  const mermaid = clip(input.mermaid, 100_000)
  const notes = notesOf(input.notes)
  // Notes without a diagram go on the latest one, which stays as it is.
  if (notes && !mermaid) {
    const latest = cards.findLast(c => c.kind === 'diagram')
    if (!latest) return json(200, { ok: false, viewers: listeners.size, drawn: false, noDiagram: true })
    // On a diagram being edited, a note goes on its canvas, as an amendment.
    if (scenes.has(latest.id)) {
      const ops = notes.map((n, i) => ({ op: 'note', id: `note-${Date.now().toString(36)}-${i}`, on: n.on, text: n.text }))
      const answer = await ask({ kind: 'ops', diagram: latest.id, ops })
      if (answer.error || answer.errors?.length) return json(200, { ok: false, viewers: listeners.size, drawn: false, error: answer.error ?? answer.errors.join('; ') })
      if (!clip(input.text, 20_000)) return json(200, { ok: true, viewers: listeners.size, drawn: false, pinned: latest.title ?? '' })
    } else for (const note of notes) publish({ kind: 'sticky', by: 'claude', diagram: latest.id, ...note })
    if (!clip(input.text, 20_000)) return json(200, { ok: true, viewers: listeners.size, drawn: false, pinned: latest.title ?? '' })
  }
  const card = publish({
    kind: mermaid ? 'diagram' : 'note',
    title: clip(input.title, 200),
    text: clip(input.text, 20_000),
    mermaid,
    theme: clip(input.theme, 20),
    legend: legendOf(input.legend),
    notes: mermaid ? notes : undefined,
  })
  // A diagram is answered once a page has drawn it, so Mermaid's errors reach
  // Claude. With no page open, wait only when one is opening (a new board).
  if (!mermaid || (!listeners.size && input.waitForPage !== true)) {
    return json(200, { ok: true, id: card.id, viewers: listeners.size, drawn: false })
  }
  const outcome = await drawn(card.id)
  if (outcome.error) withdraw(card.id)
  return json(200, { ok: !outcome.error, id: card.id, viewers: listeners.size, ...outcome })
}

let port = 0
server.listen(0, '127.0.0.1', () => {
  port = server.address().port
  const ready = { ready: true, url: `http://127.0.0.1:${port}/?t=${token}`, port, token }
  process.stdout.write(`${JSON.stringify(ready)}\n`)
})
// Keep server-sent events alive through proxies and sleeping tabs.
setInterval(() => {
  for (const res of listeners) res.write(': ping\n\n')
}, 20000).unref()
const stop = () => process.exit(0)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

const PAGE = pageFile('index.html')
  .replaceAll('__LABEL__', label ? ` · ${escapeHtml(label)}` : '')
