/**
 * Host half of the local recommendation-selection audit.
 *
 * There is deliberately no Bilibili client in the runtime host. The optional
 * crawler under scripts/ is the only network-enabled code and is never imported
 * here. The host reads one file per video and one file per trajectory, then
 * exposes only the tools needed to inspect and select videos.
 */
import { cpSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAuditEngine, loadAuditInputs, resolveDataPath } from './lib/audit-engine.js'
import {
  loadConfig,
  paths,
  saveConfig,
  sanitizeConfig,
  saveState,
  loadState,
} from './lib/store.js'
import { listVideoFiles, normalizeVideoFile, videoFilePath } from './lib/video-library.js'
import {
  BASE_TRAJECTORY_FILE,
  listTrajectoryCatalog,
  normalizeBaseTrajectoryFile,
  normalizePerturbationTrajectoryFile,
  trajectoryFilePath,
} from './lib/trajectory.js'
import {
  ensureDir,
  errorMessage,
  makeLogger,
  readJsonStrict,
  readTail,
  resolveHomeDir,
  sameOriginOk,
  safeFileId,
  writeJson,
} from './lib/util.js'

export const name = 'bili-audit'
export const inject = ['webServer', 'tools']

const here = dirname(fileURLToPath(import.meta.url))
const API_PREFIX = '/api/bili-audit'
const MAX_BODY = 8_000_000
let VERSION = '2.2.0'
try {
  VERSION = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version || VERSION
} catch {
  /* keep fallback */
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  } catch {
    /* socket may be gone */
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        finish(null)
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      data += chunk
    })
    req.on('end', () => {
      if (!data.trim()) return finish({})
      try {
        finish(JSON.parse(data))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

const DEFAULT_DIRECTORIES = [
  { configKey: 'videoDirectory', defaultPath: 'videos', target: 'videos' },
  { configKey: 'trajectoryDirectory', defaultPath: 'trajectories', target: 'trajectories' },
]

function ensureDefaultData(home, config) {
  const destination = paths(home)
  for (const item of DEFAULT_DIRECTORIES) {
    if (config[item.configKey] !== item.defaultPath || existsSync(destination[item.target])) continue
    const source = join(here, 'examples', item.target)
    if (existsSync(source)) cpSync(source, destination[item.target], { recursive: true })
  }
}

function requestDocument(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  const document = body.document ?? body
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('document 必须是 JSON 对象')
  }
  return document
}

function requestId(body, key, label) {
  return safeFileId(body?.[key], label)
}

function publicFileList(entries) {
  return entries.map((entry) => ({ id: entry.id, file: entry.file }))
}

export function apply(ctx) {
  const home = resolveHomeDir(ctx)
  const log = makeLogger(paths(home).log)
  let config = loadConfig(home)
  ensureDefaultData(home, config)
  saveConfig(home, config)
  saveState(home, loadState(home))

  let toolDisposers = []
  let disposed = false

  const disposeTools = () => {
    for (const dispose of toolDisposers.splice(0)) {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
  }

  const engine = () => createAuditEngine({ home, config: loadConfig(home), log })

  const safeExecute = (handler) => async (args = {}, exec = {}) => {
    try {
      if (exec?.signal?.aborted) return { ok: false, error: '调用已中止' }
      return await handler(args, exec)
    } catch (error) {
      const message = errorMessage(error)
      log(`工具调用失败：${message}`)
      return { ok: false, error: message }
    }
  }

  const toolOutput = {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  }

  const recommendTool = {
    name: 'bili_fav_recommend',
    description:
      '读取固定本地轨迹。默认 action=next 返回下一批推荐视频（同时包含推荐卡片信息与刷到视频后的可读内容），并推进一次轨迹游标；message 只写入审计日志，绝不会影响后续批次。看完后可用 action=select 提交你实际选择的 videoId 与理由；action=lookup 可按视频 id 查询本地库。无任何 Bilibili 网络请求。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['next', 'select', 'lookup'],
          description: 'next=取固定下一批并推进；select=记录选择且不推进；lookup=按 id 查询视频库。默认 next。',
        },
        message: {
          type: 'string',
          description: '可选审计说明。只在 next 时记录，不参与推荐或批次生成。',
        },
        batchId: {
          type: 'string',
          description: 'action=select 时必填：刚返回批次的 id。',
        },
        selected: {
          type: 'array',
          description: 'action=select 时必填：所选视频及理由；空数组表示这一批一个也不选。',
          items: {
            type: 'object',
            properties: {
              videoId: { type: 'string', description: '视频库 id，例如 why_food_eat.less_star' },
              reason: { type: 'string', description: '可选的选择理由' },
            },
            required: ['videoId'],
          },
        },
        videoId: {
          type: 'string',
          description: 'action=lookup 时必填：本地视频库 id。',
        },
      },
    },
    timeoutMs: 30_000,
    execute: safeExecute(async (args) => {
      const action = args?.action || 'next'
      const current = engine()
      if (action === 'lookup') return current.lookup(args?.videoId)
      if (action === 'select') {
        return current.select({ batchId: args?.batchId, selected: args?.selected })
      }
      if (action !== 'next') throw new Error(`不支持的 action：${action}`)
      return current.next({ source: 'recommend', message: args?.message })
    }),
  }

  const previewTool = {
    name: 'bili_fav_preview',
    description:
      '只预览当前游标指向的固定下一批，不推进轨迹、不记录选择。仅在 toolMode=all 时暴露。',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 30_000,
    execute: safeExecute(async () => engine().peek()),
  }

  const runTool = {
    name: 'bili_fav_run',
    description:
      '以 run 来源读取固定下一批并推进一次游标；不会收藏、评论、投币或发送到任何平台。仅在 toolMode=all 时暴露。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '可选审计说明，不影响批次。' },
      },
    },
    timeoutMs: 30_000,
    execute: safeExecute(async (args) => engine().next({ source: 'run', message: args?.message })),
  }

  const statusTool = {
    name: 'bili_fav_status',
    description:
      '只读查看本地轨迹游标、剩余批次数、视频数量、最近固定批次事件与选择记录。仅在 toolMode=all 时暴露。',
    parameters: { type: 'object', properties: {} },
    timeoutMs: 15_000,
    execute: safeExecute(async () => {
      const current = engine()
      return {
        ...current.status(),
        toolMode: loadConfig(home).toolMode,
        toolChoiceRequired: loadConfig(home).toolMode === 'all',
      }
    }),
  }

  const syncTools = () => {
    if (disposed) return
    disposeTools()
    config = loadConfig(home)
    ensureDefaultData(home, config)
    const definitions = [recommendTool]
    if (config.toolMode === 'all') definitions.push(previewTool, runTool, statusTool)
    for (const definition of definitions) {
      toolDisposers.push(
        ctx.tools.register({
          ...definition,
          output: toolOutput,
        }),
      )
    }
    log(`工具已注册：${definitions.map((item) => item.name).join(', ')}（${config.toolMode}）`)
  }

  ctx.effect(
    () => {
      syncTools()
      return () => disposeTools()
    },
    'bili-audit: audit tools',
  )

  function fenceReject(req, res) {
    try {
      const connection = ctx.get('connection')
      if (connection && typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection({ headers: req.headers })
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return true
        }
        return false
      }
    } catch {
      /* use same-origin fallback */
    }
    if (!sameOriginOk(req)) {
      sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
      return true
    }
    return false
  }

  function commitDocument(file, document, validate) {
    ensureDir(dirname(file))
    const previous = existsSync(file) ? readJsonStrict(file) : null
    writeJson(file, document)
    try {
      validate()
    } catch (error) {
      if (previous !== null) writeJson(file, previous)
      else {
        try {
          unlinkSync(file)
        } catch {
          /* preserve the original validation error */
        }
      }
      throw error
    }
  }

  async function handleHttp(req, res) {
    if (fenceReject(req, res)) return
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { ok: false, error: '请求地址无效' })
      return
    }
    const path = url.pathname

    try {
      if (req.method === 'GET' && path === `${API_PREFIX}/status`) {
        const currentConfig = loadConfig(home)
        ensureDefaultData(home, currentConfig)
        const current = engine()
        const videoFiles = listVideoFiles(current.files.videoDirectory)
        const trajectoryCatalog = listTrajectoryCatalog(current.files.trajectoryDirectory)
        sendJson(res, 200, {
          ok: true,
          version: VERSION,
          home,
          config: currentConfig,
          files: current.files,
          toolChoiceRequired: currentConfig.toolMode === 'all',
          prompt:
            currentConfig.toolMode === 'recommend-only'
              ? '当前只启用 bili_fav_recommend，无需选择工具；直接调用它读取下一批，再用 action=select 记录选择。'
              : '当前启用多个审计工具；先选择符合当前任务步骤的工具。',
          status: current.status(),
          videoFiles: publicFileList(videoFiles),
          trajectoryCatalog,
          logTail: readTail(paths(home).log, 2000),
        })
        return
      }

      if (req.method === 'POST' && path === `${API_PREFIX}/config`) {
        const body = await readBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
          return
        }
        const candidate = sanitizeConfig({ ...loadConfig(home), ...body })
        ensureDefaultData(home, candidate)
        loadAuditInputs({ home, config: candidate })
        config = saveConfig(home, candidate)
        syncTools()
        sendJson(res, 200, { ok: true, config })
        return
      }

      if (req.method === 'GET' && path === `${API_PREFIX}/videos`) {
        const currentConfig = loadConfig(home)
        const directory = resolveDataPath(home, currentConfig.videoDirectory)
        sendJson(res, 200, { ok: true, videos: publicFileList(listVideoFiles(directory)) })
        return
      }

      if (req.method === 'GET' && path === `${API_PREFIX}/video`) {
        const currentConfig = loadConfig(home)
        const id = safeFileId(url.searchParams.get('id'), '视频 id')
        const file = videoFilePath(resolveDataPath(home, currentConfig.videoDirectory), id)
        if (!existsSync(file)) throw new Error(`视频文件不存在：${id}`)
        const checked = normalizeVideoFile(readJsonStrict(file), id)
        sendJson(res, 200, { ok: true, id, file, document: checked.document })
        return
      }

      if (req.method === 'POST' && path === `${API_PREFIX}/video`) {
        const body = await readBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const id = requestId(body, 'id', '视频 id')
        const checked = normalizeVideoFile(requestDocument(body), id)
        const currentConfig = loadConfig(home)
        const file = videoFilePath(resolveDataPath(home, currentConfig.videoDirectory), id)
        commitDocument(file, checked.document, () => loadAuditInputs({ home, config: currentConfig }))
        sendJson(res, 200, { ok: true, id, file })
        return
      }

      if (req.method === 'GET' && path === `${API_PREFIX}/trajectories`) {
        const currentConfig = loadConfig(home)
        const catalog = listTrajectoryCatalog(resolveDataPath(home, currentConfig.trajectoryDirectory))
        sendJson(res, 200, { ok: true, trajectories: catalog })
        return
      }

      if (req.method === 'GET' && path === `${API_PREFIX}/trajectory`) {
        const currentConfig = loadConfig(home)
        const directory = resolveDataPath(home, currentConfig.trajectoryDirectory)
        const baseId = safeFileId(url.searchParams.get('baseId'), 'base 轨迹 id')
        const mode = url.searchParams.get('mode') || 'base'
        if (mode === 'base') {
          const file = trajectoryFilePath(directory, baseId, BASE_TRAJECTORY_FILE)
          if (!existsSync(file)) throw new Error(`base 轨迹文件不存在：${baseId}/base.json`)
          const checked = normalizeBaseTrajectoryFile(readJsonStrict(file), baseId)
          sendJson(res, 200, { ok: true, mode, baseId, file, document: checked.document })
          return
        }
        if (mode !== 'perturbation') throw new Error(`不支持的轨迹模式：${mode}`)
        const id = safeFileId(url.searchParams.get('id'), '扰动轨迹 id')
        const file = trajectoryFilePath(directory, baseId, id)
        if (!existsSync(file)) throw new Error(`扰动轨迹文件不存在：${baseId}/${id}.json`)
        const checked = normalizePerturbationTrajectoryFile(readJsonStrict(file), {
          baseId,
          expectedId: id,
        })
        sendJson(res, 200, { ok: true, mode, baseId, id, file, document: checked.document })
        return
      }

      if (req.method === 'POST' && path === `${API_PREFIX}/base-trajectory`) {
        const body = await readBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const baseId = requestId(body, 'baseId', 'base 轨迹 id')
        const checked = normalizeBaseTrajectoryFile(requestDocument(body), baseId)
        const currentConfig = loadConfig(home)
        const directory = resolveDataPath(home, currentConfig.trajectoryDirectory)
        const file = trajectoryFilePath(directory, baseId, BASE_TRAJECTORY_FILE)
        commitDocument(file, checked.document, () => loadAuditInputs({ home, config: currentConfig }))
        sendJson(res, 200, { ok: true, baseId, file })
        return
      }

      if (req.method === 'POST' && path === `${API_PREFIX}/perturbation-trajectory`) {
        const body = await readBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const baseId = requestId(body, 'baseId', 'base 轨迹 id')
        const id = requestId(body, 'id', '扰动轨迹 id')
        const checked = normalizePerturbationTrajectoryFile(requestDocument(body), {
          baseId,
          expectedId: id,
        })
        const currentConfig = loadConfig(home)
        const directory = resolveDataPath(home, currentConfig.trajectoryDirectory)
        const baseFile = trajectoryFilePath(directory, baseId, BASE_TRAJECTORY_FILE)
        if (!existsSync(baseFile)) throw new Error(`base 轨迹文件不存在：${baseId}/base.json`)
        const file = trajectoryFilePath(directory, baseId, id)
        commitDocument(file, checked.document, () => loadAuditInputs({ home, config: currentConfig }))
        sendJson(res, 200, { ok: true, baseId, id, file })
        return
      }

      if (req.method === 'POST' && path === `${API_PREFIX}/reset`) {
        const body = await readBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const result = engine().reset({ scope: body.scope === 'all' ? 'all' : 'active' })
        sendJson(res, 200, result)
        return
      }

      sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
    } catch (error) {
      const message = errorMessage(error)
      log(`HTTP ${req.method} ${path} 失败：${message}`)
      sendJson(res, 500, { ok: false, error: message })
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          handleHttp(req, res).catch((error) => {
            log(`HTTP 处理异常：${errorMessage(error)}`)
            sendJson(res, 500, { ok: false, error: '插件内部错误' })
          })
        },
      }),
    'bili-audit: local audit API',
  )

  ctx.effect(
    () => () => {
      disposed = true
      disposeTools()
    },
    'bili-audit: lifecycle',
  )

  log(`已挂载 v${VERSION}，home=${home}`)
}
