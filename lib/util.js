/**
 * Small dependency-free helpers shared by the local recommendation-audit host.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_DIR_NAME = 'bili-audit'

export function resolveHomeDir(ctx) {
  let base = ''
  try {
    const value = typeof ctx?.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof value === 'function') {
      const resolved = value(PLUGIN_DIR_NAME)
      if (resolved) base = String(resolved)
    } else if (typeof value === 'string' && value) {
      base = join(value, PLUGIN_DIR_NAME)
    }
  } catch {
    /* fall back below */
  }
  if (!base) base = join(process.env.DSH_HOME || join(homedir(), '.dsh'), PLUGIN_DIR_NAME)
  return ensureDir(base)
}

export function ensureDir(dir, mode = 0o700) {
  try {
    mkdirSync(dir, { recursive: true, mode })
    try {
      chmodSync(dir, mode)
    } catch {
      /* best effort */
    }
  } catch (error) {
    throw new Error(`无法创建插件目录 ${dir}：${error?.message ?? error}`)
  }
  return dir
}

export function readJson(file, fallback) {
  try {
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function readJsonStrict(file) {
  const raw = readFileSync(file, 'utf8')
  if (!raw.trim()) throw new Error(`${file} 是空文件`)
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Write JSON through a temp file so a crash cannot leave a half-written file. */
export function writeJson(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      /* ignore cleanup failure */
    }
    throw error
  }
  try {
    chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
}

export function fileExists(file) {
  return existsSync(file)
}

/** Reject ids that cannot safely be used as one filename/directory segment. */
export function safeFileId(value, label = 'id') {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error(`缺少${label}`)
  if (id.length > 200) throw new Error(`${label} 不能超过 200 个字符`)
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(id) || id === '.' || id === '..' || /[. ]$/u.test(id)) {
    throw new Error(`${label} 含有不能用于文件名的字符：${id}`)
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(id)) {
    throw new Error(`${label} 是 Windows 保留文件名：${id}`)
  }
  return id
}

/** List direct .json children in deterministic order. */
export function listJsonFiles(directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`数据目录不存在：${directory}`)
    throw new Error(`无法读取数据目录 ${directory}：${error?.message ?? error}`)
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

export function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

export function clampText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLength)
}

export function oneLine(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

export function errorMessage(error) {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function makeLogger(logFile) {
  let writes = 0
  return function log(message) {
    const line = `[${new Date().toISOString()}] ${oneLine(message, 2000)}\n`
    try {
      if (writes === 0) {
        try {
          if (statSync(logFile).size > 1024 * 1024) renameSync(logFile, `${logFile}.1`)
        } catch {
          /* no log yet */
        }
      }
      writes += 1
      appendFileSync(logFile, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      /* logging must never break a tool call */
    }
    if (writes % 20 === 1) console.log(`[bili-audit] ${oneLine(message, 500)}`)
  }
}

export function readTail(file, maxChars = 3000) {
  try {
    const raw = readFileSync(file, 'utf8')
    return raw.length > maxChars ? raw.slice(-maxChars) : raw
  } catch {
    return ''
  }
}

export function isLoopbackAuthority(value) {
  const authority = String(value || '').toLowerCase()
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(authority)
}

export function sameOriginOk(req) {
  try {
    const host = String(req.headers.host || '')
    if (!host) return true
    if (!isLoopbackAuthority(host)) return false
    const source = String(req.headers.origin || req.headers.referer || '')
    if (!source) return true
    const url = new URL(source)
    if (String(url.host || '').toLowerCase() === host.toLowerCase()) return true
    const defaultPort = url.protocol === 'https:' ? '443' : '80'
    return `${url.hostname}:${url.port || defaultPort}`.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

export function randomId(prefix = 'event') {
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}_${random}`
}
