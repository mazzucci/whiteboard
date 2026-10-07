// Converts every diagram in fixtures/ to a canvas on the real board page and
// reports what each became: boxes and arrows (editable), or a refusal. A
// diagram that becomes an empty canvas fails. Needs Google Chrome and
// puppeteer-core (PUPPETEER_HOME, or installed beside this file).
//
//   node editor/test/convert.mjs
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const root = new URL('../../', import.meta.url)
const require = createRequire(process.env.PUPPETEER_HOME ? `${process.env.PUPPETEER_HOME}/package.json` : import.meta.url)
const puppeteer = require('puppeteer-core')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const server = spawn(process.execPath, [new URL('plugin/board/server.mjs', root).pathname], { stdio: ['ignore', 'pipe', 'inherit'] })
const ready = await new Promise(r => server.stdout.on('data', d => { for (const l of String(d).split('\n')) if (l.includes('"ready"')) r(JSON.parse(l)) }))
const call = (path, body) =>
  fetch(`http://127.0.0.1:${ready.port}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-board-token': ready.token }, body: body && JSON.stringify(body) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: { width: 1280, height: 860 } })
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error' && !/Content Security Policy|esm\.sh|net::ERR/.test(m.text())) errors.push(m.text()) })
await page.goto(ready.url)
await call('/post', { mode: 'canvas' })

let failed = 0
for (const name of readdirSync(new URL('fixtures/', root)).filter(n => n.endsWith('.mmd')).sort()) {
  const mermaid = readFileSync(new URL(`fixtures/${name}`, root), 'utf8')
  errors.length = 0
  const posted = await call('/post', { title: name, mermaid })
  let scene = null
  let refused = null
  for (let i = 0; i < 40 && !scene && !refused; i++) {
    await sleep(300)
    scene = (await call('/cards')).scenes?.[posted.id] ?? null
    refused = await page.evaluate(() => document.getElementById('edit-note')?.textContent || null)
  }
  const boxes = scene?.boxes?.length ?? 0
  const arrows = scene?.arrows?.length ?? 0
  const verdict = scene ? (boxes ? 'editable' : 'EMPTY CANVAS') : refused ? 'not editable (said so)' : 'drawing'
  if (verdict === 'EMPTY CANVAS') failed++
  console.log(`${name.padEnd(26)} ${verdict.padEnd(24)} boxes ${String(boxes).padStart(2)}  arrows ${String(arrows).padStart(2)}  images ${scene?.images ?? 0}${errors.length ? `  errors: ${errors.slice(0, 2).join(' | ').slice(0, 160)}` : ''}`)
}
await browser.close()
server.kill()
process.exit(failed ? 1 : 0)
