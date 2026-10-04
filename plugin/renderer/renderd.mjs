#!/usr/bin/env node
// A warm Mermaid renderer: one headless browser page with Mermaid loaded,
// answering render requests over HTTP on a private Unix socket.
//
//   node renderd.mjs --home <dir> [--idle-ms 1800000]
//
// <home> holds what setup installed: node_modules/puppeteer-core,
// mermaid.min.js + mermaid.version, and browser.json when no installed browser
// was found. The socket goes in <home>/run (0700); its path is printed once ready:
//
//   {"ready":true,"socket":"...","browser":"...","mermaid":"12.1.0"}
//
//   GET  /health                                   -> { ok, mermaid, browser }
//   POST /quit                                     -> stops, as when idle
//   POST /render { source, theme?, config?, png?, scale? }
//        -> { svg, png?, width, height, background, type, ms } | 400 { error }

import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const home = arg('home')
const idleMs = Number(arg('idle-ms', 30 * 60 * 1000))
if (!home) {
  console.error('usage: renderd.mjs --home <dir>')
  process.exit(2)
}

// Chromium-based browsers already on the machine, preferred over a download.
const INSTALLED = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

function findBrowser() {
  const pinned = join(home, 'browser.json')
  if (existsSync(pinned)) {
    const { executablePath } = JSON.parse(readFileSync(pinned, 'utf8'))
    if (executablePath && existsSync(executablePath)) return executablePath
  }
  return INSTALLED.find(p => existsSync(p))
}

const require = createRequire(join(home, 'package.json'))
const puppeteer = (await import(require.resolve('puppeteer-core'))).default
const mermaidJs = join(home, 'mermaid.min.js')
const mermaidVersion = readFileSync(join(home, 'mermaid.version'), 'utf8').trim()
const executablePath = findBrowser()
if (!executablePath) {
  console.error('No Chromium-based browser found: run setup to download a headless one.')
  process.exit(3)
}

// Headless, with its own throwaway profile: no window, and nothing of the
// person's own browsing is read or written. The browser's sandbox stays on.
const browser = await puppeteer.launch({ executablePath, headless: true })
const page = await browser.newPage()
// No network: a diagram can name a remote image (an `img` node, a style's
// url()), and loading it would send a request, maybe carrying data, from a
// diagram Claude wrote. Only inline data and the page itself may load.
await page.setRequestInterception(true)
page.on('request', req => {
  const url = req.url()
  if (url.startsWith('data:') || url === 'about:blank') req.continue()
  else req.abort('blockedbyclient')
})
const ROOM = { width: 4096, height: 4096 }
await page.setViewport({ ...ROOM, deviceScaleFactor: 1 })
await page.setContent('<!doctype html><html><body style="margin:0"><div id="out"></div></body></html>')
await page.addScriptTag({ path: mermaidJs })
await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false }))

let count = 0
// Mermaid's render is not reentrant: one at a time.
let queue = Promise.resolve()
const serial = fn => {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

async function render({ source, theme = 'default', config = {}, png = false, scale = 2 }) {
  const id = `d${++count}`
  // Lay out in the same large room every time, so no diagram is measured
  // against the size of the last snapshot.
  await page.setViewport({ ...ROOM, deviceScaleFactor: 1 })
  const out = await page.evaluate(
    async (src, theme, config, id) => {
      // Initialize per render: the theme is per diagram, and a front-matter or
      // %%{init}%% block in the source still wins over it. Strict: no scripts,
      // no click callbacks, HTML in labels escaped.
      window.mermaid.initialize({ startOnLoad: false, theme, ...config, securityLevel: 'strict' })
      try {
        const rendered = await window.mermaid.render(id, src)
        // Mermaid paints an edge label's background half transparent (opacity
        // 0.5 over a fill with alpha 0.8), so the line it sits on shows through
        // the text. Make that one rule solid, in the colour the theme chose.
        const svg = rendered.svg.replace(/(\.edgeLabel rect\{)([^}]*)\}/g, (_, head, body) =>
          `${head}${body
            .replace(/opacity:\s*[\d.]+/g, 'opacity:1')
            .replace(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)/g, 'rgb($1,$2,$3)')}}`,
        )
        const host = document.getElementById('out')
        host.innerHTML = svg
        // The drawing's own size: its viewBox, which Mermaid sizes to the content.
        const el = host.querySelector('svg')
        const vb = el.viewBox.baseVal
        const width = Math.ceil(vb?.width || el.getBoundingClientRect().width)
        const height = Math.ceil(vb?.height || el.getBoundingClientRect().height)
        el.style.width = `${width}px`
        el.style.height = `${height}px`
        el.style.maxWidth = 'none'
        // The background the theme paints behind the drawing (Mermaid's SVG is
        // transparent), and the diagram type, both after this render's config.
        const background = window.mermaid.mermaidAPI.getConfig().themeVariables?.background
        const type = el.getAttribute('aria-roledescription') ?? ''
        return { svg, width, height, background, type }
      } catch (err) {
        document.getElementById(`d${id}`)?.remove()
        return { error: String(err?.message ?? err) }
      }
    },
    source,
    theme,
    config,
    id,
  )
  if (out.error || !png) return out
  await page.setViewport({ width: Math.max(1, out.width), height: Math.max(1, out.height), deviceScaleFactor: scale })
  // Mermaid's SVG is transparent: paint the theme's own background behind it,
  // so a dark theme is not drawn over the page's white.
  await page.evaluate(bg => (document.body.style.background = bg), out.background || 'white')
  const el = await page.$('#out svg')
  const shot = await el.screenshot({ encoding: 'base64', omitBackground: false })
  return { ...out, png: shot }
}

let idle
const touch = () => {
  clearTimeout(idle)
  idle = setTimeout(shutdown, idleMs)
}

const server = createServer((req, res) => {
  touch()
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET' && req.url === '/health') {
    return reply(200, { ok: true, mermaid: mermaidVersion, browser: executablePath })
  }
  // Before its files are deleted (/whiteboard uninstall): stop now, not when idle.
  if (req.method === 'POST' && req.url === '/quit') {
    reply(200, { ok: true })
    return setTimeout(shutdown, 10)
  }
  if (req.method !== 'POST' || req.url !== '/render') return reply(404, { error: 'not found' })
  let body = ''
  req.on('data', chunk => (body += chunk))
  req.on('end', async () => {
    let input
    try {
      input = JSON.parse(body)
    } catch {
      return reply(400, { error: 'body is not JSON' })
    }
    if (typeof input?.source !== 'string') return reply(400, { error: '`source` is required' })
    const started = performance.now()
    try {
      const out = await serial(() => render(input))
      const ms = Math.round(performance.now() - started)
      return out.error ? reply(400, { ...out, ms }) : reply(200, { ...out, ms })
    } catch (err) {
      return reply(500, { error: String(err?.message ?? err) })
    }
  })
})

// A private directory and an unguessable name: no other local user can reach
// the renderer, and no one can plant a path in its way.
// Socket paths are capped near 104 bytes: a home too deep for one gets a
// fresh private directory under the system's temp instead.
const name = `${randomBytes(8).toString('hex')}.sock`
let runDir = join(home, 'run')
let isTemp = false
if (join(runDir, name).length > 100) {
  runDir = mkdtempSync(join(tmpdir(), 'diagram-'))
  isTemp = true
} else {
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
}
chmodSync(runDir, 0o700)
const socket = join(runDir, name)

async function shutdown() {
  server.close()
  await browser.close().catch(() => {})
  if (existsSync(socket)) unlinkSync(socket)
  if (isTemp) rmSync(runDir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(socket, () => {
  chmodSync(socket, 0o600)
  touch()
  console.log(JSON.stringify({ ready: true, socket, browser: executablePath, mermaid: mermaidVersion }))
})
