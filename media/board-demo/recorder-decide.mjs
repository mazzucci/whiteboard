// Records the whiteboard for the decision demo, acting as the person: waits for
// the board's URL (from the BROWSER hand-off), opens it in Chrome, saves every
// frame the page paints with its timestamp, settles most of Claude's
// constraints by clicking choices (Claude's lean, except one), adds an idea of
// its own, settles what is left, waits for the proposal, and wraps up. Page
// errors are logged, and so is the decision after each step.
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
  // In view first: a section low in the brief may be scrolled out of sight.
  await page.$eval(selector, el => el.scrollIntoView({ block: 'nearest' })).catch(() => {})
  await sleep(200)
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



/** The decision on the page: its header, and each section's id, state and choices. */
const decisionNow = () =>
  page.evaluate(() => ({
    mode: document.querySelector('.bottom-line .k')?.textContent ?? null,
    bottomLine: document.querySelector('.bottom-line p')?.textContent ?? null,
    sections: [...document.querySelectorAll('.brief .sec')].map(li => ({
      id: li.dataset.id,
      title: li.querySelector('.sec-title').childNodes[0]?.textContent ?? '',
      pill: li.querySelector('.pill')?.textContent ?? null,
      choices: [...li.querySelectorAll('[data-choose]')].map(b => ({ id: b.dataset.choose, lean: b.classList.contains('lean') })),
    })),
    marked: document.querySelectorAll('#canvas .st-open, #canvas .st-settled, #canvas .st-assumed').length,
  }))
const logDecision = async what => log(what, JSON.stringify(await decisionNow()))
/** Clicks a choice on each open or assumed constraint (Claude's lean, else the first), but `skip`. */
async function choose(skip = new Set()) {
  const now = await decisionNow()
  let n = 0
  for (const s of now.sections) {
    if (skip.has(s.id) || !s.choices.length || !['open', 'assumed', 'suggestion'].includes(s.pill)) continue
    const c = s.choices.find(c => c.lean) ?? s.choices[0]
    await clickOn(`.brief .sec[data-id="${s.id}"] [data-choose="${c.id}"]`, 450)
    n++
  }
  return n
}

try {
  await cursor()
  await moveTo(W - 300, H - 200, 1)
  await waitFor(s => s.tabs >= 1, 'the first diagram')
  mark('first diagram')
  await settled('Claude to finish the first answer')
  mark('first answer')
  const first = await decisionNow()
  await logDecision('decision')
  if (!/waiting on|proposal/.test(first.mode ?? '')) log('GLITCH? no decision (brief_mode decide) on the board:', first.mode)
  if (!first.marked) log('GLITCH? no constraint marks a box on the diagram')
  const open = first.sections.filter(s => s.pill === 'open')
  const held = open.at(-1)?.id
  await sleep(1500)
  const n = await choose(new Set(held ? [held] : []))
  mark(`chose ${n}`)
  await sleep(800)
  await clickOn('#text', 300)
  await page.type('#text', 'Also: some of our customers are businesses that pay by invoice.', { delay: 50 })
  await sleep(500)
  await page.keyboard.press('Enter')
  mark('sent choices and an idea')
  await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => log('Claude did not show it is working'))
  await settled('Claude to take the choices')
  mark('took the choices')
  await logDecision('decision after the choices')
  await sleep(1500)
  const m = await choose()
  mark(`chose ${m} more`)
  await sleep(600)
  await clickOn('#form [type=submit]', 300)
  mark('sent the rest')
  await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => {})
  await settled('Claude to propose')
  mark('proposed')
  const last = await decisionNow()
  await logDecision('decision at the end')
  if (!/proposal/.test(last.mode ?? '')) log('GLITCH? no proposal at the end:', last.mode)
  await moveTo(W - 300, 200, 20)
  await sleep(3000)
  await clickOn('#wrap', 500)
  mark('wrap up')
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
