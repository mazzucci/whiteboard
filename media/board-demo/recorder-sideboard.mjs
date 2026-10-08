// Records the whiteboard for the side-board demo, acting as the person: waits
// for the board's URL (from the BROWSER hand-off), opens it in Chrome, saves
// every frame the page paints with its timestamp, settles Claude's constraints
// but the database, says "let's whiteboard" that one, reads the side board
// Claude opens, decides on it, waits for Claude to carry the decision back to
// the main board and propose, and wraps up. Page errors are logged.
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




const state2 = () =>
  page.evaluate(() => ({
    board: typeof boardOn === 'string' ? boardOn : null,
    head: document.querySelector('.bottom-line .k')?.textContent ?? null,
    bottomLine: document.querySelector('.bottom-line p')?.textContent ?? null,
    sections: [...document.querySelectorAll('.brief .sec')].map(li => ({
      id: li.dataset.id,
      title: li.querySelector('.sec-title')?.childNodes[0]?.textContent ?? '',
      pill: li.querySelector('.pill')?.textContent ?? null,
      choices: [...li.querySelectorAll('[data-choose]')].map(b => ({ id: b.dataset.choose, lean: b.classList.contains('lean') })),
    })),
    options: [...document.querySelectorAll('[data-decide]')].map(b => b.dataset.decide),
    rows: document.querySelectorAll('.cmp tr.crit-row').length,
    sides: [...document.querySelectorAll('.brief .side')].map(s => s.textContent),
  }))
const logState = async what => log(what, JSON.stringify(await state2()))
async function choose(skip) {
  let n = 0
  for (const s of (await state2()).sections) {
    if (skip(s) || !s.choices.length || !['open', 'assumed', 'suggestion'].includes(s.pill)) continue
    const c = s.choices.find(c => c.lean) ?? s.choices[0]
    await clickOn(`.brief .sec[data-id="${s.id}"] [data-choose="${c.id}"]`, 400)
    n++
  }
  return n
}
const isDatabase = s => /data|stor|orders/i.test(`${s.id} ${s.title}`)

try {
  await cursor()
  await moveTo(W - 300, H - 200, 1)
  await waitFor(s => s.tabs >= 1, 'the first diagram')
  mark('first diagram')
  await settled('Claude to finish the first answer')
  mark('first answer')
  await logState('decision')
  const db = (await state2()).sections.find(isDatabase)
  if (!db) log('GLITCH? no database constraint to whiteboard')
  await sleep(1200)
  mark(`chose ${await choose(s => s === db || isDatabase(s))}`)
  await clickOn('#text', 300)
  await page.type('#text', "Let's whiteboard relational vs non-relational for where orders and stock live.", { delay: 45 })
  await sleep(500)
  await page.keyboard.press('Enter')
  mark('asked to whiteboard')
  await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => log('Claude did not show it is working'))
  await settled('Claude to open the side board')
  mark('side board')
  const side = await state2()
  await logState('side board')
  if (side.board === 'main') log('GLITCH? no side board opened')
  if (!side.rows) log('GLITCH? no comparison on the side board')
  // Down the comparison, then decide on the first option (Claude's lean comes first, usually).
  for (const tr of await page.$$('.cmp tr.crit-row')) {
    const box = await tr.boundingBox()
    if (box) await moveTo(box.x + 60, box.y + box.height / 2, 10)
    await sleep(500)
  }
  if (side.options.length) {
    await clickOn(`[data-decide="${side.options[0]}"]`, 600)
    mark('picked ' + side.options[0])
    await clickOn('#form [type=submit]', 300)
    mark('decided')
    await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => {})
    await settled('Claude to carry the decision back')
    mark('back on the main board')
    await logState('main board after the decision')
    if ((await state2()).board !== 'main') log('GLITCH? not back on the main board')
  }
  // Settle what is left, for a proposal.
  const rest = await choose(() => false)
  if (rest) {
    await clickOn('#form [type=submit]', 300)
    mark('settled the rest')
    await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => {})
    await settled('Claude to propose')
  }
  mark('proposed')
  await logState('at the end')
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
