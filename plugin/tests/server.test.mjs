// The board server on its own: node --test plugin/tests/server.test.mjs
//
// Starts board/server.mjs, then checks who may reach it and that nothing a
// request sends can take it down.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
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
