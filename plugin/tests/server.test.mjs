// The board server on its own: node --test plugin/tests/server.test.mjs
//
// Starts board/server.mjs, then checks who may reach it and that nothing a
// request sends can take it down.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('../board/server.mjs', import.meta.url))
let child
let ready
const lines = []

before(async () => {
  child = spawn(process.execPath, [serverPath, '--label', 'tests'], { stdio: ['ignore', 'pipe', 'pipe'] })
  ready = await new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', chunk => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop()
      for (const line of parts.filter(Boolean)) {
        const message = JSON.parse(line)
        lines.push(message)
        if (message.ready) resolve(message)
      }
    })
    child.on('exit', code => reject(new Error(`server exited ${code}`)))
  })
})
after(() => child?.kill())

const base = () => `http://127.0.0.1:${ready.port}`
const call = (path, init = {}) => fetch(`${base()}${path}`, init)
const postJson = (path, body, headers = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board-token': ready.token, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const isAlive = async () => (await call('/')).status === 200

test('the page and its files load without the token, with the security headers', async () => {
  for (const path of ['/', '/app.js', '/editing.js', '/charts.js', '/export.js', '/brief.js', '/app.css', '/mermaid.js']) {
    const res = await call(path)
    assert.equal(res.status, 200, path)
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  }
  const page = await (await call('/')).text()
  assert.doesNotMatch(page, new RegExp(ready.token), 'the page holds no token')
  assert.match(page, /Whiteboard · tests/)
})

test('the events and every post need the token', async () => {
  assert.equal((await call('/events')).status, 403)
  assert.equal((await call('/events?t=wrong')).status, 403)
  assert.equal((await postJson('/say', { text: 'hi' }, { 'x-board-token': 'wrong' })).status, 403)
  const res = await call(`/events?t=${ready.token}`)
  assert.equal(res.status, 200)
  await res.body.cancel()
})

test('another site is refused even with the token', async () => {
  assert.equal((await postJson('/say', { text: 'hi' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await postJson('/say', { text: 'hi' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  const same = await postJson('/say', { text: 'from the page' }, { origin: base(), 'sec-fetch-site': 'same-origin' })
  assert.equal(same.status, 200)
})

test('a request under another host name gets nothing (DNS rebinding)', async () => {
  // fetch sets Host itself; a raw request can send any.
  const status = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: ready.port, path: '/', headers: { host: `evil.example:${ready.port}` } }, res => {
      res.resume()
      resolve(res.statusCode)
    })
      .on('error', reject)
      .end()
  })
  assert.equal(status, 403)
})

test('only JSON objects are accepted, and odd bodies never take the server down', async () => {
  for (const body of ['null', '[]', '42', '"text"', '{not json', '']) {
    const res = await postJson('/say', body)
    assert.ok(res.status === 400, `${JSON.stringify(body)} → ${res.status}`)
  }
  const plain = await call('/say', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-board-token': ready.token }, body: '{"text":"x"}' })
  assert.equal(plain.status, 415)
  assert.equal((await postJson('/post', { panel: null, mermaid: 42, notes: 'x', legend: {} })).status, 200)
  assert.ok(await isAlive())
})

test('what the person types is handed to the plugin on stdout', async () => {
  await postJson('/say', { text: 'why 1,240 calls?' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(lines.some(m => m.say === 'why 1,240 calls?'))
})

test('the plugin can ask how many pages are open, and read back what is on the board, with the token only', async () => {
  assert.equal((await call('/viewers')).status, 403)
  assert.equal((await call('/cards', { headers: { 'x-board-token': 'wrong' } })).status, 403)
  const auth = { headers: { 'x-board-token': ready.token } }
  assert.deepEqual(await (await call('/viewers', auth)).json(), { viewers: 0 })
  await postJson('/post', { title: 'Read me', text: 'a note to read back' })
  const { viewers, cards } = await (await call('/cards', auth)).json()
  assert.equal(viewers, 0)
  assert.ok(cards.some(c => c.kind === 'note' && c.text === 'a note to read back'))
})

test('the editor and its fonts load from the board itself, and nothing outside the font folder', async () => {
  for (const path of ['/editor.js', '/editor.css']) {
    const res = await call(path)
    assert.equal(res.status, 200, path)
    assert.ok((await res.arrayBuffer()).byteLength > 1000, path)
  }
  assert.equal((await call('/editor/fonts/Excalifont/nope.woff2')).status, 404)
  // The hand-drawn font is the board's own too (it was a 404 before 0.5.1).
  const hand = readdirSync(new URL('../board/vendor/editor/fonts/Excalifont/', import.meta.url))[0]
  assert.equal((await call(`/editor/fonts/Excalifont/${hand}`)).status, 200)
  assert.equal((await call('/editor/fonts/../editor.js.gz')).status, 403)
  assert.equal((await call('/editor/fonts/Excalifont/..%2F..%2Feditor.js.gz')).status, 403)
  assert.match((await call('/')).headers.get('content-security-policy'), /font-src 'self'/)
})

test("a canvas is kept and replayed; Claude's amendments go to a page and come back answered", async () => {
  const auth = { 'x-board-token': ready.token }
  const { id } = await (await postJson('/post', { title: 'Canvas', mermaid: 'flowchart LR\n  a --> b' })).json()
  // A page, as the browser's EventSource would connect.
  const events = []
  const res = await fetch(`${base()}/events?t=${ready.token}&c=testpage`)
  const reader = res.body.getReader()
  ;(async () => {
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }))
      if (done) return
      buffer += new TextDecoder().decode(value)
      const parts = buffer.split('\n\n')
      buffer = parts.pop()
      for (const p of parts) if (p.startsWith('data: ')) events.push(JSON.parse(p.slice(6)))
    }
  })()
  const scene = { page: 'testpage', diagram: id, elements: [{ id: 'a', type: 'rectangle' }], summary: { boxes: [{ ref: 'a', text: 'A', class: 'plain' }] } }
  assert.equal((await postJson('/scene', { ...scene, diagram: 9999 })).status, 400)
  assert.equal((await postJson('/scene', scene, { 'x-board-token': 'wrong' })).status, 403)
  assert.equal((await postJson('/scene', scene)).status, 200)
  const cards = await (await call('/cards', { headers: auth })).json()
  assert.deepEqual(cards.scenes[id], scene.summary)
  // The page answers the amendments it is sent.
  const answering = (async () => {
    for (let i = 0; i < 50; i++) {
      const ops = events.find(e => e.kind === 'ops')
      if (ops) return postJson('/applied', { page: 'testpage', id: ops.id, done: ['#1 (add)'], errors: [] })
      await new Promise(r => setTimeout(r, 50))
    }
  })()
  const applied = await (await postJson('/post', { ops: [{ op: 'add', id: 'c', text: 'C' }] })).json()
  await answering
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.done, ['#1 (add)'])
  assert.equal(applied.diagram, 'Canvas')
  // A page that opens later gets the canvas after the cards.
  const later = await fetch(`${base()}/events?t=${ready.token}`)
  const first = new TextDecoder().decode((await later.body.getReader().read()).value)
  await later.body.cancel().catch(() => {})
  reader.cancel().catch(() => {})
  assert.ok(first.includes('"kind":"diagram"'))
})

test('the mode: set by Claude or a page, kept, read back and replayed last', async () => {
  const auth = { headers: { 'x-board-token': ready.token } }
  assert.equal((await (await call('/cards', auth)).json()).mode, 'diagrams')
  assert.equal((await postJson('/mode', { mode: 'sideways' })).status, 400)
  assert.equal((await postJson('/mode', { mode: 'canvas' }, { 'x-board-token': 'wrong' })).status, 403)
  assert.equal((await postJson('/mode', { mode: 'canvas' })).status, 200)
  assert.equal((await (await call('/cards', auth)).json()).mode, 'canvas')
  const alone = await (await postJson('/post', { mode: 'diagrams' })).json()
  assert.equal(alone.mode, 'diagrams')
  await postJson('/post', { mode: 'canvas' })
  const res = await fetch(`${base()}/events?t=${ready.token}`)
  const reader = res.body.getReader()
  let text = ''
  for (let i = 0; i < 20 && !text.includes('"kind":"mode"'); i++) text += new TextDecoder().decode((await reader.read()).value)
  await reader.cancel()
  assert.match(text, /"kind":"mode","mode":"canvas"/)
  assert.ok(text.lastIndexOf('"kind":"mode"') > text.lastIndexOf('"kind":"diagram"'), 'after the cards')
})

test("the page's scripts share no top-level names (a later one would replace the earlier one's)", () => {
  const names = file => {
    const s = readFileSync(new URL(`../board/page/${file}`, import.meta.url), 'utf8')
    return new Set([...s.matchAll(/^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)/gm)].map(m => m[1] ?? m[2]))
  }
  const files = ['app.js', 'editing.js', 'charts.js', 'export.js', 'brief.js']
  const seen = new Map()
  const shared = []
  for (const file of files) {
    for (const n of names(file)) {
      if (seen.has(n)) shared.push(`${n} (${seen.get(n)}, ${file})`)
      seen.set(n, file)
    }
  }
  assert.deepEqual(shared, [])
})

// ---------------------------------------------------------------- the brief

const cardsNow = async () => (await call('/cards', { headers: { 'x-board-token': ready.token } })).json()
const briefPost = async body => (await postJson('/post', body)).json()

test('a brief is checked, posted once, and refused again unless it is new', async () => {
  const bad = await briefPost({ brief: { bottomLine: 'OAuth in short', sections: [{ id: 'has space', line: 'x' }] } })
  assert.match(bad.briefError, /not a section id/)
  assert.match((await briefPost({ brief: { sections: [{ id: 'a', line: 'x' }] } })).briefError, /bottom line/)
  const tooMany = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, line: 'x' }))
  assert.match((await briefPost({ brief: { bottomLine: 'b', sections: tooMany } })).briefError, /at most 9/)
  assert.equal((await cardsNow()).brief, null, 'nothing on the board after a refusal')

  const posted = await briefPost({
    brief: {
      bottomLine: 'OAuth lets an app use your data **without your password**.',
      sections: [
        { id: 'roles', title: 'Four roles', line: 'You, the app, the login service, the API.', focus: ['U', 'A', 'C', 'R'] },
        { id: 'flow', title: 'The main flow', line: 'The app swaps a one-time code for a token.', cites: [{ label: 'RFC 6749 §4.1', url: 'https://www.rfc-editor.org/rfc/rfc6749#section-4.1' }, { label: 'src/a.ts:3', url: 'javascript:alert(1)' }] },
      ],
    },
  })
  assert.equal(posted.ok, true)
  assert.equal(posted.sections, 2)
  const { brief } = await cardsNow()
  assert.deepEqual(brief.sections.map(s => s.id), ['roles', 'flow'])
  // Only web addresses are links: anything else is a label.
  assert.deepEqual(brief.sections[1].cites, [{ label: 'RFC 6749 §4.1', url: 'https://www.rfc-editor.org/rfc/rfc6749#section-4.1' }, { label: 'src/a.ts:3' }])
  assert.equal((await briefPost({ brief: { bottomLine: 'Another', sections: [] } })).briefError, 'a brief is on the board already')
  assert.equal((await cardsNow()).brief.bottomLine, brief.bottomLine)
})

test('changes to the brief apply in order; those that fail are said and the rest stand', async () => {
  const out = await briefPost({
    bottomLine: 'OAuth: a limited, revocable key instead of your password.',
    briefOps: [
      { op: 'update', id: 'flow', line: 'The app swaps a one-time code for a token over a back channel.' },
      { op: 'add', id: 'pkce', title: 'PKCE', line: 'A secret only the app knows protects the code.', after: 'flow' },
      { op: 'add', id: 'flow', line: 'again' },
      { op: 'drop', id: 'roles', why: 'covered by the diagram' },
      { op: 'update', id: 'roles', line: 'x' },
      { op: 'shuffle', id: 'pkce' },
      { op: 'answer', id: 'pkce', text: 'An answer with no question before it.' },
    ],
  })
  assert.equal(out.done, 5)
  assert.equal(out.errors.length, 3)
  assert.match(out.errors[0], /#3 flow: already in the brief/)
  assert.match(out.errors[1], /#5 roles: no section by that id \(it was dropped: restore it first\)/)
  assert.match(out.errors[2], /#6 pkce: unknown change "shuffle"/)
  const { brief } = await cardsNow()
  assert.equal(brief.bottomLine, 'OAuth: a limited, revocable key instead of your password.')
  assert.equal(brief.wasBottomLine, 'OAuth lets an app use your data **without your password**.')
  assert.deepEqual(brief.sections.map(s => s.id), ['flow', 'pkce'])
  assert.equal(brief.sections[0].was, 'The app swaps a one-time code for a token.')
  assert.deepEqual(brief.sections[1].asks, [{ answer: 'An answer with no question before it.' }])
  assert.deepEqual(brief.dropped.map(s => [s.id, s.why]), [['roles', 'covered by the diagram']])

  const back = await briefPost({ briefOps: [{ op: 'restore', id: 'roles' }] })
  assert.equal(back.done, 1)
  assert.deepEqual((await cardsNow()).brief.sections.map(s => s.id), ['flow', 'pkce', 'roles'])
  // No more than nine at a time: a tenth is refused, with what to do.
  const adds = Array.from({ length: 7 }, (_, i) => ({ op: 'add', id: `more${i}`, line: 'x' }))
  const full = await briefPost({ briefOps: adds })
  assert.equal(full.done, 6)
  assert.match(full.errors[0], /9 sections already; merge or drop one first/)
})

test('a question about a section waits under it until Claude answers there', async () => {
  const before = lines.length
  assert.equal((await postJson('/say', { text: "About the brief's section `flow`:\nWhy a back channel?", about: 'flow', asked: 'Why a back channel?' })).status, 200)
  // Claude gets the whole message; the board keeps the question under the section.
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(lines.slice(before).map(m => m.say), ["About the brief's section `flow`:\nWhy a back channel?"])
  let flow = (await cardsNow()).brief.sections.find(s => s.id === 'flow')
  assert.deepEqual(flow.asks, [{ question: 'Why a back channel?' }])
  const you = (await cardsNow()).cards.findLast(c => c.kind === 'you')
  assert.deepEqual([you.text, you.about], ['Why a back channel?', 'flow'])

  await briefPost({ briefOps: [{ op: 'answer', id: 'flow', text: 'So the token never passes through the browser.' }] })
  flow = (await cardsNow()).brief.sections.find(s => s.id === 'flow')
  assert.deepEqual(flow.asks, [{ question: 'Why a back channel?', answer: 'So the token never passes through the browser.' }])
  // About no section of the brief: an ordinary message.
  await postJson('/say', { text: 'hello', about: 'nope', asked: 'hello' })
  assert.equal((await cardsNow()).cards.findLast(c => c.kind === 'you').about, undefined)
})

test('a page that connects gets every change to the brief, in order, after the cards before it', async () => {
  const res = await call(`/events?t=${ready.token}`)
  const reader = res.body.getReader()
  let text = ''
  const until = Date.now() + 2000
  while (Date.now() < until && !text.includes('"kind":"status"')) text += new TextDecoder().decode((await reader.read()).value)
  await reader.cancel()
  const briefs = text.split('\n\n').filter(l => l.includes('"kind":"brief"')).map(l => JSON.parse(l.replace(/^data: /, '')))
  assert.ok(briefs.length >= 4)
  assert.deepEqual(briefs[0].changes, [{ op: 'new' }])
  assert.deepEqual(briefs.at(-1).brief.sections.find(s => s.id === 'flow').asks.at(-1).answer, 'So the token never passes through the browser.')
  // Read back by Claude, the brief is there once, not each change.
  assert.equal((await cardsNow()).cards.filter(c => c.kind === 'brief').length, 0)
})

test('answers go to the oldest question still waiting, so two questions keep their own answers', async () => {
  for (const asked of ['First?', 'Second?']) await postJson('/say', { text: asked, about: 'pkce', asked })
  await briefPost({ briefOps: [{ op: 'answer', id: 'pkce', text: 'A1' }, { op: 'answer', id: 'pkce', text: 'A2' }] })
  const pkce = (await cardsNow()).brief.sections.find(s => s.id === 'pkce')
  assert.deepEqual(pkce.asks.slice(-2), [{ question: 'First?', answer: 'A1' }, { question: 'Second?', answer: 'A2' }])
})

test('only a new line shows what it replaced; an update that changes nothing is refused', async () => {
  await briefPost({ briefOps: [{ op: 'update', id: 'pkce', line: 'PKCE: a secret the app keeps.' }] })
  let pkce = (await cardsNow()).brief.sections.find(s => s.id === 'pkce')
  const lineV = pkce.lineV
  assert.equal(lineV, pkce.v)
  // The body changes: the line, and what it replaced, stay as they were.
  await briefPost({ briefOps: [{ op: 'update', id: 'pkce', body: 'More on PKCE.' }] })
  pkce = (await cardsNow()).brief.sections.find(s => s.id === 'pkce')
  assert.equal(pkce.lineV, lineV)
  assert.ok(pkce.v > lineV)
  const same = await briefPost({ briefOps: [{ op: 'update', id: 'pkce', line: 'PKCE: a secret the app keeps.' }, { op: 'update', id: 'pkce' }], bottomLine: (await cardsNow()).brief.bottomLine })
  assert.equal(same.done, 0)
  assert.deepEqual(same.errors, ['bottom_line: nothing to change (it already says that)', '#1 pkce: nothing to change (it already says that)', '#2 pkce: nothing to change (it already says that)'])
  // One-line fields stay one line.
  await briefPost({ briefOps: [{ op: 'update', id: 'pkce', title: 'Two\nlines', line: 'One\n## Not a heading' }] })
  pkce = (await cardsNow()).brief.sections.find(s => s.id === 'pkce')
  assert.deepEqual([pkce.title, pkce.line], ['Two lines', 'One ## Not a heading'])
})

test('a brief posted with a diagram Mermaid rejects is taken off with it', async () => {
  const before = (await cardsNow()).brief
  const posting = briefPost({ title: 'Broken', mermaid: 'flowchart LR\n  a --> ', brief: { bottomLine: 'A new one', sections: [] }, isNew: true, waitForPage: true })
  let card
  for (let i = 0; i < 50 && !card; i++) {
    await new Promise(r => setTimeout(r, 50))
    card = (await cardsNow()).cards.find(c => c.title === 'Broken')
  }
  assert.equal((await cardsNow()).brief.bottomLine, 'A new one')
  await postJson('/rendered', { id: card.id, error: 'Parse error' })
  assert.equal((await posting).error, 'Parse error')
  assert.deepEqual((await cardsNow()).brief, before)
})

// ---------------------------------------------------------------- deciding

test('a decision: constraints with choices, settled by the person on the page or by Claude, suggestions taken or not', async () => {
  const posted = await briefPost({
    isNew: true,
    brief: {
      mode: 'decide',
      bottomLine: 'No proposal yet.',
      sections: [
        { id: 'accounts', kind: 'constraint', line: 'Guest or account?', choices: [{ id: 'guest', label: 'Guest' }, { id: 'required', label: 'Required' }, { id: 'bad id', label: 'x' }], lean: 'guest' },
        { id: 'markets', kind: 'constraint', status: 'assumed', line: 'One country.', choices: [{ id: 'one', label: 'One' }, { id: 'many', label: 'Several' }], lean: 'one' },
        { id: 'stock', kind: 'constraint', line: 'When is stock held?', choices: [{ id: 'pay', label: 'At payment' }], lean: 'nope' },
        { id: 'note', line: 'A plain point.', choices: [{ id: 'x', label: 'ignored' }] },
      ],
    },
  })
  assert.equal(posted.ok, true)
  let { brief } = await cardsNow()
  assert.equal(brief.mode, 'decide')
  const [accounts, markets, stock, note] = brief.sections
  assert.deepEqual([accounts.status, accounts.lean, accounts.choices.map(c => c.id)], ['open', 'guest', ['guest', 'required']])
  assert.deepEqual([markets.status, markets.lean], ['assumed', 'one'])
  assert.equal(stock.lean, undefined, 'a lean that is no choice is dropped')
  assert.deepEqual([note.kind, note.choices, note.status], ['point', undefined, undefined])

  // The person settles two on the page, in one message; one of their picks names no choice.
  await postJson('/say', { text: 'My choices on the board: Accounts: Guest; Markets: confirmed.', choices: [{ id: 'accounts', choice: 'guest' }, { id: 'markets' }, { id: 'stock', choice: 'never' }] })
  brief = (await cardsNow()).brief
  assert.deepEqual(brief.sections.map(s => [s.id, s.status, s.chosen, s.settledBy]).slice(0, 3), [['accounts', 'settled', 'guest', 'you'], ['markets', 'settled', 'one', 'you'], ['stock', 'open', undefined, undefined]])

  // Claude settles from words, reopens, suggests; the person takes one suggestion and turns down another.
  const out = await briefPost({
    briefOps: [
      { op: 'settle', id: 'stock', choice: 'pay' },
      { op: 'settle', id: 'note' },
      { op: 'settle', id: 'accounts', choice: 'nope' },
      { op: 'reopen', id: 'markets' },
      { op: 'add', id: 'email', kind: 'constraint', line: 'Email first?', suggested: true },
      { op: 'add', id: 'gift', kind: 'idea', line: 'Gift cards later.', suggested: true, by: 'you' },
    ],
  })
  assert.equal(out.done, 4)
  assert.match(out.errors[0], /#2 note: only a constraint is settled/)
  // Settled by the person already: not settled again (nor credited to Claude).
  assert.match(out.errors[1], /#3 accounts: settled already, on Guest by the user \(reopen it first if that changed\)/)
  await postJson('/say', { text: 'My choices on the board: Email first: take it; Gift cards: not now.', choices: [{ id: 'email', choice: 'accept' }, { id: 'gift', choice: 'decline' }] })
  brief = (await cardsNow()).brief
  const byId = Object.fromEntries(brief.sections.map(s => [s.id, s]))
  assert.deepEqual([byId.stock.status, byId.stock.settledBy, byId.markets.status, byId.markets.chosen], ['settled', 'claude', 'open', undefined])
  // A suggested constraint with no choices is settled by taking it.
  assert.deepEqual([byId.email.suggested, byId.email.status, byId.email.settledBy], [undefined, 'settled', 'you'])
  assert.deepEqual(brief.dropped.find(s => s.id === 'gift')?.why, 'not wanted')
  // The mode changes with a word from Claude.
  assert.equal((await briefPost({ briefMode: 'brief' })).done, 1)
  assert.equal((await cardsNow()).brief.mode, 'brief')
})

test('a decision changes cleanly: choices re-checked, kinds changed, suggestions taken in words, assumptions turned down', async () => {
  const ops = async (...briefOps) => briefPost({ briefOps })
  // markets was reopened above: a choice that is not one of its own is refused.
  let out = await ops({ op: 'settle', id: 'markets', choice: 'nope' })
  assert.match(out.errors[0], /markets: "nope" is not one of its choices \(one, many\)/)
  // New choices: a lean that is no longer one of them goes; duplicate ids are kept once.
  out = await ops({ op: 'update', id: 'markets', choices: [{ id: 'eu', label: 'EU' }, { id: 'eu', label: 'again' }, { id: 'us', label: 'US' }] })
  let markets = (await cardsNow()).brief.sections.find(s => s.id === 'markets')
  assert.deepEqual([markets.choices.map(c => c.id), markets.lean], [['eu', 'us'], undefined])
  // A settled one is not opened by an update: reopen does that.
  out = await ops({ op: 'update', id: 'stock', status: 'open' })
  assert.match(out.errors[0], /stock: settled; reopen it to change that/)
  // No longer a constraint: its state goes with it; a constraint again starts open.
  await ops({ op: 'update', id: 'stock', kind: 'point' }, { op: 'update', id: 'stock', kind: 'constraint' })
  const stock = (await cardsNow()).brief.sections.find(s => s.id === 'stock')
  assert.deepEqual([stock.status, stock.chosen, stock.settledBy, stock.choices], ['open', undefined, undefined, undefined])
  // A suggestion taken in words; the person's own idea marked so.
  await ops({ op: 'add', id: 'idea2', kind: 'idea', line: 'Gift wrap.', suggested: true })
  out = await ops({ op: 'update', id: 'idea2', suggested: false, by: 'you' })
  assert.equal(out.done, 1)
  const idea = (await cardsNow()).brief.sections.find(s => s.id === 'idea2')
  assert.deepEqual([idea.suggested, idea.by], [undefined, 'you'])
  // An assumption turned down on the page is open again; a stale choice is said to Claude, not settled.
  await ops({ op: 'update', id: 'markets', status: 'assumed', lean: 'eu' })
  const before = lines.length
  await postJson('/say', { text: 'My choices on the board: Markets: not this; Gone: x.', choices: [{ id: 'markets', choice: 'reject' }, { id: 'gone', choice: 'x' }, { id: 'stock', choice: 'nope' }] })
  await new Promise(r => setTimeout(r, 50))
  markets = (await cardsNow()).brief.sections.find(s => s.id === 'markets')
  assert.equal(markets.status, 'open')
  assert.match(lines.slice(before).at(-1).say, /\(Not settled on the board: gone \(not in the brief any more\); stock: "nope" is not one of its choices \(it has none\)\.\)$/)
  // A suggested constraint with choices is taken by choosing one.
  await ops({ op: 'add', id: 'ship', kind: 'constraint', line: 'Shipping?', suggested: true, choices: [{ id: 'flat', label: 'Flat rate' }, { id: 'live', label: 'Live rates' }] })
  await postJson('/say', { text: 'Shipping: Flat rate.', choices: [{ id: 'ship', choice: 'flat' }] })
  const ship = (await cardsNow()).brief.sections.find(s => s.id === 'ship')
  assert.deepEqual([ship.suggested, ship.status, ship.chosen, ship.settledBy], [undefined, 'settled', 'flat', 'you'])
  // The same mode again is said, not counted.
  out = await briefPost({ briefMode: 'brief' })
  assert.deepEqual([out.done, out.errors], [0, ['brief_mode: it is a brief already']])
})

test('in a decision, the bottom line becomes the proposal only when Claude writes it with nothing open', async () => {
  await briefPost({ isNew: true, brief: { mode: 'decide', bottomLine: 'Not yet.', sections: [{ id: 'a', kind: 'constraint', line: 'A?', choices: [{ id: 'x', label: 'X' }] }] } })
  await postJson('/say', { text: 'A: X.', choices: [{ id: 'a', choice: 'x' }] })
  assert.notEqual((await cardsNow()).brief.isProposal, true, 'all settled is not yet a proposal')
  await briefPost({ bottomLine: 'Do X.' })
  assert.equal((await cardsNow()).brief.isProposal, true)
  await briefPost({ briefOps: [{ op: 'reopen', id: 'a' }] })
  assert.equal((await cardsNow()).brief.isProposal, false)
})

test('an update refused on a settled constraint changes nothing; choices are never called accept, decline or reject', async () => {
  await briefPost({ isNew: true, brief: { mode: 'decide', bottomLine: 'B', sections: [{ id: 'k', kind: 'constraint', title: 'Old', line: 'K?', choices: [{ id: 'x', label: 'X' }, { id: 'reject', label: 'No' }, { id: 'y', label: '' }, { id: 'y', label: 'Y' }] }] } })
  let k = (await cardsNow()).brief.sections[0]
  assert.deepEqual(k.choices.map(c => c.id), ['x', 'y'])
  await postJson('/say', { text: 'K: X.', choices: [{ id: 'k', choice: 'x' }] })
  const out = await briefPost({ briefOps: [{ op: 'update', id: 'k', title: 'New', status: 'open' }] })
  assert.match(out.errors[0], /k: settled; reopen it to change that/)
  k = (await cardsNow()).brief.sections[0]
  assert.deepEqual([k.title, k.status], ['Old', 'settled'])
})

// ---------------------------------------------------------------- side boards

test('a side board: opened for a constraint, posts go where the person is, and its decision settles the main board', async () => {
  await briefPost({ isNew: true, board: 'main', brief: { mode: 'decide', bottomLine: 'Main.', sections: [{ id: 'database', kind: 'constraint', title: 'Database', line: 'Where do orders live?', choices: [{ id: 'rel', label: 'Relational' }] }, { id: 'note', line: 'A point.' }] } })
  // Only a main-board constraint can be decided by a side board; ids are checked.
  assert.match((await briefPost({ sideBoard: { id: 'x', title: 'X', for: 'note' }, brief: { bottomLine: 'b', sections: [] } })).boardError, /no constraint note/)
  assert.match((await briefPost({ sideBoard: { id: 'main', title: 'X' }, brief: { bottomLine: 'b', sections: [] } })).boardError, /not a board id/)
  const opened = await briefPost({
    sideBoard: { id: 'db', title: 'Relational vs not', for: 'database' },
    title: 'Fit', mermaid: 'flowchart LR\n  a --> b',
    brief: { bottomLine: 'Relational is safer.', options: [{ id: 'rel', label: 'Relational' }, { id: 'doc', label: 'Documents' }], sections: [{ id: 'tx', title: 'Together', line: 'One step.', cells: { rel: { mark: 'yes', text: 'Transactions.' }, doc: { mark: 'odd', text: 'Some.\nmore' }, 'bad id': { mark: 'no' } } }] },
  })
  assert.equal(opened.ok, true)
  let now = await cardsNow()
  assert.equal(now.viewing, 'db')
  const db = now.boards.find(b => b.id === 'db')
  assert.deepEqual([db.title, db.for, db.state, db.brief.mode], ['Relational vs not', 'database', 'open', 'decide'])
  assert.deepEqual(db.brief.sections[0].cells, { rel: { mark: 'yes', text: 'Transactions.' }, doc: { mark: 'unknown', text: 'Some. more' } })
  assert.equal(now.cards.findLast(c => c.kind === 'diagram').board, 'db')
  assert.equal(now.brief.bottomLine, 'Main.', 'the main brief is unchanged')
  // Claude's next change, naming no board, goes where the person is.
  await briefPost({ briefOps: [{ op: 'update', id: 'tx', cells: { doc: { mark: 'part', text: 'Multi-document transactions.' } } }] })
  now = await cardsNow()
  assert.deepEqual(now.boards.find(b => b.id === 'db').brief.sections[0].cells.doc, { mark: 'part', text: 'Multi-document transactions.' })
  assert.deepEqual(now.boards.find(b => b.id === 'db').brief.sections[0].cells.rel, { mark: 'yes', text: 'Transactions.' })
  // What the person types on it says where it comes from; their decision settles the main constraint and brings them back.
  const before = lines.length
  await postJson('/say', { text: 'I decide: Documents.', board: 'db', choices: [{ id: 'db', board: 'main', choice: 'doc' }] })
  await new Promise(r => setTimeout(r, 50))
  const said = lines.slice(before).at(-1).say
  assert.match(said, /^\(On the side board `db`, "Relational vs not":\)\nI decide: Documents\./)
  assert.match(said, /back on the main board, where "Database" is settled on Documents/)
  now = await cardsNow()
  const database = now.brief.sections.find(s => s.id === 'database')
  assert.deepEqual([database.status, database.chosen, database.settledBy, database.choices.map(c => c.id)], ['settled', 'doc', 'you', ['rel', 'doc']])
  assert.deepEqual([now.boards.find(b => b.id === 'db').state, now.viewing], ['decided', 'main'])
  // A decided board is decided once.
  await postJson('/say', { text: 'again', board: 'db', choices: [{ id: 'db', board: 'main', choice: 'rel' }] })
  assert.equal((await cardsNow()).brief.sections.find(s => s.id === 'database').chosen, 'doc')
})

test('side boards are parked, dropped or returned by Claude; three open at most; the person switching boards is where posts go', async () => {
  const open = id => briefPost({ sideBoard: { id, title: id.toUpperCase() }, brief: { bottomLine: id, sections: [] } })
  for (const id of ['s1', 's2', 's3']) assert.equal((await open(id)).ok, true)
  assert.match((await open('s4')).boardError, /3 side boards are open/)
  assert.equal((await briefPost({ sideBoardOp: { op: 'park', id: 's1' } })).ok, true)
  assert.equal((await briefPost({ sideBoardOp: { op: 'drop', id: 's2', why: 'not needed' } })).ok, true)
  assert.match((await briefPost({ sideBoardOp: { op: 'fly', id: 's3' } })).boardError, /return, park or drop/)
  assert.match((await briefPost({ sideBoardOp: { op: 'return', id: 's3', choice: 'nope' } })).boardError, /not one of the side board's options/)
  let now = await cardsNow()
  assert.deepEqual(now.boards.filter(b => b.id !== 'main' && b.id !== 'db').map(b => [b.id, b.state, b.why ?? null]), [['s1', 'parked', null], ['s2', 'dropped', 'not needed'], ['s3', 'open', null]])
  // The person goes to s3: Claude's next post, naming no board, lands there.
  assert.equal((await postJson('/view', { board: 's3' })).status, 200)
  assert.equal((await postJson('/view', { board: 'nope' })).status, 400)
  await briefPost({ bottomLine: 'S3, changed.' })
  now = await cardsNow()
  assert.equal(now.boards.find(b => b.id === 's3').brief.bottomLine, 'S3, changed.')
  // A post can name its board.
  await briefPost({ board: 'main', bottomLine: 'Main, changed.' })
  assert.equal((await cardsNow()).brief.bottomLine, 'Main, changed.')
  await briefPost({ sideBoardOp: { op: 'return', id: 's3' } })
  assert.equal((await cardsNow()).viewing, 'main')
})
