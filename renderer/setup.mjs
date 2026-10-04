#!/usr/bin/env node
// Installs what renderd.mjs needs into <home>, one confirmed step at a time.
// The plugin asks the person before each download, then runs that step alone:
//
//   node setup.mjs --home <dir> --mermaid 12.1.0 --puppeteer 25.12.0 --plan
//     downloads nothing; prints what is missing:
//     {"step":"plan","puppeteer":false,"mermaid":true,"browser":"/Applications/…"}
//   node setup.mjs … --step puppeteer   puppeteer-core from npm (drives a browser,
//                                       never downloads one itself)
//   node setup.mjs … --step mermaid     mermaid.min.js, the one file of Mermaid's
//                                       npm package the page loads
//   node setup.mjs … --step browser     a headless Chrome shell, for when no
//                                       Chromium-based browser is installed
//   node setup.mjs … --remove           deletes <home>, only if it is the
//                                       renderer's own (/whiteboard uninstall)
//
// Each step prints one JSON line per stage and ends with "done" or "error".

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const home = arg('home')
const mermaid = arg('mermaid')
const puppeteer = arg('puppeteer')
const step = arg('step')
const isPlan = process.argv.includes('--plan')
const isRemove = process.argv.includes('--remove')
if (!home || !mermaid || !puppeteer || (!isPlan && !isRemove && !['puppeteer', 'mermaid', 'browser'].includes(step))) {
  console.error('usage: setup.mjs --home <dir> --mermaid <version> --puppeteer <version> (--plan | --step puppeteer|mermaid|browser | --remove)')
  process.exit(2)
}

const say = (step, message) => console.log(JSON.stringify({ step, message }))
const npm = join(dirname(process.execPath), 'npm')
const run = (args, cwd) => execFileSync(npm, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

const INSTALLED = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** The browser renderd.mjs would use: one this setup downloaded, else an installed one. */
function browserFound() {
  const pinned = join(home, 'browser.json')
  if (existsSync(pinned)) {
    const { executablePath } = JSON.parse(readFileSync(pinned, 'utf8'))
    if (executablePath && existsSync(executablePath)) return executablePath
  }
  return INSTALLED.find(p => existsSync(p)) ?? null
}

const versionOf = file => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '')

try {
  if (isPlan) {
    const pkg = join(home, 'node_modules/puppeteer-core/package.json')
    console.log(
      JSON.stringify({
        step: 'plan',
        puppeteer: existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).version === puppeteer,
        mermaid: existsSync(join(home, 'mermaid.min.js')) && versionOf(join(home, 'mermaid.version')) === mermaid,
        browser: browserFound(),
      }),
    )
    process.exit(0)
  }

  if (isRemove) {
    // Only a folder this setup made: its package.json names the renderer.
    const pkg = join(home, 'package.json')
    if (!existsSync(pkg) || JSON.parse(readFileSync(pkg, 'utf8')).name !== 'diagram-renderer') {
      throw new Error(`${home} is not the diagram renderer's folder; nothing was deleted.`)
    }
    rmSync(home, { recursive: true, force: true })
    say('done', `Deleted ${home}.`)
    process.exit(0)
  }

  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  if (!existsSync(join(home, 'package.json'))) {
    writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'diagram-renderer', private: true }, null, 2))
  }

  if (step === 'puppeteer') {
    say('puppeteer', `Installing puppeteer-core ${puppeteer}…`)
    run(['install', '--no-audit', '--no-fund', '--save-exact', `puppeteer-core@${puppeteer}`], home)
  }

  if (step === 'mermaid') {
    say('mermaid', `Fetching Mermaid ${mermaid}…`)
    const tmp = mkdtempSync(join(tmpdir(), 'diagram-setup-'))
    try {
      const tarball = run(['pack', `mermaid@${mermaid}`, '--pack-destination', tmp], tmp).trim().split('\n').at(-1)
      execFileSync('tar', ['-xzf', join(tmp, tarball), '-C', tmp, 'package/dist/mermaid.min.js'])
      renameSync(join(tmp, 'package/dist/mermaid.min.js'), join(home, 'mermaid.min.js'))
      writeFileSync(join(home, 'mermaid.version'), mermaid)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  if (step === 'browser') {
    // @puppeteer/browsers comes with puppeteer-core: that step runs first.
    say('browser', 'Downloading a headless Chrome shell (about 150 MB)…')
    const require = createRequire(join(home, 'package.json'))
    const browsers = await import(require.resolve('@puppeteer/browsers'))
    const platform = browsers.detectBrowserPlatform()
    const browser = browsers.Browser.CHROMEHEADLESSSHELL
    const buildId = await browsers.resolveBuildId(browser, platform, 'stable')
    const { executablePath } = await browsers.install({ browser, buildId, cacheDir: join(home, 'browsers') })
    writeFileSync(join(home, 'browser.json'), JSON.stringify({ executablePath, buildId }, null, 2))
    say('browser', `Installed chrome-headless-shell ${buildId}`)
  }
  say('done', `${step}: done.`)
} catch (err) {
  const detail = String(err?.stderr || err?.message || err).trim().split('\n').slice(-4).join(' ')
  say('error', detail)
  process.exit(1)
}
