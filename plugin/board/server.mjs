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
//                     { brief: { bottomLine, sections, mode? }, isNew? }: a brief beside the diagrams
//                     (refused when one is there already, unless isNew); mode `decide` makes
//                     it a decision: constraints with choices, settled before a proposal
//                     { briefOps: [...], bottomLine?, briefMode? }: changes to the brief, each
//                     checked and applied in order (add, update, drop, restore, answer, settle, reopen)
//                     { sideBoard: { id, title, for? } }: a side board for one question, opened
//                     from the main board (with the brief and diagram that go on it)
//                     { board }: with any of these, the board they are for (else the one the
//                     person is looking at)
//                     { sideBoardOp: { op: 'return' | 'park' | 'drop', id, choice?, why? } }:
//                     a side board done with, its decision (if any) settling the main board's
//                     constraint it was opened for
//   POST /view        { board } from the page: the board the person is looking at
//   POST /rendered    { id, error?, unpinned? } from the page: how a card's diagram drew, and notes it could not pin
//   POST /say         { text, about?, choices?, board? } from the page; `about` is the brief's section the
//                     person asked about: their question waits there for Claude's answer;
//                     `choices` [{ id, choice }] settle constraints (or take Claude's suggestions)
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
  '/charts.js': ['text/javascript', pageFile('charts.js')],
  '/export.js': ['text/javascript', pageFile('export.js')],
  '/brief.js': ['text/javascript', pageFile('brief.js')],
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

/**
 * A diagram by its tab number (1 is the first); else, on a canvas board, the
 * latest (it is editable, even before the page has converted it); on a
 * drawing board, the latest edited one, else the latest.
 */
function diagramOf(tab) {
  // Numbered on the board in hand, as its tabs are on the page.
  const diagrams = cards.filter(c => c.kind === 'diagram' && (c.board ?? 'main') === briefBoard.id)
  if (Number.isInteger(tab)) return diagrams[tab - 1]
  if (mode === 'canvas') return diagrams.at(-1)
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
/** What a sticky note is pinned to: a node id, or a chart's label (any text on one line). */
const onOf = on => (typeof on === 'string' && /^[^\u0000-\u001f\u007f]{1,100}$/.test(on.trim()) ? on.trim() : undefined)

function notesOf(value) {
  if (!Array.isArray(value)) return undefined
  const notes = value
    .filter(n => typeof n?.text === 'string' && n.text.trim())
    .map(n => ({ text: n.text.slice(0, 600), on: onOf(n.on) }))
    .slice(0, 8)
  return notes.length ? notes : undefined
}

// ---------------------------------------------------------------- the brief
//
// Claude's brief: a bottom line and a few one-line sections beside the
// diagrams, changed in place as the conversation goes on. The server holds it
// and checks every change; each change goes to the pages as the whole brief
// with what changed, so a page that reconnects replays its history too.

/** At most this many sections at a time: the brief fits one screen. */
const MAX_SECTIONS = 9
/**
 * The boards: the main one, and side boards opened from it, one question
 * each: { id, title, for (the main board's constraint it decides), state
 * (open, decided, parked, dropped), brief }. One level deep: a side board
 * opens no other.
 */
const boards = new Map([['main', { id: 'main', state: 'open', brief: null }]])
/** The board the person last looked at: where Claude's posts go unless they name one. */
let viewing = 'main'
const MAX_SIDE_BOARDS = 3
/** The board a request is for, and its brief, as `briefBoard` and `brief` while it is handled. */
let briefBoard = boards.get('main')
let brief = null
function useBoard(id) {
  briefBoard = boards.get(id) ?? boards.get(viewing) ?? boards.get('main')
  brief = briefBoard.brief
  return briefBoard
}
/** The brief just made or put back, kept on its board. */
const keepBrief = () => (briefBoard.brief = brief)
/** A board as the pages and Claude see it, without its brief. */
const boardMeta = b => ({ id: b.id, title: b.title, for: b.for, state: b.state, ...(b.why ? { why: b.why } : {}) })
function boardChanged(change) {
  publish({ kind: 'board', boards: [...boards.values()].map(boardMeta), viewing, change })
}
/**
 * The brief before the one just posted, until its diagram has drawn. Only a
 * post with both a brief and a diagram uses it, and each such post sets it.
 */
let briefBefore
/** A side board the post being handled opened, and the board the person was on before: closed again if its diagram fails. */
let opened
let viewingBefore
const SECTION_ID = /^[A-Za-z0-9][\w-]{0,31}$/

const textOf = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined)
/** A one-line field (a title, a line, a label): its line breaks become spaces. */
const lineOf = (value, max) => textOf(typeof value === 'string' ? value.replace(/\s*[\r\n]+\s*/g, ' ') : value, max)
/** Sources: a label, with a web address when there is one (a file:line has none). */
function citesOf(value) {
  if (!Array.isArray(value)) return undefined
  const cites = value
    .map(c => ({ label: lineOf(c?.label, 60), url: /^https?:\/\/[^\s"<>]{1,500}$/.test(c?.url ?? '') ? c.url : undefined }))
    .filter(c => c.label)
    .slice(0, 4)
  return cites.length ? cites : undefined
}
/** The boxes or chart labels a section is about. */
function focusOf(value) {
  if (!Array.isArray(value)) return undefined
  const ids = value.map(onOf).filter(Boolean).slice(0, 12)
  return ids.length ? ids : undefined
}

/** What a section is: a point (the default), a constraint to settle, or an idea not yet weighed. */
const KINDS = ['point', 'constraint', 'idea']
/** A comparison's cells, by option: a mark (yes, part, no, unknown) and one short clause. */
const MARKS = ['yes', 'part', 'no', 'unknown']
function cellsOf(value, before = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const cells = { ...before }
  for (const [id, c] of Object.entries(value).slice(0, 4)) {
    if (!SECTION_ID.test(id) || !c || typeof c !== 'object') continue
    cells[id] = { mark: MARKS.includes(c.mark) ? c.mark : 'unknown', text: lineOf(c.text, 90) }
  }
  return Object.keys(cells).length ? cells : undefined
}

/** Words the page uses for its own buttons (take or turn down a suggestion, turn down an assumption): no choice is called that. */
const RESERVED = ['accept', 'decline', 'reject']
/** A constraint's options: at most four, each an id and a short label. */
function choicesOf(value) {
  if (!Array.isArray(value)) return undefined
  const choices = value
    .map(c => ({ id: String(c?.id ?? '').trim(), label: lineOf(c?.label, 40), hint: lineOf(c?.hint, 60) }))
    .filter(c => SECTION_ID.test(c.id) && !RESERVED.includes(c.id) && c.label)
    .filter((c, i, all) => all.findIndex(x => x.id === c.id) === i)
    .slice(0, 4)
  return choices.length ? choices : undefined
}

/** A section as Claude gave it, checked: { section } or { error }. */
function sectionOf(input) {
  const id = String(input?.id ?? '').trim()
  if (!SECTION_ID.test(id)) return { error: `"${id.slice(0, 40)}" is not a section id (letters, digits, - and _, up to 32)` }
  const line = lineOf(input.line, 300)
  if (!line) return { error: `section ${id} has no line` }
  const kind = KINDS.includes(input.kind) ? input.kind : 'point'
  const choices = kind === 'constraint' ? choicesOf(input.choices) : undefined
  const lean = choices?.some(c => c.id === input.lean) ? input.lean : undefined
  return {
    section: {
      id, kind, title: lineOf(input.title, 40) ?? id, line, body: textOf(input.body, 4000), focus: focusOf(input.focus), cites: citesOf(input.cites), cells: cellsOf(input.cells),
      // A constraint is open until settled; an assumed one is Claude's guess, for the person to confirm.
      ...(kind === 'constraint' ? { status: input.status === 'assumed' ? 'assumed' : 'open', choices, lean } : {}),
      ...(input.by === 'you' ? { by: 'you' } : {}),
      ...(input.suggested === true ? { suggested: true } : {}),
      v: 1, asks: [],
    },
  }
}

/** A decision's constraints still open (an assumption does not hold up the proposal; suggestions wait for the person). */
const openOf = b => b.sections.filter(s => s.kind === 'constraint' && s.status === 'open' && !s.suggested)

/**
 * Settles a constraint on a choice (or confirms an assumed one, on Claude's
 * lean): { change } or { error }. The person's choices come from the page.
 */
function settle(section, choice, by) {
  if (section.kind !== 'constraint') return { error: `${section.id}: only a constraint is settled` }
  // Settled already (the person's clicks settle at once): it is not settled again, nor changed without a reopen.
  if (section.status === 'settled') {
    const on = section.choices?.find(c => c.id === section.chosen)?.label ?? 'yes'
    return { error: `${section.id}: settled already, on ${on}${section.settledBy === 'you' ? ' by the user' : ''} (reopen it first if that changed)` }
  }
  const pick = choice ?? (section.status === 'assumed' ? section.lean : undefined)
  // A choice must be one of its own; one with no choices is settled as it stands.
  const isOwn = section.choices?.length ? section.choices.some(c => c.id === pick) : pick === undefined
  if (!isOwn) {
    return { error: `${section.id}: "${String(pick ?? '').slice(0, 32)}" is not one of its choices (${section.choices?.map(c => c.id).join(', ') || 'it has none'})` }
  }
  section.status = 'settled'
  section.chosen = pick
  section.settledBy = by
  delete section.suggested
  section.v++
  return { change: { op: 'settle', id: section.id } }
}

/** A new brief: { brief } or { error }. */
function briefOf(input) {
  const bottomLine = lineOf(input?.bottomLine, 600)
  if (!bottomLine) return { error: 'a brief needs a bottom line' }
  const given = Array.isArray(input.sections) ? input.sections : []
  if (given.length > MAX_SECTIONS) return { error: `at most ${MAX_SECTIONS} sections, so the brief fits one screen: merge some` }
  const sections = []
  for (const s of given) {
    const out = sectionOf(s)
    if (out.error) return out
    if (sections.some(x => x.id === out.section.id)) return { error: `two sections are called ${out.section.id}` }
    sections.push(out.section)
  }
  // A comparison's options are its columns; a side board's decision is one of them.
  const options = choicesOf(input.options)
  return { brief: { bottomLine, v: 1, mode: input.mode === 'decide' || options ? 'decide' : 'brief', ...(options ? { options } : {}), sections, dropped: [] } }
}

/** Applies one change to the brief: { change } saying what it did, or { error }. */
function briefOp(op) {
  const kind = op?.op
  const id = String(op?.id ?? '').trim()
  const at = brief.sections.findIndex(s => s.id === id)
  const section = brief.sections[at]
  const isFull = brief.sections.length >= MAX_SECTIONS
  if (kind === 'add') {
    if (section || brief.dropped.some(s => s.id === id)) return { error: `${id}: already in the brief (update or restore it)` }
    if (isFull) return { error: `${id}: the brief has ${MAX_SECTIONS} sections already; merge or drop one first` }
    const out = sectionOf(op)
    if (out.error) return out
    const after = brief.sections.findIndex(s => s.id === String(op.after ?? ''))
    brief.sections.splice(after >= 0 ? after + 1 : brief.sections.length, 0, out.section)
    return { change: { op: 'add', id } }
  }
  if (kind === 'restore') {
    const i = brief.dropped.findIndex(s => s.id === id)
    if (i < 0) return { error: `${id}: no dropped section by that id` }
    if (isFull) return { error: `${id}: the brief has ${MAX_SECTIONS} sections already; merge or drop one first` }
    const [back] = brief.dropped.splice(i, 1)
    delete back.why
    brief.sections.push(back)
    return { change: { op: 'restore', id } }
  }
  if (!section) return { error: `${id}: no section by that id${brief.dropped.some(s => s.id === id) ? ' (it was dropped: restore it first)' : ''}` }
  if (kind === 'update') {
    // Refused before anything changes: a settled constraint is opened with reopen.
    if ((op.status === 'open' || op.status === 'assumed') && section.status === 'settled' && (op.kind ?? section.kind) === 'constraint') {
      return { error: `${id}: settled; reopen it to change that` }
    }
    const before = JSON.stringify(section)
    const line = lineOf(op.line, 300)
    const isNewLine = Boolean(line && line !== section.line)
    if (typeof op.title === 'string') section.title = lineOf(op.title, 40) ?? section.title
    if (KINDS.includes(op.kind) && op.kind !== section.kind) {
      section.kind = op.kind
      // No longer a constraint: nothing of its state stays; a new one starts open.
      if (op.kind === 'constraint') section.status = 'open'
      else for (const key of ['status', 'choices', 'lean', 'chosen', 'settledBy']) delete section[key]
    }
    if (section.kind === 'constraint') {
      if (Array.isArray(op.choices)) section.choices = choicesOf(op.choices)
      if (typeof op.lean === 'string') section.lean = op.lean || undefined
      // A lean must be one of the choices, as they now are.
      if (section.lean && !section.choices?.some(c => c.id === section.lean)) delete section.lean
      if (op.status === 'open' || op.status === 'assumed') section.status = op.status
    }
    // Taking a suggestion in words, or saying the idea was the person's.
    if (op.suggested === false) delete section.suggested
    if (op.by === 'you') section.by = 'you'
    if (typeof op.body === 'string') section.body = textOf(op.body, 4000)
    if (Array.isArray(op.focus)) section.focus = focusOf(op.focus)
    if (Array.isArray(op.cites)) section.cites = citesOf(op.cites)
    if (op.cells && typeof op.cells === 'object') section.cells = cellsOf(op.cells, section.cells)
    if (!isNewLine && JSON.stringify(section) === before) return { error: `${id}: nothing to change (it already says that)` }
    section.v++
    // A new line keeps the one before it, shown struck through until the person has seen it.
    if (isNewLine) {
      section.was = section.line
      section.line = line
      section.lineV = section.v
    }
    return { change: { op: 'update', id, isNewLine } }
  }
  if (kind === 'drop') {
    brief.sections.splice(at, 1)
    brief.dropped.push({ ...section, why: textOf(op.why, 200) })
    return { change: { op: 'drop', id } }
  }
  if (kind === 'answer') {
    const text = textOf(op.text, 4000)
    if (!text) return { error: `${id}: an answer needs text` }
    // The person's oldest question there that has no answer yet (answered in order), or an answer on its own.
    const ask = section.asks.find(a => a.question && !a.answer)
    if (ask) ask.answer = text
    else section.asks.push({ answer: text })
    section.asks = section.asks.slice(-6)
    return { change: { op: 'answer', id } }
  }
  if (kind === 'settle') return settle(section, typeof op.choice === 'string' ? op.choice : undefined, 'claude')
  if (kind === 'reopen') {
    if (section.kind !== 'constraint' || section.status !== 'settled') return { error: `${id}: not a settled constraint` }
    section.status = 'open'
    delete section.chosen
    delete section.settledBy
    section.v++
    return { change: { op: 'reopen', id } }
  }
  return { error: `${id}: unknown change "${String(kind).slice(0, 20)}" (add, update, drop, restore, answer, settle, reopen)` }
}

/** Sends the brief as it now is, with what changed and who changed it. */
function briefChanged(changes, by = 'claude') {
  publish({ kind: 'brief', board: briefBoard.id, brief: brief && structuredClone(brief), changes, by })
}

/** A side board done with: back on the main board. */
function closeSideBoard(side, state, why) {
  side.state = state
  if (why) side.why = why
  if (viewing === side.id) viewing = 'main'
  boardChanged({ op: state, id: side.id })
}

/**
 * A side board's decision: one of its options settles the main board's
 * constraint it was opened for (the option joins that constraint's choices if
 * it is not one yet). { constraint, label } or { error }.
 */
function decideSideBoard(side, choice, by) {
  const option = side.brief?.options?.find(o => o.id === choice)
  if (!option) return { error: `"${String(choice ?? '').slice(0, 32)}" is not one of the side board's options` }
  const main = boards.get('main')
  const target = side.for && main.brief?.sections.find(s => s.id === side.for)
  if (target) {
    const was = { board: briefBoard, brief }
    useBoard('main')
    if (!target.choices?.some(c => c.id === option.id)) target.choices = [...(target.choices ?? []), { id: option.id, label: option.label }].slice(-4)
    if (target.status === 'settled') {
      target.status = 'open'
      delete target.chosen
    }
    const out = settle(target, option.id, by)
    if (out.error) {
      briefBoard = was.board
      brief = was.brief
      return out
    }
    brief.isProposal = brief.isProposal && !openOf(brief).length
    briefChanged([out.change, { op: 'decided', id: target.id, board: side.id }], by)
    briefBoard = was.board
    brief = was.brief
  }
  closeSideBoard(side, 'decided')
  return { constraint: target?.title, label: option.label }
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
    // The boards as they are now, and the one the person was last on (a /view publishes nothing).
    if (boards.size > 1) res.write(`data: ${JSON.stringify({ kind: 'board', boards: [...boards.values()].map(boardMeta), viewing })}\n\n`)
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
    // The brief once, as it is now: its changes are cards too, but Claude reads only where it got to.
    return json(200, {
      viewers: listeners.size, mode, cards: cards.filter(c => c.kind !== 'brief' && c.kind !== 'board'), scenes: Object.fromEntries([...scenes].map(([id, s]) => [id, s.summary])),
      brief: boards.get('main').brief, boards: [...boards.values()].map(b => ({ ...boardMeta(b), brief: b.brief })), viewing,
    })
  }
  const POSTS = ['/post', '/say', '/rendered', '/scene', '/applied', '/snapshot', '/mode', '/view']
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
  if (url.pathname === '/view') {
    if (!boards.has(input.board)) return json(400, { error: 'no such board' })
    viewing = input.board
    return json(200, { ok: true })
  }
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
    let text = clip(input.text, 4000)?.trim()
    if (!text) return json(400, { error: 'empty' })
    // From a side board: Claude is told which, and answers there.
    const from = useBoard(boards.has(input.board) ? input.board : 'main')
    if (from.id !== 'main') text = `(On the side board \`${from.id}\`, "${from.title}":)\n${text}`
    // A question about a section of the brief waits there for Claude's answer.
    const section = brief?.sections.find(s => s.id === input.about)
    publish({ kind: 'you', text: clip(input.asked, 4000)?.trim() || text, ...(section ? { about: section.id } : {}) })
    // More detail is asked for in the section's body, not answered under it.
    if (section && input.isMore !== true) {
      section.asks = [...section.asks, { question: clip(input.asked, 1000)?.trim() || text.slice(0, 1000) }].slice(-6)
      briefChanged([{ op: 'ask', id: section.id }], 'you')
    }
    // The person's choices on the board settle their constraints at once; Claude hears them in the message.
    const chosen = []
    const unsettled = []
    const decided = []
    for (const c of Array.isArray(input.choices) ? input.choices.slice(0, 12) : []) {
      // A side board's decision (`id` the side board) settles the main board's constraint it was opened for.
      const side = c?.board === 'main' && c.id !== 'main' ? boards.get(c.id) : undefined
      if (side) {
        const out = side.state === 'open' ? decideSideBoard(side, c.choice, 'you') : { error: `the side board ${side.id} is ${side.state} already` }
        if (out.error) unsettled.push(out.error)
        else decided.push(out)
        continue
      }
      if (!brief) continue
      const target = brief.sections.find(s => s.id === c?.id)
      if (!target) {
        unsettled.push(`${String(c?.id).slice(0, 32)} (not in the brief any more)`)
        continue
      }
      if (target.suggested && c.choice === 'decline') {
        brief.sections.splice(brief.sections.indexOf(target), 1)
        brief.dropped.push({ ...target, why: 'not wanted' })
        chosen.push({ op: 'drop', id: target.id })
      } else if (target.suggested && (c.choice === 'accept' || target.choices?.some(x => x.id === c.choice))) {
        // Taken: a suggested constraint with choices is taken by choosing one.
        delete target.suggested
        target.v++
        const out = target.kind === 'constraint' && (c.choice !== 'accept' || !target.choices?.length) ? settle(target, c.choice === 'accept' ? undefined : c.choice, 'you') : null
        chosen.push(out?.change ?? { op: 'accept', id: target.id })
      } else if (c.choice === 'reject' && target.status === 'assumed') {
        // Not this assumption: open again, for Claude to ask.
        target.status = 'open'
        target.v++
        chosen.push({ op: 'reject', id: target.id })
      } else {
        const out = settle(target, typeof c.choice === 'string' ? c.choice : undefined, 'you')
        if (out.change) chosen.push(out.change)
        else unsettled.push(out.error)
      }
    }
    if (chosen.length) {
      brief.isProposal = brief.isProposal && !openOf(brief).length
      briefChanged(chosen, 'you')
    }
    if (decided.length) {
      const d = decided[0]
      text = `${text}\n\n(Decided on the side board: ${d.label}. Back on the main board${d.constraint ? `, where "${d.constraint}" is settled on it` : '; no constraint there was waiting on it'}.)`
    }
    // Claude hears what the board could not settle, after what they wrote.
    if (unsettled.length) text = `${text}\n\n(Not settled on the board: ${unsettled.join('; ')}.)`
    say(text)
    return json(200, { ok: true })
  }
  if (url.pathname === '/rendered') {
    const settle = drawing.get(Number(input.id))
    // Sticky notes whose `on` names nothing on the diagram sit beside it: Claude is told.
    const unpinned = Array.isArray(input.unpinned) ? input.unpinned.map(onOf).filter(Boolean).slice(0, 8) : []
    const noteErrors = unpinned.map(on => `no box or chart label "${on}" on the diagram, so that note sits beside it`)
    if (settle) settle(typeof input.error === 'string' ? { error: input.error.slice(0, 2000) } : { drawn: true, ...(noteErrors.length ? { noteErrors } : {}) })
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
  // Each post starts with nothing to undo: what an earlier one left must not carry over.
  briefBefore = opened = viewingBefore = undefined
  // A side board for one question, opened from the main board: the rest of the post goes on it.
  if (input.sideBoard) {
    const s = input.sideBoard
    const id = String(s?.id ?? '').trim()
    if (!SECTION_ID.test(id) || id === 'main') return json(200, { ok: false, viewers: listeners.size, boardError: `"${id.slice(0, 40)}" is not a board id` })
    // A parked side board opens again where it was left.
    const parked = boards.get(id)
    if (parked && parked.state !== 'parked') return json(200, { ok: false, viewers: listeners.size, boardError: `a side board called ${id} is ${parked.state} already` })
    // Its brief is checked first: a side board never opens empty.
    const checked = input.brief ? briefOf(input.brief) : parked?.brief ? { brief: parked.brief } : { error: 'a side board needs its brief' }
    if (checked.error) return json(200, { ok: false, viewers: listeners.size, briefError: checked.error })
    const open = [...boards.values()].filter(b => b.id !== 'main' && b.state === 'open')
    if (open.length >= MAX_SIDE_BOARDS) return json(200, { ok: false, viewers: listeners.size, boardError: `${MAX_SIDE_BOARDS} side boards are open: return to, park or drop one first` })
    const forId = typeof s.for === 'string' ? s.for : undefined
    const main = boards.get('main').brief
    if (forId && !main?.sections.some(x => x.id === forId && x.kind === 'constraint')) return json(200, { ok: false, viewers: listeners.size, boardError: `the main board has no constraint ${forId}` })
    viewingBefore = viewing
    if (parked) {
      parked.state = 'open'
      delete parked.why
    } else boards.set(id, { id, title: lineOf(s.title, 60) ?? id, for: forId, state: 'open', brief: null })
    opened = parked ? null : id
    viewing = id
    boardChanged({ op: 'open', id })
    input.board = id
    if (parked) input.isNew = input.isNew ?? true
  }
  if (input.sideBoard && !input.brief && !input.mermaid && !clip(input.text, 20_000) && !input.notes) {
    return json(200, { ok: true, viewers: listeners.size, drawn: false, board: viewing })
  }
  // A board named that does not exist is refused, not taken for another.
  if (typeof input.board === 'string' && !boards.has(input.board)) return json(200, { ok: false, viewers: listeners.size, boardError: `no board ${input.board.slice(0, 40)}` })
  useBoard(typeof input.board === 'string' ? input.board : undefined)
  // Closing a side board: decided (its decision settles the main board's constraint), parked or dropped.
  if (input.sideBoardOp) {
    const o = input.sideBoardOp
    const side = boards.get(o?.id)
    if (!side || side.id === 'main') return json(200, { ok: false, viewers: listeners.size, boardError: `no side board ${String(o?.id).slice(0, 40)}` })
    if (side.state === 'decided' || side.state === 'dropped') return json(200, { ok: false, viewers: listeners.size, boardError: `the side board ${side.id} is ${side.state} already` })
    if (o.op === 'return') {
      if (o.choice !== undefined) {
        const out = decideSideBoard(side, o.choice, 'claude')
        if (out.error) return json(200, { ok: false, viewers: listeners.size, boardError: out.error })
      } else closeSideBoard(side, 'decided')
    } else if (o.op === 'park' || o.op === 'drop') closeSideBoard(side, o.op === 'park' ? 'parked' : 'dropped', lineOf(o.why, 200))
    else return json(200, { ok: false, viewers: listeners.size, boardError: 'return, park or drop' })
    return json(200, { ok: true, viewers: listeners.size, viewing })
  }
  // A brief, new: refused over one already there, so Claude changes that one instead of writing it again.
  if (input.brief) {
    if (brief && input.isNew !== true) return json(200, { ok: false, viewers: listeners.size, briefError: 'a brief is on the board already' })
    const out = briefOf(input.brief)
    if (out.error) return json(200, { ok: false, viewers: listeners.size, briefError: out.error })
    briefBefore = brief
    brief = out.brief
    keepBrief()
    briefChanged([{ op: 'new' }])
    if (!input.mermaid && !clip(input.text, 20_000) && !input.notes) {
      opened = viewingBefore = undefined
      return json(200, { ok: true, viewers: listeners.size, drawn: false, sections: brief.sections.length, board: briefBoard.id })
    }
  }
  // Changes to the brief: each checked and applied in order; those that fail are said, the rest stand.
  if (Array.isArray(input.briefOps) || typeof input.bottomLine === 'string' || typeof input.briefMode === 'string') {
    if (!brief) return json(200, { ok: false, viewers: listeners.size, briefError: 'there is no brief on the board yet', board: briefBoard.id })
    const changes = []
    const errors = []
    if (input.briefMode === 'brief' || input.briefMode === 'decide') {
      if (input.briefMode === brief.mode) errors.push(`brief_mode: it is a ${brief.mode === 'decide' ? 'decision' : 'brief'} already`)
      else {
        brief.mode = input.briefMode
        changes.push({ op: 'mode', mode: brief.mode })
      }
    }
    const bottomLine = lineOf(input.bottomLine, 600)
    if (bottomLine && bottomLine === brief.bottomLine) errors.push('bottom_line: nothing to change (it already says that)')
    if (bottomLine && bottomLine !== brief.bottomLine) {
      brief.wasBottomLine = brief.bottomLine
      brief.bottomLine = bottomLine
      brief.v++
      changes.push({ op: 'bottomLine' })
    }
    const ops = (input.briefOps ?? []).filter(op => op && typeof op === 'object' && !Array.isArray(op))
    for (const [i, op] of ops.slice(0, 30).entries()) {
      const out = briefOp(op)
      if (out.error) errors.push(`#${i + 1} ${out.error}`)
      else changes.push(out.change)
    }
    if (ops.length > 30) errors.push(`#31 to #${ops.length}: not applied, at most 30 at a time`)
    // In a decision, a bottom line written once nothing is open is the proposal; it stops being one when something opens.
    const isOpen = openOf(brief).length > 0
    if (brief.mode === 'decide' && changes.some(c => c.op === 'bottomLine') && !isOpen) brief.isProposal = true
    if (isOpen || brief.mode !== 'decide') brief.isProposal = false
    if (changes.length) briefChanged(changes)
    return json(200, { ok: true, viewers: listeners.size, done: changes.length, errors, sections: brief.sections.map(s => s.id), board: briefBoard.id })
  }
  if (Array.isArray(input.ops)) {
    const target = diagramOf(input.diagram)
    if (!target) return json(200, { ok: false, error: 'no diagram on the board' })
    const all = input.ops.filter(op => op && typeof op === 'object' && !Array.isArray(op))
    const ops = all.slice(0, 50)
    const answer = await ask({ kind: 'ops', diagram: target.id, ops, ...(input.look === false ? { look: false } : {}) })
    const over = all.length > 50 ? [`#51 to #${all.length}: not applied, at most 50 at a time`] : []
    const onItsBoard = cards.filter(c => c.kind === 'diagram' && (c.board ?? 'main') === (target.board ?? 'main'))
    return json(200, { ok: !answer.error, diagram: target.title ?? '', tab: onItsBoard.indexOf(target) + 1, board: target.board ?? 'main', ...answer, errors: [...(answer.errors ?? []), ...over] })
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
  /** Notes the canvas could not pin (no such box): told to Claude, the rest still posted. */
  let noteErrors = []
  // Notes without a diagram go on the latest one, which stays as it is.
  if (notes && !mermaid) {
    const latest = cards.findLast(c => c.kind === 'diagram' && (c.board ?? 'main') === briefBoard.id)
    if (!latest) return json(200, { ok: false, viewers: listeners.size, drawn: false, noDiagram: true, board: briefBoard.id })
    // On a diagram being edited, a note goes on its canvas, as an amendment.
    if (scenes.has(latest.id)) {
      const ops = notes.map((n, i) => ({ op: 'note', id: `note-${Date.now().toString(36)}-${i}`, on: n.on, text: n.text }))
      const answer = await ask({ kind: 'ops', diagram: latest.id, ops })
      if (answer.error) return json(200, { ok: false, viewers: listeners.size, drawn: false, noteError: answer.error })
      noteErrors = answer.errors ?? []
      if (!clip(input.text, 20_000)) return json(200, { ok: true, viewers: listeners.size, drawn: false, pinned: latest.title ?? '', noteErrors })
    } else for (const note of notes) publish({ kind: 'sticky', by: 'claude', diagram: latest.id, ...note })
    if (!clip(input.text, 20_000)) return json(200, { ok: true, viewers: listeners.size, drawn: false, pinned: latest.title ?? '' })
  }
  const card = publish({
    board: briefBoard.id,
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
    briefBefore = opened = viewingBefore = undefined
    return json(200, { ok: true, id: card.id, viewers: listeners.size, drawn: false, board: briefBoard.id, ...(noteErrors.length ? { noteErrors } : {}) })
  }
  // Other requests may come in while the page draws: what to undo is kept with its board.
  const undo = input.brief && briefBefore !== undefined ? { board: briefBoard, brief: briefBefore, opened, viewing: viewingBefore } : null
  const postedOn = briefBoard.id
  briefBefore = opened = viewingBefore = undefined
  const outcome = await drawn(card.id)
  if (outcome.error) withdraw(card.id)
  // A brief posted with a diagram Mermaid rejects goes with it, and a side board opened with them closes: Claude posts them again.
  if (outcome.error && undo) {
    useBoard(undo.board.id)
    brief = undo.brief
    keepBrief()
    briefChanged([{ op: 'undo' }])
    if (undo.opened) {
      boards.delete(undo.opened)
      if (viewing === undo.opened) viewing = boards.has(undo.viewing) ? undo.viewing : 'main'
      boardChanged({ op: 'undo', id: undo.opened })
    }
  }
  return json(200, { ok: !outcome.error, id: card.id, viewers: listeners.size, board: postedOn, ...outcome })
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
