#!/usr/bin/env node
// Builds the explainer video deterministically: a headless Chrome loads
// src/stage.html, build.mjs calls window.seek(t) for every frame, screenshots
// it and pipes the PNGs into ffmpeg (H.264, yuv420p, faststart).
//
//   node media/explainer/render-diagrams.mjs              # once, Mermaid -> SVG
//   node media/explainer/build.mjs --mode full            # out/whiteboard-explainer-1080p.mp4
//   node media/explainer/build.mjs --mode short           # out/whiteboard-readme-720p.mp4 (+ .gif)
//   node media/explainer/build.mjs --mode full --preview 2,6,12   # stills in build/preview-full/
//   node media/explainer/build.mjs --mode s30 --name whiteboard-30s-1080p
//   node media/explainer/build.mjs --mode s30 --small --name whiteboard-30s-readme-720p   # + .gif
//
// Puppeteer comes from the whiteboard's own cache (~/.cache/whiteboard), so
// nothing extra is installed.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? fallback : args[i + 1]
}
const mode = option('mode', 'full')
const fps = Number(option('fps', 30))
const preview = option('preview')
const FFMPEG = '/usr/local/bin/ffmpeg'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const home = join(homedir(), '.cache/whiteboard')
const require = createRequire(join(home, 'package.json'))
const puppeteer = (await import(require.resolve('puppeteer-core'))).default

const small = args.includes('--small') || mode === 'short'
const size = small ? { width: 1280, height: 720 } : { width: 1920, height: 1080 }
const diagrams = JSON.parse(readFileSync(join(here, 'build/diagrams.json'), 'utf8'))
const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--font-render-hinting=none', '--disable-lcd-text'] })
const page = await browser.newPage()
await page.setViewport({ ...size, deviceScaleFactor: 1 })
page.on('pageerror', e => console.error('page error:', e.message))
page.on('console', m => m.type() === 'error' && console.error('console:', m.text()))
await page.goto(pathToFileURL(join(here, 'src/stage.html')).href, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
const info = await page.evaluate((d, m, s) => window.init(d, m, s), diagrams, mode, small)
console.log(`mode ${mode}: ${info.duration}s at ${fps} fps, board canvas ${info.canvasW}×${info.canvasH}`)

// Caption readability check: >= 3 s + 0.3 s per word.
const tl = await page.evaluate(m => window.TIMELINES[m].captions.map(c => ({ ...c, text: c.text.replace(/<[^>]+>/g, '') })), mode)
for (const c of tl) {
  const words = c.text.split(/\s+/).filter(w => /\w/.test(w)).length
  const need = 3 + 0.3 * words
  if (c.t1 - c.t0 < need - 0.05) console.warn(`caption too short (${(c.t1 - c.t0).toFixed(1)}s < ${need.toFixed(1)}s): "${c.text}"`)
}

const shot = async t => {
  await page.evaluate(t => window.seek(t), t)
  return page.screenshot({ type: 'png', captureBeyondViewport: false })
}

if (preview) {
  const dir = join(here, `build/preview-${mode}`)
  mkdirSync(dir, { recursive: true })
  for (const t of preview.split(',').map(Number)) {
    const file = join(dir, `t${t.toFixed(2).padStart(6, '0')}.png`)
    writeFileSync(file, await shot(t))
    console.log(file)
  }
  await browser.close()
  process.exit(0)
}

const base = option('name', mode === 'short' ? 'whiteboard-readme-720p' : 'whiteboard-explainer-1080p')
const mp4 = join(outDir, `${base}.mp4`)
const ff = spawn(
  FFMPEG,
  ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-vf', 'format=yuv420p', mp4],
  { stdio: ['pipe', 'inherit', 'inherit'] },
)
const frames = Math.round(info.duration * fps)
const started = Date.now()
for (let i = 0; i < frames; i++) {
  const png = await shot(i / fps)
  if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r))
  if (i % 300 === 0) console.log(`frame ${i}/${frames} (${((Date.now() - started) / 1000).toFixed(0)}s)`)
}
ff.stdin.end()
await new Promise((resolve, reject) => ff.on('exit', code => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve())))
await browser.close()
console.log(`${mp4} (${(statSync(mp4).size / 1e6).toFixed(1)} MB)`)

if (small) {
  // README GIF: palette-based, 12 fps, kept under 7.5 MB (margin under GitHub's 8) by stepping the width down.
  for (const width of [1280, 960, 800]) {
    const gif = join(outDir, `${base}.gif`)
    const filters = `fps=12,scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', mp4, '-vf', filters, '-loop', '0', gif], { stdio: 'inherit' })
      p.on('exit', code => (code ? reject(new Error(`gif ffmpeg exited ${code}`)) : resolve()))
    })
    const mb = statSync(gif).size / 1e6
    console.log(`${gif} at ${width}px: ${mb.toFixed(1)} MB`)
    if (mb <= 7.5) break
  }
}
