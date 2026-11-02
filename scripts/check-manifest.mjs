/**
 * Release preflight for the offline recommendation-selection audit.
 *
 * This script checks package shape, the four-layer local database examples,
 * network boundaries, removed account-mutation features, crawler rate limits,
 * and credential hygiene. It never accesses the network.
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

function has(relative) {
  return existsSync(join(root, relative))
}

function read(relative) {
  return readFileSync(join(root, relative), 'utf8')
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

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function objectEntries(value) {
  return isObject(value) ? Object.entries(value) : []
}

const manifest = parseJson('package.json')
if (!manifest) {
  console.error('release preflight failed: package.json is not valid JSON')
  process.exit(1)
}

// #region manifest shape
if (manifest.name !== 'dsh-bili-audit') fail(`package.json: name must be dsh-bili-audit, got ${manifest.name}`)
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
if (
  typeof manifest.repository?.url !== 'string' ||
  !manifest.repository.url.includes('github.com/Pekemetier/dsh-bili-audit')
) {
  fail('package.json: repository.url must point at github.com/Pekemetier/dsh-bili-audit')
}
if (Object.keys(manifest.dependencies ?? {}).length > 0) {
  fail('package.json: runtime dependencies must stay empty; the plugin uses Node built-ins only')
}
if (!String(manifest.scripts?.['crawl:bili'] ?? '').includes('scripts/crawl-bilibili.mjs')) {
  fail('package.json: scripts["crawl:bili"] must run scripts/crawl-bilibili.mjs')
}
note(`${manifest.name}@${manifest.version}`)
// #endregion

// #region Harness contract
const dsh = manifest.dsh ?? {}
const patchPath = dsh?.bundle?.patch
if (typeof patchPath !== 'string') fail('package.json: missing dsh.bundle.patch')
else if (!has(patchPath)) fail(`package.json: dsh.bundle.patch "${patchPath}" does not exist`)

const client = dsh?.client
if (!isObject(client)) fail('package.json: missing dsh.client')
else {
  if (client.platform !== 'web') fail('package.json: dsh.client.platform must be "web"')
  if (!Array.isArray(client.inject) || client.inject.some((entry) => typeof entry !== 'string')) {
    fail('package.json: dsh.client.inject must be an array of package names')
  }
}

if (typeof patchPath === 'string' && has(patchPath)) {
  const patch = read(patchPath)
  if (!patch.includes('id: bili-audit')) fail(`${patchPath}: must insert row id "bili-audit"`)
  if (!patch.includes('name: dsh-bili-audit')) fail(`${patchPath}: must insert row name "dsh-bili-audit"`)
  if (!/^\s*-\s*insert:/mu.test(patch)) fail(`${patchPath}: must contain an insert list`)
}
// #endregion

// #region exports and packed files
const exportsMap = manifest.exports ?? {}
for (const subpath of ['.', './client', './locale/*.json', './icon', './cordis.patch.yml', './package.json']) {
  if (exportsMap[subpath] === undefined) fail(`package.json: exports["${subpath}"] is required`)
}

const packedFiles = Array.isArray(manifest.files) ? manifest.files : []
for (const entry of packedFiles) {
  if (entry.includes('*')) {
    const base = entry.slice(0, entry.indexOf('*')).replace(/\/$/u, '')
    if (base && !has(base)) fail(`package.json: files glob "${entry}" has no "${base}" directory`)
    continue
  }
  if (!has(entry)) fail(`package.json: files entry "${entry}" does not exist`)
}
for (const required of ['index.js', 'client.js', 'lib', 'scripts', 'examples', 'locale']) {
  if (!packedFiles.some((entry) => entry === required || entry.startsWith(`${required}/`))) {
    fail(`package.json: files must include ${required}`)
  }
}
if (!packedFiles.some((entry) => entry === 'scripts' || entry.startsWith('scripts/'))) {
  fail('package.json: files must include the explicit crawler under scripts/')
}
if (packedFiles.some((entry) => entry.startsWith('vendor'))) {
  fail('package.json: files must not include the removed vendor directory')
}
// #endregion

// #region required files and examples
const requiredFiles = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'README.md',
  'LICENSE',
  'NOTICE.md',
  'lib/reply-library.js',
  'scripts/crawl-bilibili.mjs',
  'examples/video-library.json',
  'examples/reply-library.json',
  'examples/base-trajectories.json',
  'examples/perturbation-trajectories.json',
]
for (const relative of requiredFiles) {
  if (!has(relative)) fail(`missing required file: ${relative}`)
}
if (has('examples/trajectory.json')) {
  fail('examples/trajectory.json is obsolete; use base-trajectories.json and perturbation-trajectories.json')
}

const videoLibrary = has('examples/video-library.json') ? parseJson('examples/video-library.json') : null
if (videoLibrary) {
  if (videoLibrary.schemaVersion !== 2) fail('examples/video-library.json: schemaVersion must be 2')
  const videos = objectEntries(videoLibrary.videos)
  if (videos.length === 0) fail('examples/video-library.json: videos must not be empty')
  let perturbationCount = 0
  for (const [id, item] of videos) {
    if (!isObject(item)) {
      fail(`examples/video-library.json: video ${id} must be an object`)
      continue
    }
    if (!isObject(item.perturbations)) {
      fail(`examples/video-library.json: video ${id} must contain a perturbations object`)
      continue
    }
    perturbationCount += Object.keys(item.perturbations).length
    for (const [name, patch] of Object.entries(item.perturbations)) {
      if (!isObject(patch)) fail(`examples/video-library.json: perturbation ${id}.${name} must be an object`)
      if (isObject(patch) && Object.hasOwn(patch, 'perturbations')) {
        fail(`examples/video-library.json: perturbation ${id}.${name} must not nest perturbations`)
      }
    }
  }
  if (perturbationCount === 0) fail('examples/video-library.json: must demonstrate at least one sparse perturbation')
  note(`video library: ${videos.length} bases, ${perturbationCount} perturbations`)
}

const replyLibrary = has('examples/reply-library.json') ? parseJson('examples/reply-library.json') : null
if (replyLibrary && objectEntries(replyLibrary.replies).length === 0) {
  fail('examples/reply-library.json: replies must not be empty')
}

const baseTrajectories = has('examples/base-trajectories.json')
  ? parseJson('examples/base-trajectories.json')
  : null
if (baseTrajectories) {
  const trajectories = objectEntries(baseTrajectories.trajectories)
  if (trajectories.length === 0) fail('examples/base-trajectories.json: trajectories must not be empty')
  for (const [id, trajectory] of trajectories) {
    if (!isObject(trajectory) || !Array.isArray(trajectory.batches)) {
      fail(`examples/base-trajectories.json: trajectory ${id} must contain a batches array`)
    }
  }
}

const perturbationTrajectories = has('examples/perturbation-trajectories.json')
  ? parseJson('examples/perturbation-trajectories.json')
  : null
if (perturbationTrajectories) {
  const trajectories = objectEntries(perturbationTrajectories.trajectories)
  if (trajectories.length === 0) fail('examples/perturbation-trajectories.json: trajectories must not be empty')
  for (const [id, trajectory] of trajectories) {
    if (!isObject(trajectory)) {
      fail(`examples/perturbation-trajectories.json: trajectory ${id} must be an object`)
      continue
    }
    if (typeof trajectory.extends !== 'string' || trajectory.extends.trim() === '') {
      fail(`examples/perturbation-trajectories.json: trajectory ${id} must inherit with extends`)
    }
    if (!Array.isArray(trajectory.patches) && !Array.isArray(trajectory.addBatches) && !trajectory.removeBatches) {
      fail(`examples/perturbation-trajectories.json: trajectory ${id} must contain sparse changes`)
    }
  }
}
// #endregion

// #region host, client, and tool surface
const hostSource = read('index.js')
const clientSource = read('client.js')
if (!/export\s+function\s+apply\s*\(/u.test(hostSource)) fail('index.js: must export function apply(ctx, config)')
if (!/export\s+const\s+inject\s*=/u.test(hostSource)) fail('index.js: must export const inject')
if (!hostSource.includes("'webServer'") || !hostSource.includes("'tools'")) {
  fail('index.js: inject must include webServer and tools')
}

const idMatch = /__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/u.exec(clientSource)
if (idMatch === null) fail("client.js: must call window.__ModuleLoader__.load({ id: '<package name>', ... })")
else if (idMatch[1] !== manifest.name) fail(`client.js: module id "${idMatch[1]}" != package name "${manifest.name}"`)
if (/\brequire\(['"]@deepseek-ai\//u.test(clientSource)) {
  fail('client.js: must not require a Harness Client package (plain-JS plugins own their primitives)')
}

const expectedTools = [
  'bili_fav_recommend',
  'bili_fav_preview',
  'bili_fav_run',
  'bili_fav_status',
]
for (const name of expectedTools) {
  if (!hostSource.includes(name)) fail(`index.js: missing expected audit tool ${name}`)
}
const registeredToolNames = [...hostSource.matchAll(/name:\s*'(bili_[^']+)'/gu)].map((match) => match[1])
for (const name of registeredToolNames) {
  if (!expectedTools.includes(name)) fail(`index.js: unexpected tool surface ${name}`)
}
if (!hostSource.includes("config.toolMode === 'all'")) {
  fail('index.js: missing all-tools branch')
}
if (!hostSource.includes("toolMode === 'recommend-only'")) {
  fail('index.js: missing recommend-only tool exposure/status branch')
}
const storeSource = read('lib/store.js')
if (!storeSource.includes("toolMode: 'recommend-only'")) {
  fail('lib/store.js: recommend-only must be the default tool mode')
}
for (const layer of [
  "libraryPath: 'video-library.json'",
  "replyLibraryPath: 'reply-library.json'",
  "baseTrajectoryPath: 'base-trajectories.json'",
  "perturbationTrajectoryPath: 'perturbation-trajectories.json'",
]) {
  if (!storeSource.includes(layer)) fail(`lib/store.js: missing layered database default ${layer}`)
}
// #endregion

// #region offline runtime and removed features
const runtimeFiles = [
  'index.js',
  'client.js',
  ...filesUnder('lib').filter((file) => /\.(?:js|mjs)$/u.test(file)),
]
const forbiddenRuntime = [
  [/\bapi\.bilibili\.com\b/iu, 'Bilibili API host'],
  [/\bapi\.bot\.qq\.com\b/iu, 'QQ Bot API host'],
  [/\bbots\.qq\.com\b/iu, 'QQ Bot API host'],
  [/\bBiliApi\b/u, 'Bilibili API client'],
  [/\bcreateQQChannel\b/u, 'QQ channel implementation'],
  [/\bcreateWebhookChannel\b/u, 'webhook delivery implementation'],
  [/\bqrSvg\b/u, 'QR login implementation'],
  [/\b(?:qrLogin|startQrLogin|scanQrLogin)\b/u, 'QR login implementation'],
  [/\b(?:addFavorite|favoriteVideo|unfavoriteVideo|deleteFavorite)\b/u, 'favorite mutation'],
  [/\b(?:commentVideo|postComment|sendComment|deleteComment)\b/u, 'comment mutation'],
  [/\b(?:addCoin|coinVideo|sendDanmaku)\b/u, 'Bilibili account mutation'],
  [/\b(?:sendMessage|deliverMessage)\b/u, 'message delivery implementation'],
  [/\bbili_fav_(?:push|last|folders|channels)\b/u, 'removed delivery/favorite tool'],
  [/\/(?:x\/v2\/reply\/add|x\/web-interface\/archive\/like|x\/web-interface\/archive\/coin-add)/iu, 'Bilibili mutation endpoint'],
  [/from\s+['"][^'"]*\/(?:bili|channels|chat|judge|qq-channel|qr|session-channel|session-prompt|wake|webhook)\.js['"]/u, 'removed legacy module import'],
]
for (const relative of runtimeFiles) {
  const text = read(relative)
  for (const [pattern, label] of forbiddenRuntime) {
    if (pattern.test(text)) fail(`${relative}: contains ${label}`)
  }
}

const hostAndLib = ['index.js', 'client.js', ...filesUnder('lib').filter((file) => file.endsWith('.js'))]
for (const relative of hostAndLib) {
  const text = read(relative)
  const remoteUrls = [...text.matchAll(/https?:\/\/[^\s'"`)]+/gu)]
    .map((match) => match[0])
    .filter((url) => !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/iu.test(url))
  if (remoteUrls.length > 0) fail(`${relative}: runtime host must not contain an absolute remote URL`)
}

const crawler = read('scripts/crawl-bilibili.mjs')
if (!crawler.includes("const API_BASE = 'https://api.bilibili.com'")) {
  fail('scripts/crawl-bilibili.mjs: Bilibili API base is missing')
}
for (const [pattern, label] of forbiddenRuntime.filter(([pattern]) => !pattern.source.includes('api\\.bilibili'))) {
  if (pattern.test(crawler)) fail(`scripts/crawl-bilibili.mjs: contains ${label}`)
}
if (/Authorization|Bearer\s+[A-Za-z0-9._-]+/iu.test(crawler)) {
  fail('scripts/crawl-bilibili.mjs: must not send or define authorization tokens')
}
// #endregion

// #region crawler safety
if (!crawler.includes('const DEFAULT_INTERVAL_MS = 2000')) {
  fail('scripts/crawl-bilibili.mjs: default interval must be 2000ms')
}
if (!crawler.includes('const DEFAULT_JITTER_MS = 500')) {
  fail('scripts/crawl-bilibili.mjs: default jitter must be 500ms')
}
if (!/interval\s*<\s*1000/u.test(crawler)) {
  fail('scripts/crawl-bilibili.mjs: request interval hard floor must be 1000ms')
}
if (!crawler.includes('await pacer.wait(signal)')) {
  fail('scripts/crawl-bilibili.mjs: every request must wait for the shared pacer')
}
if (!crawler.includes("redirect: 'error'")) {
  fail('scripts/crawl-bilibili.mjs: redirects must be rejected')
}
if (!crawler.includes('includeCookie: false')) {
  fail('scripts/crawl-bilibili.mjs: subtitle CDN requests must explicitly omit cookies')
}
if (!/status\s*===\s*412/u.test(crawler) || !/status\s*===\s*429/u.test(crawler)) {
  fail('scripts/crawl-bilibili.mjs: 412 and 429 must be handled as fatal rate-limit responses')
}
if (!/perturbations:\s*\{\s*\}/u.test(crawler)) {
  fail('scripts/crawl-bilibili.mjs: new video records must start with an empty perturbations object')
}
if (!crawler.includes('BILI_COOKIE')) {
  fail('scripts/crawl-bilibili.mjs: optional cookie must come from BILI_COOKIE or --cookie-file')
}
if (crawler.includes('writeJson(output, result.document)') === false) {
  fail('scripts/crawl-bilibili.mjs: expected output write is missing')
}
// #endregion

// #region documentation boundary
const readme = read('README.md')
for (const required of [
  'dsh-bili-audit',
  'DEEPSEEK_API_KEY',
  'video-library.json',
  'reply-library.json',
  'base-trajectories.json',
  'perturbation-trajectories.json',
  'crawl-bilibili.mjs',
  'BILI_COOKIE',
  '1000',
]) {
  if (!readme.includes(required)) fail(`README.md: must document ${required}`)
}
if (readme.includes('dsh plugin --profile web add dsh-bili-qq')) {
  fail('README.md: still documents the old package name')
}
if (!readme.includes('运行时完全离线') && !readme.includes('运行时零网络')) {
  fail('README.md: must state that the runtime is offline')
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
  [/\bsk-[A-Za-z0-9_-]{20,}\b/u, 'OpenAI-style API key'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/u, 'Google API key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u, 'private key'],
  [/\b(?:DEEPSEEK|OPENAI|ANTHROPIC)_API_KEY\s*=\s*['"][^'"]{8,}['"]/u, 'hard-coded LLM API key'],
  [/Authorization\s*:\s*['"]Bearer\s+[A-Za-z0-9._-]{12,}/iu, 'hard-coded bearer token'],
  [/SESSDATA=[A-Za-z0-9%._-]{20,}/iu, 'hard-coded Bilibili cookie'],
]
const textFiles = [
  'index.js',
  'client.js',
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'NOTICE.md',
  'locale/en.json',
  'locale/zh.json',
  ...filesUnder('lib'),
  ...filesUnder('scripts').filter((file) => !file.endsWith('check-manifest.mjs')),
  ...filesUnder('examples'),
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
for (const file of ['.npmrc', '.env', 'cookie.txt', 'cookies.json']) {
  if (has(file)) fail(`${file} must never be committed; keep credentials outside the repository`)
}
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