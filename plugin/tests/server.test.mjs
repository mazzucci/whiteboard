// The board server on its own: node --test plugin/tests/server.test.mjs
//
// Starts board/server.mjs, then checks who may reach it and that nothing a
// request sends can take it down.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
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
  for (const path of ['/', '/app.js', '/app.css', '/mermaid.js']) {
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
  const app = names('app.js')
  assert.deepEqual([...names('editing.js')].filter(n => app.has(n)), [])
})
