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
//   GET  /events      server-sent events: every card so far, then each new one
//   POST /post        a card from the plugin; answers once the page has drawn it
//                     { status: 'working' | 'idle' }: whether Claude is in a turn
//                     { end: true, text? }: the discussion is over; the page
//                     says so and closes, and this server stops
//   POST /rendered    { id, error? } from the page: how a card's diagram drew
//   POST /say         { text } from the page

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const mermaidGz = readFileSync(new URL('./vendor/mermaid.min.js.gz', import.meta.url))
// The page: read once at start, with this board's token written in.
const pageFile = name => readFileSync(new URL(`./page/${name}`, import.meta.url), 'utf8')
const STATIC = {
  '/app.js': ['text/javascript', pageFile('app.js')],
  '/app.css': ['text/css', pageFile('app.css')],
}
const token = randomBytes(16).toString('hex')
const labelAt = process.argv.indexOf('--label')
const label = labelAt > 0 ? String(process.argv[labelAt + 1] ?? '').slice(0, 80) : ''
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** How long a post waits for a page to draw its diagram. */
const DRAW_WAIT_MS = 10_000

const cards = []
/** Whether Claude is in a turn: sent to each page as it connects, never stored as a card. */
let status = 'idle'
const listeners = new Set()
/** Posts waiting for the page to say how their diagram drew: id → resolve. */
const drawing = new Map()
let nextId = 1

function broadcast(event) {
  for (const res of listeners) res.write(`data: ${JSON.stringify(event)}\n\n`)
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch (err) {
        reject(err)
      }
    })
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  // Loopback only, and only this server's own host name: a page elsewhere
  // that guesses the port (or rebinds a DNS name to 127.0.0.1) gets nothing.
  const host = req.headers.host ?? ''
  const isLocalHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`
  const given = url.searchParams.get('t') ?? req.headers['x-board-token']
  if (!isLocalHost || given !== token) {
    res.writeHead(403).end()
    return
  }
  const reply = (status, type, body, headers = {}) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'",
      ...headers,
    })
    res.end(body)
  }
  const json = (status, value) => reply(status, 'application/json', JSON.stringify(value))

  if (req.method === 'GET' && url.pathname === '/') return reply(200, 'text/html; charset=utf-8', PAGE)
  if (req.method === 'GET' && STATIC[url.pathname]) return reply(200, ...STATIC[url.pathname])
  if (req.method === 'GET' && url.pathname === '/mermaid.js') {
    return reply(200, 'text/javascript', mermaidGz, { 'content-encoding': 'gzip', 'cache-control': 'private, max-age=86400' })
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    for (const card of cards) res.write(`data: ${JSON.stringify(card)}\n\n`)
    res.write(`data: ${JSON.stringify({ kind: 'status', state: status })}\n\n`)
    listeners.add(res)
    req.on('close', () => listeners.delete(res))
    return
  }
  if (req.method !== 'POST' || !['/post', '/say', '/rendered'].includes(url.pathname)) return json(404, { error: 'not found' })

  let input
  try {
    input = await readBody(req)
  } catch {
    return json(400, { error: 'not JSON' })
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
  if (input.status === 'working' || input.status === 'idle') {
    status = input.status
    broadcast({ kind: 'status', state: status })
    return json(200, { ok: true })
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
  const card = publish({
    kind: mermaid ? 'diagram' : 'note',
    title: clip(input.title, 200),
    text: clip(input.text, 20_000),
    mermaid,
    theme: clip(input.theme, 20),
    legend: legendOf(input.legend),
  })
  // A diagram is answered once a page has drawn it, so Mermaid's errors reach
  // Claude. With no page open, wait only when one is opening (a new board).
  if (!mermaid || (!listeners.size && input.waitForPage !== true)) {
    return json(200, { ok: true, id: card.id, viewers: listeners.size, drawn: false })
  }
  const outcome = await drawn(card.id)
  if (outcome.error) withdraw(card.id)
  return json(200, { ok: !outcome.error, id: card.id, viewers: listeners.size, ...outcome })
})

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
  .replaceAll('__TOKEN__', token)
  .replaceAll('__LABEL__', label ? ` · ${escapeHtml(label)}` : '')
