#!/usr/bin/env node
/**
 * Explicit, rate-limited Bilibili metadata collector.
 *
 * This is the only network-enabled product code. The DSH plugin never imports
 * it. It performs read-only requests, never logs in, and writes one
 * agent-readable file per video. Perturbation slots intentionally start empty.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { listVideoFiles, normalizeVideoFile, videoFilePath } from '../lib/video-library.js'
import { readJsonStrict, writeJson } from '../lib/util.js'

const API_BASE = 'https://api.bilibili.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const WBI_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]
const SUBTITLE_HOSTS = [/(^|\.)hdslb\.com$/i, /(^|\.)bilibili\.com$/i]
const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_JITTER_MS = 500
const DEFAULT_MAX_VIDEOS = 20
const DEFAULT_SUBTITLE_MAX_CHARS = 12_000

export class BiliCrawlError extends Error {
  constructor(message, { fatal = false, status = 0, code = -1, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'BiliCrawlError'
    this.fatal = fatal
    this.status = status
    this.code = code
  }
}

export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new BiliCrawlError('采集已中止', { fatal: true }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new BiliCrawlError('采集已中止', { fatal: true }))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** Shared by every request, including retries, so bursts are impossible. */
export class RequestPacer {
  constructor({
    minIntervalMs = DEFAULT_INTERVAL_MS,
    jitterMs = DEFAULT_JITTER_MS,
    now = Date.now,
    sleepImpl = sleep,
    random = Math.random,
  } = {}) {
    const interval = Number(minIntervalMs)
    const jitter = Number(jitterMs)
    if (!Number.isFinite(interval) || interval < 1000) {
      throw new BiliCrawlError('请求间隔不得低于 1000ms')
    }
    if (!Number.isFinite(jitter) || jitter < 0) {
      throw new BiliCrawlError('请求抖动必须是大于等于 0 的毫秒数')
    }
    this.minIntervalMs = Math.trunc(interval)
    this.jitterMs = Math.trunc(jitter)
    this.now = now
    this.sleep = sleepImpl
    this.random = random
    this.nextAt = 0
  }

  async wait(signal) {
    const delay = Math.max(0, this.nextAt - this.now())
    if (delay > 0) await this.sleep(delay, signal)
    const startedAt = this.now()
    this.nextAt = startedAt + this.minIntervalMs + Math.floor(this.random() * (this.jitterMs + 1))
  }
}

export function parseCookieInput(input) {
  const text = String(input || '').trim()
  if (!text) return ''
  let value = text
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string') value = parsed
    else if (parsed && typeof parsed === 'object') {
      value = typeof parsed.cookie === 'string'
        ? parsed.cookie
        : typeof parsed.BILI_COOKIE === 'string'
          ? parsed.BILI_COOKIE
          : Object.entries(parsed)
              .filter(([, item]) => item !== undefined && item !== null && String(item) !== '')
              .map(([name, item]) => `${name}=${String(item)}`)
              .join('; ')
    }
  } catch {
    /* raw Cookie header */
  }
  return String(value || '').replace(/^cookie\s*:\s*/i, '').replace(/[\r\n]+/g, '; ').trim()
}

export function loadCookie({ cookieFile = '', env = process.env } = {}) {
  if (cookieFile) return parseCookieInput(readFileSync(resolve(cookieFile), 'utf8'))
  return parseCookieInput(env.BILI_COOKIE || '')
}

function keyFromUrl(value) {
  return String(value || '').split('/').pop()?.split('.')[0] || ''
}

export function deriveMixinKey(imgUrl, subUrl) {
  const source = keyFromUrl(imgUrl) + keyFromUrl(subUrl)
  return WBI_TAB.map((index) => source[index] || '').join('').slice(0, 32)
}

function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

export function signedQuery(params, mixinKey, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const withTimestamp = { ...params, wts: timestampSeconds }
  const query = Object.keys(withTimestamp)
    .sort()
    .map((key) => {
      const raw = String(withTimestamp[key] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(raw)}`
    })
    .join('&')
  return `${query}&w_rid=${md5(query + mixinKey)}`
}

export function normalizeCover(url) {
  if (typeof url !== 'string' || !url) return ''
  if (url.startsWith('//')) return `https:${url}`
  return url.replace(/^http:\/\//i, 'https://')
}

export function isAllowedSubtitleUrl(value) {
  try {
    const url = new URL(String(value).startsWith('//') ? `https:${value}` : String(value))
    return url.protocol === 'https:' && SUBTITLE_HOSTS.some((pattern) => pattern.test(url.hostname))
  } catch {
    return false
  }
}

function number(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function text(value) {
  return String(value ?? '').trim()
}

function apiDescription(code, message) {
  const suffix = message && message !== '0' ? `：${message}` : ''
  if (Number(code) === -101) return `B站接口要求登录${suffix}`
  if (Number(code) === -352) return `B站风控校验失败（-352）${suffix}`
  if (Number(code) === -412) return `B站风控拦截（-412）${suffix}`
  return `B站接口返回 ${code}${suffix}`
}

export function buildVideoRecord({ feed, detail, tags = [], subtitle = null, crawledAt = new Date().toISOString() }) {
  const bvid = text(detail?.bvid || feed?.bvid)
  if (!bvid) throw new BiliCrawlError('视频缺少 bvid，无法生成稳定 id')
  const id = `video-${bvid.toLowerCase()}`
  const title = text(detail?.title || feed?.title)
  const description = text(detail?.desc)
  const subtitleLines = Array.isArray(subtitle?.lines) ? subtitle.lines.map(text).filter(Boolean) : []
  const content = []
  if (description) content.push({ type: 'text', text: description })
  if (subtitle?.text && subtitleLines.length === 0) content.push({ type: 'text', text: text(subtitle.text) })
  return {
    schemaVersion: 3,
    id,
    bvid,
    aid: number(detail?.aid || feed?.aid),
    cid: number(detail?.cid || feed?.cid),
    source: {
      platform: 'bilibili',
      authority: 'read-only-crawler',
      crawledAt,
    },
    recommendation: {
      title,
      author: text(detail?.author || feed?.author),
      authorMid: number(detail?.authorMid || feed?.authorMid),
      duration: number(feed?.duration || detail?.duration),
      pubdate: number(feed?.pubdate || detail?.pubdate),
      stats: {
        views: number(feed?.view ?? detail?.view),
        likes: number(feed?.like ?? detail?.like),
        danmaku: number(feed?.danmaku ?? detail?.danmaku),
        replies: number(feed?.reply ?? detail?.reply),
        favorites: number(feed?.favorite ?? detail?.favorite),
        coins: number(feed?.coin ?? detail?.coin),
        shares: number(feed?.share ?? detail?.share),
      },
      cover: {
        type: 'image',
        url: normalizeCover(detail?.cover || feed?.cover),
        alt: title,
      },
      rcmdReason: text(feed?.rcmdReason),
      trackId: text(feed?.trackId),
    },
    watch: {
      title,
      description,
      category: text(detail?.category),
      tags: Array.isArray(tags) ? tags.map(text).filter(Boolean).slice(0, 16) : [],
      duration: number(detail?.duration || feed?.duration),
      stats: {
        views: number(detail?.view ?? feed?.view),
        likes: number(detail?.like ?? feed?.like),
        danmaku: number(detail?.danmaku ?? feed?.danmaku),
        replies: number(detail?.reply ?? feed?.reply),
        favorites: number(detail?.favorite ?? feed?.favorite),
        coins: number(detail?.coin ?? feed?.coin),
        shares: number(detail?.share ?? feed?.share),
      },
      content,
      subtitles: subtitleLines,
      subtitle: {
        available: subtitleLines.length > 0,
        language: text(subtitle?.lan),
        lines: subtitleLines.length,
      },
    },
    perturbations: {},
  }
}

function mapFeedItem(item) {
  return {
    bvid: text(item?.bvid),
    aid: number(item?.id),
    cid: number(item?.cid),
    title: text(item?.title),
    cover: normalizeCover(item?.pic),
    duration: number(item?.duration),
    pubdate: number(item?.pubdate),
    author: text(item?.owner?.name),
    authorMid: number(item?.owner?.mid),
    view: number(item?.stat?.view),
    like: number(item?.stat?.like),
    danmaku: number(item?.stat?.danmaku),
    reply: number(item?.stat?.reply),
    favorite: number(item?.stat?.favorite),
    coin: number(item?.stat?.coin),
    share: number(item?.stat?.share),
    rcmdReason: text(item?.rcmd_reason),
    trackId: text(item?.track_id),
  }
}

function mapDetail(data) {
  return {
    aid: number(data?.aid),
    cid: number(data?.cid),
    bvid: text(data?.bvid),
    title: text(data?.title),
    desc: text(data?.desc),
    cover: normalizeCover(data?.pic),
    duration: number(data?.duration),
    pubdate: number(data?.pubdate),
    author: text(data?.owner?.name),
    authorMid: number(data?.owner?.mid),
    category: text(data?.tname),
    view: number(data?.stat?.view),
    like: number(data?.stat?.like),
    danmaku: number(data?.stat?.danmaku),
    reply: number(data?.stat?.reply),
    favorite: number(data?.stat?.favorite),
    coin: number(data?.stat?.coin),
    share: number(data?.stat?.share),
  }
}

function expectApiData(json, action) {
  if (Number(json?.code) === 0) return json.data
  throw new BiliCrawlError(`${action}失败：${apiDescription(json?.code ?? -1, json?.message)}`, {
    code: Number(json?.code ?? -1),
  })
}

function trimSubtitleLines(lines, maxChars) {
  const output = []
  let used = 0
  for (const line of lines) {
    const value = text(line)
    if (!value) continue
    if (used + value.length > maxChars) {
      const rest = value.slice(0, Math.max(0, maxChars - used))
      if (rest) output.push(rest)
      break
    }
    output.push(value)
    used += value.length + 1
    if (used >= maxChars) break
  }
  return output
}

export async function crawlBilibili({
  fetchImpl = globalThis.fetch,
  pages = 1,
  ps = 20,
  maxVideos = DEFAULT_MAX_VIDEOS,
  intervalMs = DEFAULT_INTERVAL_MS,
  jitterMs = DEFAULT_JITTER_MS,
  withSubtitles = false,
  subtitleMaxChars = DEFAULT_SUBTITLE_MAX_CHARS,
  cookie = '',
  logger = console,
  signal,
  now = Date.now,
  sleepImpl = sleep,
  random = Math.random,
  timeoutMs = 20_000,
  existingRecords = [],
} = {}) {
  if (typeof fetchImpl !== 'function') throw new BiliCrawlError('当前环境没有可用的 fetch')
  const pageCount = Math.max(1, Math.min(50, Math.trunc(Number(pages) || 1)))
  const pageSize = Math.max(1, Math.min(30, Math.trunc(Number(ps) || 20)))
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(maxVideos) || DEFAULT_MAX_VIDEOS)))
  const maxSubtitleChars = Math.max(100, Math.min(100_000, Math.trunc(Number(subtitleMaxChars) || DEFAULT_SUBTITLE_MAX_CHARS)))
  const pacer = new RequestPacer({ minIntervalMs: intervalMs, jitterMs, now, sleepImpl, random })
  const normalizedCookie = parseCookieInput(cookie)
  let mixinKey = ''

  async function requestJson(url, { includeCookie = true, action = '请求 B站' } = {}) {
    let attempt = 0
    while (attempt < 3) {
      await pacer.wait(signal)
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs)
        const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
        const headers = {
          'User-Agent': UA,
          Referer: REFERER,
          Accept: 'application/json, text/plain, */*',
        }
        if (includeCookie && normalizedCookie) headers.Cookie = normalizedCookie
        const response = await fetchImpl(url, {
          headers,
          signal: requestSignal,
          // Never let a redirect turn an allow-listed API/CDN request into an
          // arbitrary destination, and never forward credentials implicitly.
          redirect: 'error',
        })
        if (response.status === 412 || response.status === 429) {
          throw new BiliCrawlError(
            response.status === 412
              ? '请求被 B站风控拦截（412）；已立即停止，未重试'
              : 'B站触发限流（429）；已立即停止，未重试',
            { fatal: true, status: response.status },
          )
        }
        if (response.status >= 500 && attempt < 2) {
          attempt += 1
          const backoff = 800 * 2 ** (attempt - 1)
          logger.warn?.(`${action}遇到 HTTP ${response.status}，${backoff}ms 后重试（${attempt}/2）`)
          await sleepImpl(backoff, signal)
          continue
        }
        if (!response.ok) {
          throw new BiliCrawlError(`${action}失败：HTTP ${response.status}`, { status: response.status })
        }
        const raw = await response.text()
        try {
          return JSON.parse(raw)
        } catch {
          throw new BiliCrawlError(`${action}失败：响应不是 JSON`, { status: response.status })
        }
      } catch (error) {
        if (error instanceof BiliCrawlError) {
          if (error.fatal || error.status === 412 || error.status === 429) throw error
          if (attempt >= 2) throw error
        } else {
          if (attempt >= 2) {
            throw new BiliCrawlError(`${action}失败：${error?.message ?? error}`, { cause: error })
          }
        }
        attempt += 1
        const backoff = 800 * 2 ** (attempt - 1)
        logger.warn?.(`${action}暂时失败，${backoff}ms 后重试（${attempt}/2）`)
        await sleepImpl(backoff, signal)
      }
    }
    throw new BiliCrawlError(`${action}失败：重试次数已用尽`)
  }

  async function ensureWbi() {
    if (mixinKey) return mixinKey
    const json = await requestJson(`${API_BASE}/x/web-interface/nav`, { action: '读取 WBI 密钥' })
    const img = json?.data?.wbi_img
    if (!img?.img_url || !img?.sub_url) {
      throw new BiliCrawlError(`读取 WBI 密钥失败：${apiDescription(json?.code ?? -1, json?.message)}`)
    }
    mixinKey = deriveMixinKey(img.img_url, img.sub_url)
    if (mixinKey.length !== 32) throw new BiliCrawlError('读取 WBI 密钥失败：派生结果无效')
    return mixinKey
  }

  async function signedGet(path, params, action) {
    const key = await ensureWbi()
    return requestJson(`${API_BASE}${path}?${signedQuery(params, key)}`, { action })
  }

  async function feed(page) {
    const json = await signedGet(
      '/x/web-interface/wbi/index/top/feed/rcmd',
      {
        web_location: 1430650,
        feed_version: 'V8',
        fresh_type: 4,
        ps: pageSize,
        plat: 0,
        fresh_idx: page,
        brush: page - 1,
        y_num: 5,
        homepage_ver: 1,
        screen: '1920-1080',
      },
      '获取推荐流',
    )
    const data = expectApiData(json, '获取推荐流')
    return (Array.isArray(data?.item) ? data.item : [])
      .filter((item) => item?.goto === 'av' && item.bvid && item.cid)
      .map(mapFeedItem)
  }

  async function detail(bvid) {
    const json = await requestJson(
      `${API_BASE}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { action: `读取视频 ${bvid}` },
    )
    return mapDetail(expectApiData(json, `读取视频 ${bvid}`))
  }

  async function tags(bvid) {
    const json = await requestJson(
      `${API_BASE}/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`,
      { action: `读取标签 ${bvid}` },
    )
    if (Number(json?.code) !== 0) return []
    return (Array.isArray(json.data) ? json.data : [])
      .map((tag) => text(tag?.tag_name))
      .filter(Boolean)
      .slice(0, 16)
  }

  async function subtitle({ aid, cid }) {
    if (!aid || !cid) return null
    let player = null
    try {
      const json = await signedGet('/x/player/wbi/v2', { aid, cid }, `读取视频 ${cid} 字幕列表`)
      if (Number(json?.code) === 0) player = json.data
    } catch (error) {
      if (error?.fatal) throw error
    }
    if (!player) {
      try {
        const json = await requestJson(
          `${API_BASE}/x/player/v2?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}`,
          { action: `读取视频 ${cid} 字幕列表` },
        )
        if (Number(json?.code) === 0) player = json.data
      } catch (error) {
        if (error?.fatal) throw error
      }
    }
    const choices = Array.isArray(player?.subtitle?.subtitles) ? player.subtitle.subtitles : []
    if (choices.length === 0) return { lan: '', text: '', lines: [] }
    const preferred =
      choices.find((item) => /^zh/i.test(text(item?.lan))) ||
      choices.find((item) => /ai-zh|中文|chinese/i.test(text(item?.lan))) ||
      choices[0]
    const rawUrl = text(preferred?.subtitle_url)
    if (!isAllowedSubtitleUrl(rawUrl)) return { lan: text(preferred?.lan), text: '', lines: [] }
    const url = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl)
    try {
      // Deliberately do not send the Cookie header to the subtitle CDN.
      const body = await requestJson(url, { includeCookie: false, action: '读取字幕 CDN' })
      const lines = trimSubtitleLines(
        (Array.isArray(body?.body) ? body.body : []).map((line) => line?.content),
        maxSubtitleChars,
      )
      return { lan: text(preferred?.lan), text: lines.join('\n'), lines }
    } catch (error) {
      logger.warn?.(`读取字幕失败（忽略该视频字幕）：${error?.message ?? error}`)
      return { lan: text(preferred?.lan), text: '', lines: [] }
    }
  }

  const existingBvids = new Set()
  for (const item of Array.isArray(existingRecords) ? existingRecords : []) {
    const bvid = text(item?.bvid).toLowerCase()
    if (bvid) existingBvids.add(bvid)
  }
  const records = []
  const seen = new Set()
  let skipped = 0
  for (let page = 1; page <= pageCount && records.length < limit; page += 1) {
    logger.info?.(`读取推荐流第 ${page}/${pageCount} 页`)
    const items = await feed(page)
    for (const item of items) {
      if (records.length >= limit) break
      const key = item.bvid.toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (existingBvids.has(key)) {
        logger.info?.(`resume：跳过已有 ${item.bvid}`)
        skipped += 1
        continue
      }
      const full = await detail(item.bvid)
      const tagList = await tags(item.bvid)
      const subtitleInfo = withSubtitles ? await subtitle({ aid: full.aid, cid: full.cid }) : null
      records.push(buildVideoRecord({ feed: item, detail: full, tags: tagList, subtitle: subtitleInfo }))
      logger.info?.(`已采集 ${records.length}/${limit}：${item.bvid} ${item.title}`)
    }
  }

  return { records, added: records.length, skipped }
}

/** Read every per-video file so --resume can match BVIDs and preserve edits. */
export function readExistingVideos(directory) {
  if (!existsSync(directory)) return []
  if (!statSync(directory).isDirectory()) {
    throw new BiliCrawlError(`输出路径必须是视频文件夹：${directory}`)
  }
  const records = []
  const seen = new Set()
  for (const entry of listVideoFiles(directory)) {
    const checked = normalizeVideoFile(readJsonStrict(entry.file), entry.id)
    const bvid = text(checked.document.bvid).toLowerCase()
    if (!bvid) throw new BiliCrawlError(`已有视频文件缺少 bvid：${entry.file}`)
    if (seen.has(bvid)) throw new BiliCrawlError(`视频目录中 BVID 重复：${checked.document.bvid}`)
    seen.add(bvid)
    records.push(checked.document)
  }
  return records
}

/**
 * Write generated records without touching unrelated manual files. Collisions
 * with a different BVID are never overwritten, even under --force.
 */
export function writeCrawledVideos(directory, records, { force = false } = {}) {
  mkdirSync(directory, { recursive: true })
  const written = []
  for (const record of records) {
    const file = videoFilePath(directory, record?.id)
    if (existsSync(file)) {
      const existing = normalizeVideoFile(readJsonStrict(file), record.id).document
      const sameVideo = text(existing.bvid).toLowerCase() === text(record.bvid).toLowerCase()
      if (!sameVideo) {
        throw new BiliCrawlError(`文件名冲突：${file} 已属于另一个 BVID；拒绝覆盖`)
      }
      if (!force) throw new BiliCrawlError(`视频文件已存在：${file}；使用 --resume 跳过或 --force 覆盖`)
    }
    writeJson(file, record)
    written.push(file)
  }
  return written
}

function usage() {
  return `Usage: node scripts/crawl-bilibili.mjs [options]

Options:
  --pages <n>                 推荐流页数，1-50（默认 1）
  --ps <n>                    每页条数，1-30（默认 20）
  --max-videos <n>            最多采集视频数，1-500（默认 20）
  --interval-ms <n>           请求最小间隔，不能低于 1000（默认 2000）
  --jitter-ms <n>             随机额外间隔上限（默认 500）
  --with-subtitles            尝试采集字幕（可能要求登录 Cookie）
  --subtitle-max-chars <n>    每视频字幕最大字符数（默认 12000）
  --output <dir>              输出视频文件夹，每个视频一个 JSON（默认 videos）
  --resume                    扫描已有视频文件，跳过已知 BVID 并保留人工扰动
  --force                     允许覆盖同名且 BVID 相同的生成文件
  --cookie-file <file>        本地 Cookie 文本/JSON；也可用 BILI_COOKIE 环境变量
  --timeout-ms <n>            单请求超时（默认 20000）
  --help                      显示帮助

爬虫只读取公开页面信息，不登录、不收藏、不评论、不投币。
`;
}

export function parseCrawlerArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      pages: { type: 'string' },
      ps: { type: 'string' },
      'max-videos': { type: 'string' },
      'interval-ms': { type: 'string' },
      'jitter-ms': { type: 'string' },
      'with-subtitles': { type: 'boolean' },
      'subtitle-max-chars': { type: 'string' },
      output: { type: 'string' },
      resume: { type: 'boolean' },
      force: { type: 'boolean' },
      'cookie-file': { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  })
  return values
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseCrawlerArgs(argv)
  if (values.help) {
    process.stdout.write(usage())
    return
  }
  if (values.resume && values.force) {
    throw new BiliCrawlError('--resume 与 --force 不能同时使用')
  }
  const output = resolve(values.output || 'videos')
  if (existsSync(output) && !values.resume && !values.force) {
    throw new BiliCrawlError(`输出文件夹已存在：${output}。使用 --resume 追加，或显式传 --force 覆盖生成文件。`)
  }
  if (existsSync(output) && !statSync(output).isDirectory()) {
    throw new BiliCrawlError(`输出路径必须是视频文件夹：${output}`)
  }
  const existingRecords = values.resume ? readExistingVideos(output) : []
  const cookie = loadCookie({ cookieFile: values['cookie-file'] || '' })
  const result = await crawlBilibili({
    pages: Number(values.pages || 1),
    ps: Number(values.ps || 20),
    maxVideos: Number(values['max-videos'] || DEFAULT_MAX_VIDEOS),
    intervalMs: Number(values['interval-ms'] || DEFAULT_INTERVAL_MS),
    jitterMs: Number(values['jitter-ms'] ?? DEFAULT_JITTER_MS),
    withSubtitles: Boolean(values['with-subtitles']),
    subtitleMaxChars: Number(values['subtitle-max-chars'] || DEFAULT_SUBTITLE_MAX_CHARS),
    timeoutMs: Number(values['timeout-ms'] || 20_000),
    cookie,
    existingRecords,
  })
  writeCrawledVideos(output, result.records, { force: Boolean(values.force) })
  process.stdout.write(
    `采集完成：新增 ${result.added} 个视频文件，输出文件夹 ${output}\n` +
      `推荐流中已有 BVID 跳过 ${result.skipped} 个；新增视频的 perturbations 初始为空，--resume 不会改动已有文件及其扰动。\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
