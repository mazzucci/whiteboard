// Records the whiteboard for the charts demo, acting as the person: waits for
// the board's URL (from the BROWSER hand-off), opens it in Chrome, saves every
// frame the page paints with its timestamp, runs the pointer over Claude's
// chart, clicks the biggest slice or bar and asks about it, selects two marks
// (on Claude's next chart, or back on the first) and asks again, and wraps up. Page errors are logged.
//
//   node recorder.mjs <dir>    writes <dir>/frames/*.jpg and <dir>/frames.json, logs to stdout

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
// puppeteer-core from this folder (npm install puppeteer-core here), or from PUPPETEER_HOME.
const require = createRequire(process.env.PUPPETEER_HOME ? `${process.env.PUPPETEER_HOME}/package.json` : import.meta.url)
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
page.on('pageerror', e => log('PAGE ERROR', String(e)))
page.on('console', m => m.type() === 'error' && log('console error', m.text()))
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
    if (page.isClosed()) throw new Error('the page closed')
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

/** The marks of the chart on screen: label, what it says, where it is. */
const marksNow = () =>
  page.$$eval('#canvas [data-mark]', els =>
    els.map(el => {
      const r = el.getBoundingClientRect()
      // A point inside the mark (a slice's box centre may be outside it).
      let at = null
      for (const [fx, fy] of [[0.5, 0.5], [0.35, 0.35], [0.65, 0.65], [0.35, 0.65], [0.65, 0.35], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5]]) {
        const x = r.left + r.width * fx
        const y = r.top + r.height * fy
        if (document.elementFromPoint(x, y)?.closest('[data-mark]') === el) {
          at = { x, y }
          break
        }
      }
      return { label: el.dataset.label, say: el.querySelector('title')?.textContent ?? '', at, area: r.width * r.height }
    }),
  )
// The value is in the last brackets: `bar "x (1,240 calls)" (ms: 3100)`.
const valueOf = m => Number(/\(([^()]*)\)\s*$/.exec(m.say)?.[1]?.split(/:\s*|,\s*/).map(Number).find(Number.isFinite) ?? 0)
const chartOnScreen = () => page.$('#canvas svg.chart')

try {
  await cursor()
  await moveTo(W - 300, H - 200, 1)
  await waitFor(s => s.tabs >= 1, 'the first diagram')
  mark('first diagram')
  await settled('Claude to finish the first answer')
  mark('first answer')
  if (!(await chartOnScreen())) {
    log('GLITCH? the first diagram is not a clickable chart')
  } else {
    const marks = (await marksNow()).filter(m => m.at)
    log('marks', JSON.stringify(marks.map(m => m.say)))
    // The pointer runs over the marks, then clicks the biggest.
    for (const m of marks.slice(0, 6)) {
      await moveTo(m.at.x, m.at.y, 12)
      await sleep(350)
    }
    const big = [...marks].sort((a, b) => valueOf(b) - valueOf(a))[0]
    await moveTo(big.at.x, big.at.y, 15)
    await sleep(300)
    await page.mouse.click(big.at.x, big.at.y)
    mark('clicked ' + big.label)
    await sleep(1200)
    await clickOn('#text', 300)
    await page.type('#text', 'Why is this one so big?', { delay: 70 })
    await sleep(600)
    await page.keyboard.press('Enter')
    mark('asked')
  }
  const before = (await state()).tabs
  await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => log('Claude did not show it is working'))
  await settled('Claude to answer about the selection')
  const after = await state()
  mark('answered')
  log('answer', after.lastText.slice(0, 300).replace(/\s+/g, ' '))
  // Claude's answer may be a chart of its own, or another diagram: then back to the chart.
  if (!(await chartOnScreen())) {
    await sleep(2500)
    await clickOn('.tab:nth-child(1)', 1500)
    mark('back to the chart')
  }
  if (await chartOnScreen()) {
    const marks = (await marksNow()).filter(m => m.at)
    log('second chart marks', JSON.stringify(marks.map(m => m.say)))
    const two = [...marks].sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 2)
    await sleep(1500)
    for (const [i, m] of two.entries()) {
      await moveTo(m.at.x, m.at.y, 18)
      await sleep(300)
      if (i) await page.keyboard.down('Shift')
      await page.mouse.click(m.at.x, m.at.y)
      if (i) await page.keyboard.up('Shift')
      await sleep(700)
    }
    mark('selected two')
    await clickOn('#text', 300)
    await page.type('#text', 'Which of these two should we fix first?', { delay: 70 })
    await sleep(600)
    await page.keyboard.press('Enter')
    mark('asked again')
    await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => {})
    await settled('Claude to answer again')
    mark('answered again')
    log('answer', (await state()).lastText.slice(0, 300).replace(/\s+/g, ' '))
  } else {
    log('GLITCH? no chart to go back to (tabs', before, '->', after.tabs, ')')
  }
  await sleep(2500)
  await clickOn('#wrap', 500)
  mark('wrap up')
  // The page says the discussion is over, then closes itself.
  await waitFor(s => s.ended, 'the end', 300_000).catch(e => log(e.message))
  mark('wrapped up')
  await sleep(2500)
} catch (error) {
  log('error', error.message)
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {})
  writeFileSync(`${dir}/frames.json`, JSON.stringify({ frames, marks }, null, 1))
  log('frames', frames.length)
  await browser.close().catch(() => {})
}
