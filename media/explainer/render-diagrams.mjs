#!/usr/bin/env node
// Renders every src/diagrams/*.mmd with the whiteboard's own renderer
// (Mermaid 12.1 in headless Chrome, labels as SVG text) into
// build/diagrams.json: { name: { svg, width, height, error? } }. A diagram that
// Mermaid rejects is kept with its error text, so the video can show the real
// message. Also writes build/png/<name>.png for visual checking.
//
//   node media/explainer/render-diagrams.mjs        (from anywhere)

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const src = join(here, 'src', 'diagrams')
const build = join(here, 'build')
mkdirSync(join(build, 'png'), { recursive: true })

const renderer = spawn(process.execPath, [join(root, 'renderer/renderd.mjs'), '--home', join(homedir(), '.cache/whiteboard')], {
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
console.log(`renderer ready: mermaid ${ready.mermaid}`)

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

const out = {}
for (const file of readdirSync(src).filter(f => f.endsWith('.mmd')).sort()) {
  const name = file.replace(/\.mmd$/, '')
  const source = readFileSync(join(src, file), 'utf8')
  const result = await render({
    source,
    theme: 'default',
    png: true,
    scale: 2,
    config: { htmlLabels: false, flowchart: { htmlLabels: false } },
  })
  if (result.error) {
    out[name] = { source, error: result.error }
    console.log(`${name}: ERROR ${result.error.split('\n')[0]}`)
    continue
  }
  out[name] = { source, svg: result.svg, width: result.width, height: result.height, type: result.type }
  writeFileSync(join(build, 'png', `${name}.png`), Buffer.from(result.png, 'base64'))
  console.log(`${name}: ${result.width}×${result.height} ${result.type}`)
}
writeFileSync(join(build, 'diagrams.json'), JSON.stringify(out))
renderer.kill()
process.exit(0)
