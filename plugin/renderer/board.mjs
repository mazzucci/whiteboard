#!/usr/bin/env node
// The focus board: a page on this machine where Claude posts notes and
// diagrams and the person answers, for a discussion that stays on the board
// until it concludes. One per session, started by the plugin.
//
//   node board.mjs --mermaid <path to mermaid.min.js>
//
// It listens on 127.0.0.1 only, on a free port, and every request needs the
// random token. On stdout, one JSON line each:
//
//   {"ready":true,"url":"http://127.0.0.1:PORT/?t=TOKEN","port":PORT,"token":"…"}
//   {"say":"…"}  a message the person typed on the page, for the plugin to submit
//
//   GET  /            the page
//   GET  /mermaid.js  Mermaid, from what setup installed (no CDN)
//   GET  /events      server-sent events: every card so far, then each new one
//   POST /post        { kind: 'note' | 'diagram', title?, text?, mermaid? } from the plugin
//   POST /say         { text } from the page

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const mermaidPath = arg('mermaid')
if (!mermaidPath) {
  console.error('usage: board.mjs --mermaid <path to mermaid.min.js>')
  process.exit(2)
}
const mermaidJs = readFileSync(mermaidPath)
const token = randomBytes(16).toString('hex')

const cards = []
const listeners = new Set()
let nextId = 1

function publish(card) {
  const stored = { id: nextId++, at: Date.now(), ...card }
  cards.push(stored)
  for (const res of listeners) res.write(`data: ${JSON.stringify(stored)}\n\n`)
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
  const reply = (status, type, body) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
    })
    res.end(body)
  }

  if (req.method === 'GET' && url.pathname === '/') return reply(200, 'text/html; charset=utf-8', PAGE)
  if (req.method === 'GET' && url.pathname === '/mermaid.js') return reply(200, 'text/javascript', mermaidJs)
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    for (const card of cards) res.write(`data: ${JSON.stringify(card)}\n\n`)
    listeners.add(res)
    req.on('close', () => listeners.delete(res))
    return
  }
  if (req.method === 'POST' && (url.pathname === '/post' || url.pathname === '/say')) {
    let input
    try {
      input = await readBody(req)
    } catch {
      return reply(400, 'application/json', '{"error":"not JSON"}')
    }
    if (url.pathname === '/say') {
      const text = clip(input.text, 4000)?.trim()
      if (!text) return reply(400, 'application/json', '{"error":"empty"}')
      publish({ kind: 'you', text })
      say(text)
      return reply(200, 'application/json', '{"ok":true}')
    }
    const kind = input.kind === 'diagram' ? 'diagram' : 'note'
    publish({ kind, title: clip(input.title, 200), text: clip(input.text, 20000), mermaid: clip(input.mermaid, 100000) })
    return reply(200, 'application/json', '{"ok":true}')
  }
  reply(404, 'application/json', '{"error":"not found"}')
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

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Whiteboard · focus</title>
<style>
  :root { --bg: #f6f7f9; --card: #ffffff; --ink: #1d2330; --muted: #667085; --line: #e3e6ec; --accent: #2563eb; --you: #eef4ff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14171d; --card: #1c2028; --ink: #e8ebf1; --muted: #98a2b3; --line: #2b313c; --accent: #6ea0ff; --you: #1f2a40; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 12px 20px; background: var(--bg); border-bottom: 1px solid var(--line); }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header .state { color: var(--muted); font-size: 13px; }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa1ad; }
  header .dot.on { background: #22a35a; }
  main { max-width: 1200px; margin: 0 auto; padding: 20px 20px 140px; display: flex; flex-direction: column; gap: 16px; }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; }
  .card h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
  .card.you { background: var(--you); align-self: flex-end; max-width: 75%; }
  .card.you .who { color: var(--muted); font-size: 12px; margin-bottom: 2px; }
  .diagram { overflow: auto; }
  .diagram svg { display: block; margin: 0 auto; max-width: none; height: auto; }
  .diagram.fit svg { max-width: 100%; }
  .tools { display: flex; gap: 8px; margin: -4px 0 8px; }
  .tools button { font: inherit; font-size: 12px; color: var(--muted); background: none; border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .error { color: #c0392b; white-space: pre-wrap; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
  .note p { margin: 0 0 8px; } .note ul { margin: 0 0 8px; padding-left: 20px; }
  .note code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; background: var(--bg); padding: 1px 4px; border-radius: 4px; }
  form { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 20px 16px; background: var(--bg); border-top: 1px solid var(--line); }
  form .row { max-width: 1200px; margin: 0 auto; display: flex; gap: 10px; align-items: flex-end; }
  textarea { flex: 1; resize: none; min-height: 44px; max-height: 160px; font: inherit; color: var(--ink); background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  button.send, button.wrap { font: inherit; border-radius: 10px; padding: 10px 16px; cursor: pointer; border: 1px solid var(--line); }
  button.send { background: var(--accent); color: white; border-color: var(--accent); }
  button.wrap { background: var(--card); color: var(--ink); }
  .hint { max-width: 1200px; margin: 6px auto 0; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header><span class="dot" id="dot"></span><h1>Whiteboard · focus</h1><span class="state" id="state">connecting…</span></header>
<main id="feed"><div class="empty" id="empty">Claude's notes and diagrams for this discussion appear here.</div></main>
<form id="form">
  <div class="row">
    <textarea id="text" rows="1" placeholder="Reply to Claude…"></textarea>
    <button class="send" type="submit">Send</button>
    <button class="wrap" type="button" id="wrap">Wrap up</button>
  </div>
  <div class="hint">Enter sends, Shift+Enter adds a line. Your messages go to the same Claude Code session.</div>
</form>
<script src="/mermaid.js?t=${'${TOKEN}'}"></script>
<script>
  const token = new URLSearchParams(location.search).get('t')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' })
  const feed = document.getElementById('feed')
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  // A small, safe Markdown: paragraphs, bullet lists, **bold**, \`code\`.
  function markdown(text) {
    const inline = s => esc(s).replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>').replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    return String(text ?? '').split(/\\n{2,}/).map(block => {
      const lines = block.split('\\n')
      if (lines.every(l => /^\\s*[-*] /.test(l))) return '<ul>' + lines.map(l => '<li>' + inline(l.replace(/^\\s*[-*] /, '')) + '</li>').join('') + '</ul>'
      return '<p>' + lines.map(inline).join('<br>') + '</p>'
    }).join('')
  }
  let seq = 0
  async function add(card) {
    document.getElementById('empty')?.remove()
    const el = document.createElement('section')
    el.className = 'card ' + card.kind
    if (card.kind === 'you') {
      el.innerHTML = '<div class="who">You</div><div class="note">' + markdown(card.text) + '</div>'
    } else {
      el.innerHTML = (card.title ? '<h2>' + esc(card.title) + '</h2>' : '') + (card.text ? '<div class="note">' + markdown(card.text) + '</div>' : '')
      if (card.mermaid) {
        const tools = document.createElement('div')
        tools.className = 'tools'
        tools.innerHTML = '<button type="button">Fit width</button><button type="button">Actual size</button>'
        const box = document.createElement('div')
        box.className = 'diagram fit'
        tools.children[0].onclick = () => box.classList.add('fit')
        tools.children[1].onclick = () => box.classList.remove('fit')
        el.append(tools, box)
        try {
          const { svg } = await mermaid.render('d' + ++seq, card.mermaid)
          box.innerHTML = svg
        } catch (err) {
          box.innerHTML = '<div class="error">' + esc(err?.message ?? err) + '</div>'
        }
      }
    }
    feed.append(el)
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // One at a time, in order: Mermaid renders are asynchronous.
  let queue = Promise.resolve()
  const events = new EventSource('/events?t=' + token)
  events.onopen = () => { document.getElementById('dot').classList.add('on'); document.getElementById('state').textContent = 'connected to the session' }
  events.onerror = () => { document.getElementById('dot').classList.remove('on'); document.getElementById('state').textContent = 'session ended or reconnecting' }
  events.onmessage = e => { const card = JSON.parse(e.data); queue = queue.then(() => add(card)) }
  async function send(text) {
    text = text.trim()
    if (!text) return
    await fetch('/say?t=' + token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  }
  const box = document.getElementById('text')
  document.getElementById('form').onsubmit = e => { e.preventDefault(); const t = box.value; box.value = ''; send(t) }
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('form').requestSubmit() } })
  document.getElementById('wrap').onclick = () => send('Let us wrap up: summarise what we concluded, and post the summary back in the Claude Code conversation.')
</script>
</body>
</html>`.replace('${TOKEN}', token)
