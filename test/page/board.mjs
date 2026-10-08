// What the page tests share: a board server of their own, a headless Chrome,
// the plugin's side of the board (posts, reads), and the canvas on a page.
//
// Chrome: CHROME_PATH, else the usual place on macOS or Linux.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].find(p => p && existsSync(p))

export const sleep = ms => new Promise(r => setTimeout(r, ms))

/** A board server, as the plugin starts one, and a browser to open its page in. */
export async function board() {
  const server = spawn(process.execPath, [new URL('../../plugin/board/server.mjs', import.meta.url).pathname, '--label', 'tests'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const said = []
  const ready = await new Promise((resolve, reject) => {
    server.on('exit', code => reject(new Error(`the board stopped (${code})`)))
    server.stdout.on('data', d => {
      for (const line of String(d).split('\n').filter(Boolean)) {
        const m = JSON.parse(line)
        if (m.ready) resolve(m)
        if (m.say) said.push(m.say)
      }
    })
  })
  if (!CHROME) throw new Error('no Chrome: set CHROME_PATH')
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: 1280, height: 860 },
    args: process.env.CI ? ['--no-sandbox'] : [],
  })
  /** The plugin's side: a POST to /post (or another route), or a GET. */
  const call = (path, body) =>
    fetch(`http://127.0.0.1:${ready.port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-board-token': ready.token },
      body: body && JSON.stringify(body),
    }).then(r => r.json())
  const pages = []
  /** A page of the board, as the person opens it; its errors are kept. */
  async function open() {
    const page = await browser.newPage()
    page.errors = []
    page.on('pageerror', e => page.errors.push(String(e)))
    await page.goto(ready.url)
    // A fresh CI runner's first Chrome page can take longer than ten seconds.
    await page.waitForFunction(() => document.getElementById('conn')?.classList.contains('on'), { timeout: 30_000 })
    pages.push(page)
    return page
  }
  return {
    call,
    open,
    said,
    /** Every diagram's canvas summary, by card id. */
    scenes: async () => (await call('/cards')).scenes ?? {},
    /** Waits until `test` holds (polling), or fails after `ms`. */
    async until(test, what, ms = 20_000) {
      const start = Date.now()
      for (;;) {
        const value = await test()
        if (value) return value
        if (Date.now() - start > ms) throw new Error(`timed out: ${what}`)
        await sleep(200)
      }
    },
    async close() {
      await browser.close().catch(() => {})
      server.kill()
    },
  }
}

/** The page's state: the diagram on screen, whether it is a canvas, Edit, the mode, the zoom, the Send button. */
export const look = page =>
  page.evaluate(() => ({
    tab: document.querySelector('.tab[aria-selected="true"]')?.title ?? null,
    isCanvas: document.body.classList.contains('editing'),
    canEdit: !document.getElementById('edit').hidden,
    mode: document.querySelector('.modes [aria-pressed="true"]')?.dataset.mode,
    zoom: document.getElementById('pct').textContent,
    send: document.querySelector('#form [type=submit]').textContent,
    note: document.getElementById('edit-note')?.hidden ? '' : document.getElementById('edit-note')?.textContent ?? '',
  }))

/** Moves a box on the page's canvas, as a drag would (with its label), by its ref. */
export const move = (page, ref, dy = 150) =>
  page.evaluate(
    async (ref, dy) => {
      // As a person would: once the diagram is on the canvas.
      const { api } = await window.boardCanvas().ready.then(() => window.boardCanvas())
      const els = api.getSceneElementsIncludingDeleted()
      const box = els.find(e => e.customData?.ref === ref)
      api.updateScene({
        elements: els.map(e => (e.id === box.id || e.containerId === box.id ? { ...e, y: e.y + dy, version: e.version + 1, versionNonce: e.versionNonce + 1 } : e)),
      })
    },
    ref,
    dy,
  )

/** Selects a box on the page's canvas, by its ref. */
export const select = (page, ref) =>
  page.evaluate(async ref => {
    const { api } = await window.boardCanvas().ready.then(() => window.boardCanvas())
    const box = api.getSceneElements().find(e => e.customData?.ref === ref)
    api.updateScene({ appState: { selectedElementIds: { [box.id]: true } } })
  }, ref)

/** Types a message on the page and sends it. */
export async function send(page, text) {
  await page.type('#text', text)
  await page.click('#form [type=submit]')
}

/** Shows the page's nth diagram (1 is the first), clicking its tab in one step (tabs are redrawn often). */
export const showTab = (page, n) => page.evaluate(n => document.querySelectorAll('.tab')[n - 1].click(), n)
