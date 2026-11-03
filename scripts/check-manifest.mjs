/**
 * Release preflight for the offline recommendation-selection audit.
 *
 * The check is intentionally static and offline. It verifies the split-file
 * video/trajectory layout, sparse inheritance, runtime network boundary,
 * explicit crawler safety controls, and credential hygiene.
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

function jsonStem(relative) {
  return relative.split('/').pop().replace(/\.json$/iu, '')
}

function isFileId(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\\/:*?"<>|\u0000-\u001f]/u.test(value)
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
const hostVersion = /let\s+VERSION\s*=\s*'([^']+)'/u.exec(read('index.js'))?.[1]
if (hostVersion !== manifest.version) {
  fail(`index.js: fallback version ${hostVersion ?? '(missing)'} must match package.json ${manifest.version}`)
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

// #region split-file examples
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
  'lib/audit-engine.js',
  'lib/store.js',
  'lib/trajectory.js',
  'lib/util.js',
  'lib/video-library.js',
  'scripts/crawl-bilibili.mjs',
]
for (const relative of requiredFiles) {
  if (!has(relative)) fail(`missing required file: ${relative}`)
}

const removedFiles = [
  'lib/reply-library.js',
  'examples/video-library.json',
  'examples/reply-library.json',
  'examples/base-trajectories.json',
  'examples/perturbation-trajectories.json',
  'examples/trajectory.json',
]
for (const relative of removedFiles) {
  if (has(relative)) fail(`${relative} is obsolete; use split video and trajectory files`)
}

if (!isDirectory('examples/videos')) fail('examples/videos directory is required')
else {
  const files = filesUnder('examples/videos').filter((file) => file.endsWith('.json'))
  if (files.length === 0) fail('examples/videos: must contain at least one video file')
  let perturbationCount = 0
  const videoIds = new Set()
  for (const relative of files) {
    const item = parseJson(relative)
    if (!item) continue
    const id = jsonStem(relative)
    if (item.schemaVersion !== 3) fail(`${relative}: schemaVersion must be 3`)
    if (item.id !== id) fail(`${relative}: id must match filename ${id}`)
    if (Object.hasOwn(item, 'videos') || Object.hasOwn(item, 'items')) {
      fail(`${relative}: must contain exactly one base video, not a video collection`)
    }
    if (!isObject(item.recommendation) || !isObject(item.watch)) {
      fail(`${relative}: recommendation and watch must be objects`)
    }
    if (!isObject(item.perturbations)) {
      fail(`${relative}: perturbations must be an object`)
      continue
    }
    videoIds.add(id)
    for (const [name, patch] of Object.entries(item.perturbations)) {
      if (!isFileId(name)) fail(`${relative}: invalid perturbation id ${name}`)
      if (!isObject(patch)) fail(`${relative}: perturbation ${id}.${name} must be an object`)
      if (isObject(patch) && Object.hasOwn(patch, 'perturbations')) {
        fail(`${relative}: perturbation ${id}.${name} must not nest perturbations`)
      }
      videoIds.add(`${id}.${name}`)
      perturbationCount += 1
    }
  }
  if (perturbationCount === 0) fail('examples/videos: must demonstrate at least one sparse perturbation')
  note(`videos: ${files.length} base file(s), ${perturbationCount} perturbation variant(s)`)

  const trajectoryRoot = 'examples/trajectories'
  if (!isDirectory(trajectoryRoot)) fail(`${trajectoryRoot} directory is required`)
  else {
    const baseDirectories = readdirSync(join(root, trajectoryRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
    if (baseDirectories.length === 0) fail(`${trajectoryRoot}: must contain a base trajectory folder`)

    let baseCount = 0
    let perturbationTrajectoryCount = 0
    let inlineReplyCount = 0
    for (const baseId of baseDirectories) {
      const baseRelative = `${trajectoryRoot}/${baseId}/base.json`
      if (!has(baseRelative)) {
        fail(`${trajectoryRoot}/${baseId}: missing base.json`)
        continue
      }
      const base = parseJson(baseRelative)
      if (!base) continue
      baseCount += 1
      if (base.schemaVersion !== 3) fail(`${baseRelative}: schemaVersion must be 3`)
      if (base.id !== baseId) fail(`${baseRelative}: id must match folder ${baseId}`)
      if (Object.hasOwn(base, 'trajectories')) fail(`${baseRelative}: must be a single trajectory, not a collection`)
      if (!Array.isArray(base.batches) || base.batches.length === 0) {
        fail(`${baseRelative}: batches must be a non-empty array`)
        continue
      }
      const batchIds = new Set()
      for (const [index, batch] of base.batches.entries()) {
        if (!isObject(batch) || !isFileId(batch.id)) {
          fail(`${baseRelative}: batch ${index + 1} must have a valid id`)
          continue
        }
        if (batchIds.has(batch.id)) fail(`${baseRelative}: duplicate batch id ${batch.id}`)
        batchIds.add(batch.id)
        if (!Array.isArray(batch.videos) || batch.videos.length === 0) {
          fail(`${baseRelative}: batch ${batch.id} must contain videos`)
          continue
        }
        for (const entry of batch.videos) {
          if (typeof entry === 'string') {
            if (!videoIds.has(entry)) fail(`${baseRelative}: batch ${batch.id} references unknown video ${entry}`)
          } else if (!isObject(entry) || (!entry.id && !entry.videoId)) {
            fail(`${baseRelative}: batch ${batch.id} has an invalid inline video entry`)
          }
        }
        if (batch.replies !== undefined) {
          if (!Array.isArray(batch.replies)) fail(`${baseRelative}: batch ${batch.id} replies must be inline in an array`)
          else {
            for (const reply of batch.replies) {
              if (typeof reply === 'string') {
                if (!reply.trim()) fail(`${baseRelative}: batch ${batch.id} has an empty inline reply`)
                else inlineReplyCount += 1
              } else if (!isObject(reply) || typeof reply.text !== 'string') {
                fail(`${baseRelative}: batch ${batch.id} replies must be inline text objects`)
              } else {
                if (Object.hasOwn(reply, 'replyId')) fail(`${baseRelative}: replies must not reference a removed reply library`)
                inlineReplyCount += 1
              }
            }
          }
        }
      }

      const perturbationFiles = filesUnder(`${trajectoryRoot}/${baseId}`)
        .filter((file) => file.endsWith('.json') && file !== baseRelative)
      for (const relative of perturbationFiles) {
        const perturbation = parseJson(relative)
        if (!perturbation) continue
        perturbationTrajectoryCount += 1
        const id = jsonStem(relative)
        if (perturbation.schemaVersion !== 3) fail(`${relative}: schemaVersion must be 3`)
        if (perturbation.id !== id) fail(`${relative}: id must match filename ${id}`)
        if (perturbation.extends !== baseId) fail(`${relative}: extends must equal ${baseId}`)
        if (Object.hasOwn(perturbation, 'trajectories')) fail(`${relative}: must be a single trajectory`)
        if (Object.hasOwn(perturbation, 'batches')) fail(`${relative}: must store only sparse changes, not inherited batches`)
        const hasPatches = Array.isArray(perturbation.patches) && perturbation.patches.length > 0
        const hasRemovals = Array.isArray(perturbation.removeBatches) && perturbation.removeBatches.length > 0
        const hasAdditions = Array.isArray(perturbation.addBatches) && perturbation.addBatches.length > 0
        if (!hasPatches && !hasRemovals && !hasAdditions) {
          fail(`${relative}: must contain patches, removeBatches, or addBatches`)
        }
        if (hasPatches) {
          for (const [index, patch] of perturbation.patches.entries()) {
            if (!isObject(patch) || !isFileId(patch.batchId)) {
              fail(`${relative}: patch ${index + 1} must target a valid batchId`)
            }
          }
        }
      }
    }
    if (baseCount === 0) fail(`${trajectoryRoot}: no valid base.json files`)
    if (inlineReplyCount === 0) note('trajectories: no inline replies in examples')
    note(`trajectories: ${baseCount} base file(s), ${perturbationTrajectoryCount} perturbation file(s), ${inlineReplyCount} inline reply/replies`)
  }
}
// #endregion

// #region host, client, and tool surface
const hostSource = read('index.js')
const clientSource = read('client.js')
if (!/export\s+function\s+apply\s*\(/u.test(hostSource)) fail('index.js: must export function apply(ctx)')
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

const expectedTools = ['bili_fav_recommend', 'bili_fav_preview', 'bili_fav_run', 'bili_fav_status']
for (const name of expectedTools) {
  if (!hostSource.includes(name)) fail(`index.js: missing expected audit tool ${name}`)
}
const registeredToolNames = [...hostSource.matchAll(/name:\s*'(bili_[^']+)'/gu)].map((match) => match[1])
for (const name of registeredToolNames) {
  if (!expectedTools.includes(name)) fail(`index.js: unexpected tool surface ${name}`)
}
if (!hostSource.includes("config.toolMode === 'all'")) fail('index.js: missing all-tools branch')
if (!hostSource.includes("toolMode === 'recommend-only'")) {
  fail('index.js: missing recommend-only tool exposure/status branch')
}

for (const endpoint of ['/video', '/base-trajectory', '/perturbation-trajectory']) {
  if (!hostSource.includes(`\${API_PREFIX}${endpoint}`)) fail(`index.js: missing per-file endpoint ${endpoint}`)
}
for (const oldEndpoint of ['/video-library', '/reply-library', '/base-trajectories', '/perturbation-trajectories']) {
  if (hostSource.includes(`\${API_PREFIX}${oldEndpoint}`)) fail(`index.js: obsolete aggregate endpoint remains: ${oldEndpoint}`)
}

const storeSource = read('lib/store.js')
if (!storeSource.includes("toolMode: 'recommend-only'")) {
  fail('lib/store.js: recommend-only must be the default tool mode')
}
for (const required of ["videoDirectory: 'videos'", "trajectoryDirectory: 'trajectories'"]) {
  if (!storeSource.includes(required)) fail(`lib/store.js: missing directory default ${required}`)
}
for (const old of ['libraryPath', 'replyLibraryPath', 'baseTrajectoryPath', 'perturbationTrajectoryPath']) {
  if (storeSource.includes(old)) fail(`lib/store.js: obsolete aggregate setting remains: ${old}`)
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
  [/from\s+['"][^'"]*crawl-bilibili\.mjs['"]/u, 'runtime must not import the network crawler'],
]
for (const relative of runtimeFiles) {
  const text = read(relative)
  for (const [pattern, label] of forbiddenRuntime) {
    if (pattern.test(text)) fail(`${relative}: contains ${label}`)
  }
}

for (const relative of runtimeFiles) {
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

// #region crawler safety and split-file output
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
if (!crawler.includes('export function readExistingVideos')) {
  fail('scripts/crawl-bilibili.mjs: missing directory resume reader')
}
if (!crawler.includes('export function writeCrawledVideos')) {
  fail('scripts/crawl-bilibili.mjs: missing per-video output writer')
}
if (!crawler.includes('videoFilePath(directory, record?.id)')) {
  fail('scripts/crawl-bilibili.mjs: output must derive one file from each record id')
}
if (!crawler.includes('writeCrawledVideos(output, result.records')) {
  fail('scripts/crawl-bilibili.mjs: main must write result.records into the video directory')
}
if (crawler.includes('result.document') || crawler.includes('writeJson(output, result.document)')) {
  fail('scripts/crawl-bilibili.mjs: obsolete aggregate document output remains')
}
if (!/existsSync\(output\)[^\n]*!values\.resume[^\n]*!values\.force/u.test(crawler)) {
  fail('scripts/crawl-bilibili.mjs: existing output directories must require --resume or --force')
}
// #endregion

// #region documentation boundary
const readme = read('README.md')
for (const required of [
  'dsh-bili-audit',
  'DEEPSEEK_API_KEY',
  'videos/<base-id>.json',
  'trajectories/<base-id>/base.json',
  'trajectories/<base-id>/<perturbation-id>.json',
  'perturbations',
  'patches',
  'bili_fav_recommend',
  'bili_fav_preview',
  'crawl-bilibili.mjs',
  'BILI_COOKIE',
  '1000',
]) {
  if (!readme.includes(required)) fail(`README.md: must document ${required}`)
}
for (const old of [
  'video-library.json',
  'reply-library.json',
  'base-trajectories.json',
  'perturbation-trajectories.json',
  '四层数据库',
  '回复数据库',
  '回复库',
]) {
  if (readme.includes(old)) fail(`README.md: obsolete aggregate database description remains: ${old}`)
}
if (readme.includes('dsh plugin --profile web add dsh-bili-qq')) {
  fail('README.md: still documents the old package name')
}
if (!readme.includes('运行时完全离线') && !readme.includes('运行时零网络')) {
  fail('README.md: must state that the runtime is offline')
}
if (!readme.includes('DSH') || !readme.includes('provider')) {
  fail('README.md: must explain that DSH provider configuration owns the LLM credential')
}

for (const locale of ['en', 'zh']) {
  const file = `locale/${locale}.json`
  if (!has(file)) continue
  const dict = parseJson(file)
  if (!dict) continue
  if (typeof dict?.meta?.title !== 'string' || dict.meta.title.trim() === '') fail(`${file}: meta.title is required`)
  const description = typeof dict?.meta?.description === 'string' ? dict.meta.description : ''
  if (!description.trim()) fail(`${file}: meta.description is required`)
  if (/reply library|回复库|four-layer|四层/iu.test(description)) {
    fail(`${file}: description still mentions the removed aggregate reply/four-layer store`)
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
