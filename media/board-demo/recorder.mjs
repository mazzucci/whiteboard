// Records the whiteboard during a real Claude Code session, acting as the
// person: waits for the board's URL (from the BROWSER hand-off), opens it in
// Chrome, saves every frame the page paints with its timestamp, answers
// Claude's question on the page, shows the controls, and wraps up.
//
//   node media/board-demo/recorder.mjs <dir>   writes <dir>/frames/*.jpg and <dir>/frames.json
//
// Needs puppeteer-core (npm install puppeteer-core in this folder) and Google
// Chrome. See demo/RECORDING.md.

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
// puppeteer-core from this folder (npm install puppeteer-core here), or from PUPPETEER_HOME.
const require = createRequire(process.env.PUPPETEER_HOME ? `${process.env.PUPPETEER_HOME}/package.json` : import.meta.url)
const puppeteer = require('puppeteer-core')

const dir = process.argv[2]
// The page's size: REC_W and REC_H, for a take shown beside the Terminal.
const W = Number(process.env.REC_W) || 1440
const H = Number(process.env.REC_H) || 1000
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))

mkdirSync(`${dir}/frames`, { recursive: true })
log('waiting for the board URL')
while (!existsSync(`${dir}/url.txt`)) await sleep(200)
await sleep(100)
const url = readFileSync(`${dir}/url.txt`, 'utf8').trim()
log('board at', url.replace(/t=\w+/, 't=…'))

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
})
const page = await browser.newPage()
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])

// Every painted frame, with when it was painted.
const frames = []
const cdp = await page.createCDPSession()
cdp.on('Page.screencastFrame', async f => {
  const n = frames.length
  writeFileSync(`${dir}/frames/${String(n).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'))
  frames.push({ n, t: f.metadata.timestamp })
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})
const marks = []
const mark = label => {
  marks.push({ label, t: Date.now() / 1000 })
  log('mark', label)
}

await page.goto(url)
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
mark('open')

// A visible pointer, since a recording has none.
const cursor = async () =>
  page.evaluate(() => {
    if (document.getElementById('rec-cursor')) return
    const c = document.createElement('div')
    c.id = 'rec-cursor'
    c.style.cssText =
      'position:fixed;left:0;top:0;width:22px;height:22px;z-index:99;pointer-events:none;transform:translate(-3px,-2px);' +
      "background:no-repeat url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 22 22'><path d='M3 2l14 9-6.5 1.2L14 19l-2.6 1.3-3.4-6.6L3 18z' fill='black' stroke='white' stroke-width='1.4' stroke-linejoin='round'/></svg>\")"
    document.body.append(c)
    addEventListener('mousemove', e => {
      c.style.left = e.clientX + 'px'
      c.style.top = e.clientY + 'px'
    })
  })
let mouse = { x: W - 300, y: H - 200 }
const moveTo = async (x, y, steps = 25) => {
  await cursor()
  await page.mouse.move(x, y, { steps })
  mouse = { x, y }
}
const clickOn = async (selector, pause = 500) => {
  const box = await (await page.$(selector)).boundingBox()
  await moveTo(box.x + box.width / 2, box.y + box.height / 2)
  await sleep(250)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await sleep(pause)
}

const state = () =>
  page.evaluate(() => ({
    tabs: document.querySelectorAll('.tab').length,
    stickies: document.querySelectorAll('.sticky').length,
    isWorking: !document.getElementById('typing').hidden,
    last: [...document.querySelectorAll('.msg')].pop()?.className ?? '',
    lastText: [...document.querySelectorAll('.msg')].pop()?.textContent ?? '',
    ended: !!document.querySelector('.ended'),
  }))
const waitFor = async (test, what, limitMs = 600_000) => {
  const start = Date.now()
  for (;;) {
    const s = await state().catch(() => null)
    if (s && test(s)) return s
    if (Date.now() - start > limitMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(400)
  }
}
/** Claude idle for a moment: its turn is over. */
const settled = async what => {
  for (;;) {
    await waitFor(s => !s.isWorking, what)
    await sleep(2500)
    if (!(await state()).isWorking) return
  }
}

try {
  await cursor()
  await moveTo(W - 300, H - 200, 1)
  await waitFor(s => s.tabs >= 1, 'the first diagram')
  mark('first diagram')
  await sleep(600)
  // While Claude reads the trace, the cursor follows the request path box by
  // box, quickly, as someone reading it would: the page is live, not a slide.
  const boxes = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.node')]
        .map(n => n.getBoundingClientRect())
        .filter(r => r.width > 0)
        .map(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })),
    )
  tracing: for (;;) {
    for (const box of await boxes()) {
      if ((await state()).stickies >= 1) break tracing
      await moveTo(box.x, box.y, 6)
      await sleep(120)
    }
    await sleep(200)
  }
  // The trace, and the sticky note with Claude's question.
  await waitFor(s => s.stickies >= 1, 'a sticky note')
  mark('sticky note')
  await settled('Claude to ask')
  mark('asked')
  await sleep(1200)
  // Answer on the board.
  await clickOn('#text', 300)
  await page.type('#text', 'Yes, show me the proposal', { delay: 70 })
  await sleep(500)
  await page.keyboard.press('Enter')
  mark('said yes')
  const before = (await state()).tabs
  await waitFor(s => s.tabs > before, 'the proposal')
  mark('proposal drawn')
  await settled('Claude to finish')
  mark('settled')
  await sleep(1500)
  // Edit together: the board becomes a canvas; the person moves the proposed
  // box aside, selects it, and asks for a cache beside it; Claude amends it.
  await clickOn('.modes [data-mode="canvas"]', 300)
  await page.waitForSelector('.excalidraw', { timeout: 30_000 })
  await sleep(1500)
  mark('canvas')
  // Where a box of the canvas is on screen: the proposed one (lavender) by default.
  const boxOnScreen = fill =>
    page.evaluate(fill => {
      const { api } = window.boardCanvas()
      const s = api.getAppState()
      // The rightmost of them: the new piece at the end of the flow, with room around it.
      const e = api
        .getSceneElements()
        .filter(x => x.backgroundColor === fill && ['rectangle', 'ellipse', 'diamond'].includes(x.type))
        .sort((a, b) => b.x - a.x)[0]
      if (!e) return null
      const host = document.querySelector('.excalidraw').getBoundingClientRect()
      const z = s.zoom.value
      const at = { x: host.left + (e.x + e.width / 2 + s.scrollX) * z, y: host.top + (e.y + e.height / 2 + s.scrollY) * z, h: e.height * z }
      // Only a box in view: a drag elsewhere would land on something else.
      return at.x > host.left + 20 && at.x < host.right - 20 && at.y > host.top + 60 && at.y < host.bottom - 60 ? at : null
    }, fill)
  const shapes = () => page.evaluate(() => window.boardCanvas().api.getSceneElements().filter(e => ['rectangle', 'ellipse', 'diamond'].includes(e.type)).length)
  const box = await boxOnScreen('#f1ebfc')
  if (box) {
    // Drag it down a little, as a person tidying the board would.
    await moveTo(box.x, box.y, 18)
    await page.mouse.down()
    await moveTo(box.x + 10, box.y + box.h * 1.6, 22)
    await page.mouse.up()
    await sleep(700)
    mark('moved')
    // The drag leaves it selected: the question is about it.
  }
  const boxesBefore = await shapes()
  await clickOn('#text', 300)
  await page.type('#text', 'Add a stock cache next to this, in teal', { delay: 60 })
  await sleep(400)
  await page.keyboard.press('Enter')
  mark('asked to amend')
  for (let i = 0; i < 400 && (await shapes()) <= boxesBefore; i++) await sleep(400)
  mark('amended')
  await settled('Claude to finish the amendment')
  await sleep(1800)
  mark('settled again')
  // Wrap up: Claude summarises in the terminal and closes the board.
  await clickOn('#wrap', 300)
  mark('wrap up')
  await waitFor(s => s.ended, 'the wrap-up', 300_000)
  mark('wrapped up')
  await sleep(3500)
} catch (error) {
  log('error', error.message)
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {})
  writeFileSync(`${dir}/frames.json`, JSON.stringify({ frames, marks }, null, 1))
  log('frames', frames.length)
  await browser.close().catch(() => {})
}
