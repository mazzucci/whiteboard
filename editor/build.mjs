// Builds the board's canvas editor (src/editor.jsx: Excalidraw and the
// Mermaid converter) into plugin/board/vendor/: editor.js.gz, editor.css.gz
// and the fonts it draws with. Mermaid is not bundled a second time: the
// converter uses the page's own (window.mermaid).
//
//   cd editor && npm install && npm run build
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const vendor = new URL('../plugin/board/vendor/', import.meta.url)
const out = new URL('editor/', vendor)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const { metafile } = await build({
  metafile: true,
  entryPoints: ['src/editor.jsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outdir: 'dist',
  jsx: 'automatic',
  conditions: ['production'],
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' },
  loader: { '.woff2': 'empty', '.png': 'empty', '.svg': 'empty' },
  plugins: [
    {
      // The page's Mermaid, already loaded, instead of a second copy.
      name: 'page-mermaid',
      setup(b) {
        b.onResolve({ filter: /^mermaid$/ }, () => ({ path: 'mermaid', namespace: 'page-mermaid' }))
        b.onLoad({ filter: /.*/, namespace: 'page-mermaid' }, () => ({ contents: 'export default window.mermaid', loader: 'js' }))
      },
    },
  ],
  logLevel: 'warning',
})

for (const [file, name] of [['dist/editor.js', 'editor.js.gz'], ['dist/editor.css', 'editor.css.gz']]) {
  writeFileSync(new URL(name, out), gzipSync(readFileSync(file), { level: 9 }))
}
// Excalidraw's fonts with a clear licence (vendor/README.md): not Xiaolai
// (Chinese, 12 MB) or Excalifont (no licence published). It loads them itself.
for (const family of ['Assistant', 'Cascadia', 'ComicShanns', 'Liberation', 'Lilita', 'Nunito', 'Virgil']) {
  cpSync(`node_modules/@excalidraw/excalidraw/dist/prod/fonts/${family}`, new URL(`fonts/${family}`, out).pathname, { recursive: true })
}
// Packages published without their licence file: MIT, held by these (from each project's repository).
const MIT_HOLDERS = {
  '@excalidraw/excalidraw': '2020 Excalidraw',
  '@radix-ui/': '2022 WorkOS',
  fuzzy: '2012 Matt York',
  'react-remove-scroll-bar': '2025 Anton Korzunov <thekashey@gmail.com>',
}
const MIT = holder => `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.`

// Every package in the bundle, with its licence text, beside it.
const packages = new Map()
for (const input of Object.keys(metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)
  if (!m) continue
  const dir = input.slice(0, input.lastIndexOf(`node_modules/${m[1]}/`)) + `node_modules/${m[1]}`
  if (packages.has(dir)) continue
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  const file = readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.|$)/i.test(f))
  const holder = Object.entries(MIT_HOLDERS).find(([k]) => pkg.name === k || (k.endsWith('/') && pkg.name.startsWith(k)))?.[1]
  const license = pkg.license?.type ?? pkg.license ?? pkg.licenses?.map(l => l.type).join(' OR ') ?? '(see text)'
  const text = file ? readFileSync(`${dir}/${file}`, 'utf8').trim() : holder ? MIT(holder) : ''
  packages.set(dir, { name: pkg.name, version: pkg.version, license, text })
}
const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
writeFileSync(
  new URL('THIRD_PARTY_LICENSES.md', out),
  `# Third-party licences: the canvas editor\n\n\`editor.js.gz\` and \`editor.css.gz\` bundle these packages, unmodified, built by \`editor/build.mjs\`.\n\n` +
    list.map(p => `## ${p.name} ${p.version}\n\nLicence: ${p.license}\n\n${p.text ? '```\n' + p.text + '\n```' : '(no licence file in the package)'}\n`).join('\n'),
)
console.log('built', out.pathname, `${list.length} packages:`, [...new Set(list.map(p => p.license))].join(', '))
for (const p of list.filter(p => !p.text)) console.log('  no licence text:', p.name, p.license)
