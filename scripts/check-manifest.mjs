/**
 * Release preflight for the offline recommendation-selection audit.
 *
 * This script intentionally checks both package shape and product boundaries:
 * the shipped host must not contain Bilibili/QQ network clients or unrelated
 * comment/favorite/delivery features.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function fail(message) {
  failures.push(message)
}

function note(message) {
  notes.push(message)
}

function read(relative) {
  return readFileSync(join(root, relative), 'utf8')
}

function has(relative) {
  return existsSync(join(root, relative))
}

function isDirectory(relative) {
  try {
    return statSync(join(root, relative)).isDirectory()
  } catch {
    return false
  }
}

function filesUnder(relative) {
  const directory = join(root, relative)
  if (!isDirectory(relative)) return []
  const output = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory()) output.push(...filesUnder(child))
    else output.push(child)
  }
  return output
}

function parseJson(relative) {
  try {
    return JSON.parse(read(relative))
  } catch (error) {
    fail(`${relative}: invalid JSON (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
}

const manifest = parseJson('package.json')
if (!manifest) {
  console.error('release preflight failed: package.json is not valid JSON')
  process.exit(1)
}

// #region manifest shape
if (manifest.name !== 'dsh-bili-qq') fail(`package.json: name must be dsh-bili-qq, got ${manifest.name}`)
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(String(manifest.version))) {
  fail(`package.json: invalid version ${manifest.version}`)
}
if (manifest.private === true) fail('package.json: private must not be true when preparing a release')
if (manifest.type !== 'module') fail('package.json: type must be "module"')
if (manifest.main !== 'index.js') fail('package.json: main must be index.js')
if (manifest.license !== 'MIT') fail('package.json: license must be MIT')
if (typeof manifest.description !== 'string' || !manifest.description.includes('离线')) {
  fail('package.json: description must identify the offline audit purpose')
}
if (manifest.engines?.node !== '>=22') fail('package.json: engines.node must be ">=22"')
if (typeof manifest.repository?.url !== 'string' || !manifest.repository.url.includes('github.com/mswinandmc/dsh-bili-qq')) {
  fail('package.json: repository.url must point at github.com/mswinandmc/dsh-bili-qq')
}
note(`${manifest.name}@${manifest.version}`)
// #endregion

// #region Harness contract
const dsh = manifest.dsh ?? {}
const patchPath = dsh?.bundle?.patch
if (typeof patchPath !== 'string') fail('package.json: missing dsh.bundle.patch')
else if (!has(patchPath)) fail(`package.json: dsh.bundle.patch "${patchPath}" does not exist`)

const client = dsh?.client
if (client === undefined || typeof client !== 'object') fail('package.json: missing dsh.client')
else {
  if (client.platform !== 'web') fail('package.json: dsh.client.platform must be "web"')
  if (!Array.isArray(client.inject) || client.inject.some((entry) => typeof entry !== 'string')) {
    fail('package.json: dsh.client.inject must be an array of package names')
  }
}
// #endregion

// #region exports and files
const exportsMap = manifest.exports ?? {}
for (const subpath of ['.', './client', './locale/*.json', './icon', './cordis.patch.yml', './package.json']) {
  if (exportsMap[subpath] === undefined) fail(`package.json: exports["${subpath}"] is required`)
}
for (const entry of manifest.files ?? []) {
  if (entry.includes('*')) {
    const base = entry.slice(0, entry.indexOf('*')).replace(/\/$/u, '')
    if (base === '') continue
    if (!has(base)) fail(`package.json: files glob "${entry}" has no "${base}" directory`)
    else if (!isDirectory(base)) fail(`package.json: files glob "${entry}" expects "${base}" to be a directory`)
    continue
  }
  if (!has(entry)) fail(`package.json: files entry "${entry}" does not exist`)
}
for (const required of ['lib', 'examples', 'locale']) {
  if (!(manifest.files ?? []).some((entry) => entry === required || entry.startsWith(`${required}/`))) {
    fail(`package.json: files must include ${required}`)
  }
}
if ((manifest.files ?? []).some((entry) => entry.startsWith('vendor'))) {
  fail('package.json: files must not include the removed vendor directory')
}
// #endregion

// #region required and forbidden files
for (const required of [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'README.md',
  'LICENSE',
  'NOTICE.md',
  'lib/audit-engine.js',
  'lib/store.js',
  'lib/trajectory.js',
  'lib/util.js',
  'lib/video-library.js',
  'examples/video-library.json',
  'examples/trajectory.json',
]) {
  if (!has(required)) fail(`missing required file: ${required}`)
}
for (const removed of [
  'lib/bili.js',
  'lib/channels.js',
  'lib/chat.js',
  'lib/judge.js',
  'lib/qq-channel.js',
  'lib/qr.js',
  'lib/session-channel.js',
  'lib/session-prompt.js',
  'lib/wake.js',
  'lib/webhook.js',
  'vendor/qrcode.cjs',
]) {
  if (has(removed)) fail(`removed module still exists: ${removed}`)
}
// #endregion

// #region examples
const exampleLibrary = parseJson('examples/video-library.json')
if (exampleLibrary) {
  if (!exampleLibrary.videos || typeof exampleLibrary.videos !== 'object' || Array.isArray(exampleLibrary.videos)) {
    fail('examples/video-library.json: videos must be an id-keyed object')
  } else {
    const ids = Object.keys(exampleLibrary.videos)
    if (ids.length === 0) fail('examples/video-library.json: videos is empty')
    for (const id of ids) {
      if (!id.includes('.')) fail(`examples/video-library.json: id "${id}" should use the video.perturbation format`)
      const item = exampleLibrary.videos[id]
      if (!item?.recommendation || !item?.watch) {
        fail(`examples/video-library.json: "${id}" must contain recommendation and watch`)
      }
    }
  }
}
const exampleTrajectory = parseJson('examples/trajectory.json')
if (exampleTrajectory) {
  const database = exampleTrajectory.trajectories
  if (!database || typeof database !== 'object') {
    fail('examples/trajectory.json: expected a trajectories database')
  } else {
    const selectedId = exampleTrajectory.activeTrajectory
    if (!selectedId || !database[selectedId]) {
      fail('examples/trajectory.json: activeTrajectory must reference an existing trajectory')
    } else if (!Array.isArray(database[selectedId].batches) || database[selectedId].batches.length === 0) {
      fail('examples/trajectory.json: active trajectory must contain batches')
    }
  }
}
// #endregion

// #region bundle patch
if (typeof patchPath === 'string' && has(patchPath)) {
  const patch = read(patchPath)
  if (!patch.includes('name: dsh-bili-qq') && !patch.includes("name: 'dsh-bili-qq'")) {
    fail(`${patchPath}: must insert a row named "dsh-bili-qq"`)
  }
  if (!/^\s*-\s*insert:/mu.test(patch)) fail(`${patchPath}: must contain an insert list`)
}
// #endregion

// #region host and client entry
const hostSource = read('index.js')
if (!/export\s+function\s+apply\s*\(/u.test(hostSource)) fail('index.js: must export function apply(ctx, config)')
if (!/export\s+const\s+inject\s*=/u.test(hostSource)) fail('index.js: must export const inject')
if (!hostSource.includes("'webServer'") || !hostSource.includes("'tools'")) {
  fail('index.js: inject must include webServer and tools')
}

const clientSource = read('client.js')
const idMatch = /__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/u.exec(clientSource)
if (idMatch === null) fail("client.js: must call window.__ModuleLoader__.load({ id: '<package name>', ... })")
else if (idMatch[1] !== manifest.name) fail(`client.js: module id "${idMatch[1]}" != package name "${manifest.name}"`)
if (/\brequire\(['"]@deepseek-ai\//u.test(clientSource)) {
  fail('client.js: must not require a Harness Client package (plain-JS plugins own their primitives)')
}
if (/https?:\/\//u.test(clientSource)) fail('client.js: must not contain a remote URL')
// #endregion

// #region offline boundary
const runtimeFiles = ['index.js', ...filesUnder('lib').filter((file) => file.endsWith('.js'))]
const forbiddenRuntime = [
  [/\bapi\.bilibili\.com\b/iu, 'Bilibili API host'],
  [/\b(?:api\.bot\.qq\.com|bots\.qq\.com)\b/iu, 'QQ Bot API host'],
  [/\bBiliApi\b/u, 'Bilibili API client'],
  [/\bcreateQQChannel\b/u, 'QQ channel implementation'],
  [/\bcreateWebhookChannel\b/u, 'webhook delivery implementation'],
  [/\bqrSvg\b/u, 'QR login implementation'],
  [/\bpickUrls\b/u, 'favorite/comment implementation'],
  [/from\s+['"][^'"]*\/(?:bili|channels|chat|judge|qq-channel|qr|session-channel|session-prompt|wake|webhook)\.js['"]/u, 'removed legacy module import'],
  [/\bbili_fav_(?:push|last|folders|channels)\b/u, 'removed delivery/favorite tool'],
  [/\b(?:addFavorite|favoriteVideo|sendMessage|commentVideo)\b/u, 'removed account mutation'],
]
for (const relative of runtimeFiles) {
  const text = read(relative)
  for (const [pattern, label] of forbiddenRuntime) {
    if (pattern.test(text)) fail(`${relative}: contains ${label}`)
  }
}
for (const name of ['bili_fav_recommend', 'bili_fav_preview', 'bili_fav_run', 'bili_fav_status']) {
  if (!hostSource.includes(name)) fail(`index.js: missing expected audit tool ${name}`)
}
if (!hostSource.includes("toolMode === 'recommend-only'")) {
  fail('index.js: missing recommend-only tool exposure branch')
}
// #endregion

// #region locale metadata
for (const locale of ['en', 'zh']) {
  const file = `locale/${locale}.json`
  if (!has(file)) continue
  const dict = parseJson(file)
  if (!dict) continue
  if (typeof dict?.meta?.title !== 'string' || dict.meta.title.trim() === '') fail(`${file}: meta.title is required`)
  if (typeof dict?.meta?.description !== 'string' || dict.meta.description.trim() === '') {
    fail(`${file}: meta.description is required`)
  }
}
// #endregion

// #region icon
if (has('icon.svg')) {
  const icon = read('icon.svg')
  if (!/^\s*<svg[\s>]/u.test(icon)) fail('icon.svg: does not start with an <svg> root')
  if (statSync(join(root, 'icon.svg')).size > 256 * 1024) fail('icon.svg: exceeds the 256 KiB icon limit')
}
// #endregion

// #region credential hygiene
const LEAK_PATTERNS = [
  [/\b_authToken\b/u, 'npm auth token field'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/u, 'npm access token'],
  [/\bghp_[A-Za-z0-9]{30,}\b/u, 'GitHub personal access token'],
  [/\bgho_[A-Za-z0-9]{30,}\b/u, 'GitHub OAuth token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/u, 'GitHub fine-grained token'],
]
const textFiles = [
  'index.js',
  'client.js',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'NOTICE.md',
  ...runtimeFiles,
  'examples/video-library.json',
  'examples/trajectory.json',
]
for (const relative of [...new Set(textFiles)]) {
  if (!has(relative)) continue
  let text
  try {
    text = read(relative)
  } catch {
    continue
  }
  for (const [pattern, label] of LEAK_PATTERNS) {
    if (pattern.test(text)) fail(`${relative}: contains what looks like a ${label}`)
  }
}
if (has('.npmrc')) fail('.npmrc must never be committed; the release uses npm trusted publishing (OIDC)')
// #endregion

// #region report
for (const line of notes) console.log(`ok: ${line}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} release preflight check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`release preflight passed: ${manifest.name}@${manifest.version} is shippable`)
// #endregion
