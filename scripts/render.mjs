#!/usr/bin/env node
// Renders Mermaid files to PNG with the whiteboard's own renderer, exactly as
// the pane draws them. Needs `/whiteboard setup` to have run.
//
//   node scripts/render.mjs [--out dir] [--theme default] [--scale 2] file.mmd...
//
// Each file.mmd becomes <out>/file.png (out defaults to the file's own folder).

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const [value] = args.splice(i, 2).slice(1)
  return value
}
const out = option('out')
const theme = option('theme', 'default')
const scale = Number(option('scale', 2))
const files = args
if (!files.length) {
  console.error('usage: node scripts/render.mjs [--out dir] [--theme name] [--scale n] file.mmd...')
  process.exit(2)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const renderer = spawn(process.execPath, [join(root, 'plugin/renderer/renderd.mjs'), '--home', join(homedir(), '.cache/whiteboard')], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
renderer.on('exit', code => code && process.exit(code))
const ready = await new Promise(resolve => {
  let text = ''
  renderer.stdout.on('data', chunk => {
    text += chunk
    const line = /\{[^\n]*"ready":true[^\n]*\}/.exec(text)
    if (line) resolve(JSON.parse(line[0]))
  })
})

const render = body =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: ready.socket, method: 'POST', path: '/render' }, res => {
      let data = ''
      res.on('data', chunk => (data += chunk))
      res.on('end', () => resolve(JSON.parse(data)))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })

let failed = 0
for (const file of files) {
  // The same config the pane renders with: labels as SVG text.
  const result = await render({
    source: readFileSync(file, 'utf8'),
    theme,
    png: true,
    scale,
    config: { htmlLabels: false, flowchart: { htmlLabels: false } },
  })
  if (result.error) {
    failed++
    console.error(`${file}: ${result.error.split('\n').slice(0, 3).join(' ')}`)
    continue
  }
  const dir = out ?? dirname(file)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, basename(file).replace(/\.(mmd|mermaid)$/, '') + '.png')
  writeFileSync(target, Buffer.from(result.png, 'base64'))
  console.log(`${target} (${result.width}×${result.height})`)
}
renderer.kill()
process.exit(failed ? 1 : 0)
