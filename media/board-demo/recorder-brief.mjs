// Records the whiteboard for the brief demo, acting as the person: waits for
// the board's URL (from the BROWSER hand-off), opens it in Chrome, saves every
// frame the page paints with its timestamp, runs the pointer down Claude's
// brief (each section lights up its boxes), picks one and asks about it, asks
// for more detail on another, asks a question that should change the brief,
// and wraps up. Page errors are logged, and so is what changed in the brief.
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


/** The brief on the page: each section's id, title, line, whether it has a body, and its questions. */
const briefNow = () =>
  page.evaluate(() => ({
    bottomLine: document.querySelector('.bottom-line p')?.textContent ?? null,
    sections: [...document.querySelectorAll('.brief .sec')].map(li => ({
      id: li.dataset.id,
      title: li.querySelector('.sec-title').textContent,
      line: li.querySelector('.line').textContent,
      was: li.querySelector('.was')?.textContent ?? null,
      hasBody: !!li.querySelector('.body'),
      asks: [...li.querySelectorAll('.qa')].map(q => q.innerText.replace(/\s+/g, ' ').trim()),
    })),
    dropped: [...document.querySelectorAll('.brief .dropped .d')].map(d => d.textContent.trim()),
    lit: document.querySelectorAll('#canvas .is-focus').length,
  }))
const logBrief = async what => log(what, JSON.stringify(await briefNow()))

try {
  await cursor()
  await moveTo(W - 300, H - 200, 1)
  await waitFor(s => s.tabs >= 1, 'the first diagram')
  mark('first diagram')
  await settled('Claude to finish the first answer')
  mark('first answer')
  const first = await briefNow()
  await logBrief('brief')
  if (!first.sections.length) {
    log('GLITCH? no brief beside the diagram')
  } else {
    // Down the brief: each section lights up what it is about.
    for (const s of first.sections) {
      const box = await (await page.$(`.brief .sec[data-id="${s.id}"]`)).boundingBox()
      await moveTo(box.x + 40, box.y + box.height / 2, 14)
      await sleep(650)
      const lit = (await briefNow()).lit
      if (!lit) log(`GLITCH? section ${s.id} lights up nothing`)
    }
    mark('pointed down the brief')
    // Pick a section about the flow (else the third) and ask about it.
    const flow = first.sections.find(s => /flow|code|grant/i.test(s.title + s.id)) ?? first.sections[Math.min(2, first.sections.length - 1)]
    await clickOn(`.brief .sec[data-id="${flow.id}"]`, 900)
    mark('picked ' + flow.id)
    await clickOn('#text', 300)
    await page.type('#text', 'Why not just send the token back directly?', { delay: 60 })
    await sleep(600)
    await page.keyboard.press('Enter')
    mark('asked about ' + flow.id)
    await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => log('Claude did not show it is working'))
    await settled('Claude to answer under the section')
    mark('answered')
    const after = await briefNow()
    await logBrief('brief after the question')
    const asked = after.sections.find(s => s.id === flow.id)
    if (!asked?.asks.some(a => !/Waiting for Claude/.test(a))) log('GLITCH? no answer under the section')
    // More detail on another section.
    const other = after.sections.find(s => s.id !== flow.id && !s.hasBody && /token|pkce|scope|refresh/i.test(s.title + s.id)) ?? after.sections.find(s => s.id !== flow.id && !s.hasBody)
    if (other) {
      await sleep(1500)
      await clickOn(`.brief .sec[data-id="${other.id}"]`, 700)
      await clickOn(`.brief .sec[data-id="${other.id}"] [data-act="more"]`, 300)
      mark('more detail on ' + other.id)
      await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => {})
      await settled('Claude to add detail')
      mark('detailed')
      const detailed = (await briefNow()).sections.find(s => s.id === other.id)
      if (!detailed?.hasBody) log('GLITCH? no detail under', other.id)
    }
    // A question that should change the brief itself.
    await sleep(1500)
    await clickOn('#text', 300)
    await page.type('#text', 'Our app is a mobile app with no backend of its own. Adjust the brief for that.', { delay: 55 })
    await sleep(600)
    await page.keyboard.press('Enter')
    mark('asked to adjust')
    await waitFor(s => s.isWorking, 'Claude to start', 60_000).catch(() => {})
    await settled('Claude to adjust the brief')
    mark('adjusted')
    await logBrief('brief after adjusting')
    await moveTo(W - 300, 200, 20)
    await sleep(3000)
  }
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
