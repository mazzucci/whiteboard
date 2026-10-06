// Records the whiteboard for the before/after demo (a question, then a
// follow-up typed on the board), acting as the
// person: waits for the board's URL (from the BROWSER hand-off), opens it in
// Chrome, saves every frame the page paints with its timestamp, answers
// Claude's question on the page, shows the controls, and wraps up.
//
//   node recorder.mjs <dir>    writes <dir>/frames/*.jpg and <dir>/frames.json, logs to stdout

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const require = createRequire(`${process.env.HOME}/.cache/whiteboard/package.json`)
const puppeteer = require('puppeteer-core')

const dir = process.argv[2]
const W = 1440
const H = 1000
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
  await settled('Claude to finish the first answer')
  mark('first answer')
  await sleep(2500)
  // The follow-up, asked on the board.
  await clickOn('#text', 300)
  await page.type('#text', 'What does PKCE add?', { delay: 75 })
  await sleep(500)
  await page.keyboard.press('Enter')
  mark('asked follow-up')
  const before = (await state()).tabs
  await waitFor(s => s.tabs > before, 'the second diagram')
  mark('second diagram')
  await settled('Claude to finish the second answer')
  mark('second answer')
  await sleep(2500)
  // Back to the first flow and forward again.
  await clickOn('.tab:nth-child(1)', 2200)
  mark('first tab')
  await clickOn('.tab:nth-child(2)', 2500)
  mark('second tab')
} catch (error) {
  log('error', error.message)
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {})
  writeFileSync(`${dir}/frames.json`, JSON.stringify({ frames, marks }, null, 1))
  log('frames', frames.length)
  await browser.close().catch(() => {})
}
