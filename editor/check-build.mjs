// Fails when plugin/board/vendor/editor/ is not what editor/build.mjs makes
// from the source and lockfile here: someone changed src/ without building,
// or committed a bundle built from something else. Compares content, not
// bytes, for the gzipped files (gzip headers differ between machines).
//
//   cd editor && npm ci && node check-build.mjs
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const vendor = new URL('../plugin/board/vendor/editor/', import.meta.url).pathname
const committed = mkdtempSync(join(tmpdir(), 'editor-committed-'))
cpSync(vendor, committed, { recursive: true })
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' })

const files = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).sort()
const content = (dir, f) => (f.endsWith('.gz') ? gunzipSync(readFileSync(join(dir, f))) : readFileSync(join(dir, f)))
const was = files(committed)
const now = files(vendor)
const differ = [...new Set([...was, ...now])].filter(f => !was.includes(f) || !now.includes(f) || !content(committed, f).equals(content(vendor, f)))
if (differ.length) {
  console.error(`The committed editor bundle is not what the source builds: ${differ.join(', ')}. Run: cd editor && npm ci && npm run build`)
  process.exit(1)
}
console.log(`The editor bundle matches its source (${now.length} files).`)
