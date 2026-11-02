/**
 * Host half of the local recommendation-selection audit.
 *
 * There is deliberately no Bilibili client, no account credential, no comment,
 * favorite, delivery, QQ, or wake-up code. The host replays fixed local
 * trajectories and exposes only the tools needed to inspect and select videos.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAuditEngine, loadAuditInputs, resolveDataPath } from './lib/audit-engine.js'
import {
  DEFAULT_CONFIG,
  loadConfig,
  paths,
  saveConfig,
  sanitizeConfig,
  saveState,
  loadState,
} from './lib/store.js'
import { normalizeVideoLibrary } from './lib/video-library.js'
import { listTrajectoryIds, selectTrajectory } from './lib/trajectory.js'
import {
  errorMessage,
  makeLogger,
  readJsonStrict,
  readTail,
  resolveHomeDir,
  sameOriginOk,
  writeJson,
} from './lib/util.js'

export const name = 'bili-fav'
export const inject = ['webServer', 'tools']

const here = dirname(fileURLToPath(import.meta.url))
const API_PREFIX = '/api/bili-fav'
const MAX_BODY = 8_000_000
let VERSION = '2.0.0'
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

function ensureDefaultFiles(home, config) {
  const defaults = paths(home)
  if (config.libraryPath === DEFAULT_CONFIG.libraryPath && !existsSync(defaults.library)) {
    copyFileSync(join(here, 'examples', 'video-library.json'), defaults.library)
  }
  if (config.trajectoryPath === DEFAULT_CONFIG.trajectoryPath && !existsSync(defaults.trajectory)) {
    copyFileSync(join(here, 'examples', 'trajectory.json'), defaults.trajectory)
  }
}

function readDocument(file) {
  return readJsonStrict(file)
}

function validateDocumentBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  return body.document ?? body
}

function isTrajectoryDatabase(document) {
  return Boolean(document) && typeof document === 'object' && !Array.isArray(document) &&
    Boolean(document.trajectories) && typeof document.trajectories === 'object' &&
    !Array.isArray(document.trajectories)
}

export function apply(ctx) {
  const home = resolveHomeDir(ctx)
  const log = makeLogger(paths(home).log)
  let config = loadConfig(home)
  ensureDefaultFiles(home, config)
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
      '只读查看本地轨迹游标、剩余批次数、视频库数量、最近固定批次事件与选择记录。仅在 toolMode=all 时暴露。',
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
    ensureDefaultFiles(home, config)
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
    'bili-fav: audit tools',
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
        ensureDefaultFiles(home, currentConfig)
        const current = engine()
        const libraryDocument = readDocument(current.files.library)
        const trajectoryDocument = readDocument(current.files.trajectory)
        let trajectoryIds = listTrajectoryIds(trajectoryDocument)
        if (trajectoryIds.length === 0) trajectoryIds = ['default']
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
          trajectoryIds,
          status: current.status(),
          libraryDocument,
          trajectoryDocument,
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
        ensureDefaultFiles(home, candidate)
        // Validate the selected library/trajectory before persisting a mode or id
        // that would leave the replay environment unusable.
        loadAuditInputs({ home, config: candidate })
        config = saveConfig(home, candidate)
        syncTools()
        sendJson(res, 200, { ok: true, config })
        return
      }

      if (req.method === 'POST' && path === `${API_PREFIX}/library`) {
        const body = await readBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const document = validateDocumentBody(body)
        normalizeVideoLibrary(document)
        config = loadConfig(home)
        const file = resolveDataPath(home, config.libraryPath)
        writeJson(file, document)
        sendJson(res, 200, { ok: true, file })
        return
      }

      if (req.method === 'POST' && path === `${API_PREFIX}/trajectory`) {
        const body = await readBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const document = validateDocumentBody(body)
        config = loadConfig(home)
        const database = isTrajectoryDatabase(document)
        const currentId = config.trajectoryId
        const currentIdMissing = database && currentId && !Object.hasOwn(document.trajectories, currentId)
        const selected = currentIdMissing
          ? selectTrajectory(document)
          : selectTrajectory(document, currentId)
        const file = resolveDataPath(home, config.trajectoryPath)
        writeJson(file, document)
        if (currentIdMissing) {
          config = saveConfig(home, { trajectoryId: selected.id })
        }
        sendJson(res, 200, {
          ok: true,
          file,
          trajectoryId: selected.id,
          switchedFromMissingId: currentIdMissing ? currentId : '',
        })
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
    'bili-fav: local audit API',
  )

  ctx.effect(
    () => () => {
      disposed = true
      disposeTools()
    },
    'bili-fav: lifecycle',
  )

  log(`已挂载 v${VERSION}，home=${home}`)
}
