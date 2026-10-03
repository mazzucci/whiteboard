#!/usr/bin/env node
// Installs what renderd.mjs needs into <home>, printing one JSON line per step:
//   - puppeteer-core (drives a browser; never downloads one itself)
//   - mermaid.min.js, the one file of Mermaid's npm package the page loads
//   - a headless Chrome shell, only when no Chromium-based browser is
//     installed (or with --download-browser)
//
//   node setup.mjs --home <dir> --mermaid 12.1.0 --puppeteer 25.12.0 [--download-browser]

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
const forceDownload = process.argv.includes('--download-browser')
if (!home || !mermaid || !puppeteer) {
  console.error('usage: setup.mjs --home <dir> --mermaid <version> --puppeteer <version>')
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

try {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  chmodSync(home, 0o700)
  if (!existsSync(join(home, 'package.json'))) {
    writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'diagram-renderer', private: true }, null, 2))
  }

  say('puppeteer', `Installing puppeteer-core ${puppeteer}…`)
  run(['install', '--no-audit', '--no-fund', '--save-exact', `puppeteer-core@${puppeteer}`], home)

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

  const installed = INSTALLED.find(p => existsSync(p))
  if (installed && !forceDownload) {
    rmSync(join(home, 'browser.json'), { force: true })
    say('browser', `Using the installed browser: ${installed}`)
  } else {
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
  say('done', 'The diagram renderer is ready.')
} catch (err) {
  const detail = String(err?.stderr || err?.message || err).trim().split('\n').slice(-4).join(' ')
  say('error', detail)
  process.exit(1)
}
