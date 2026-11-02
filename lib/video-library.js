/**
 * Local video library.
 *
 * A library item stores only agent-readable material, never a real video:
 *   recommendation: what the feed card showed
 *   watch:          what would be observed after opening the video
 *
 * Both sections are opaque JSON so callers can store text, image descriptors,
 * subtitles, accessibility notes, or future modalities without changing code.
 */
import { readJsonStrict } from './util.js'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function videoId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

export function mergeDeep(base, override) {
  if (!isRecord(base) || !isRecord(override)) return override === undefined ? base : override
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (isRecord(value) && isRecord(result[key])) result[key] = mergeDeep(result[key], value)
    else result[key] = value
  }
  return result
}

function normalizeItem(raw, fallbackId = '') {
  if (!isRecord(raw)) throw new Error(`视频 ${fallbackId || '(缺少 id)'} 必须是对象`)
  const id = videoId(raw.id) || fallbackId
  if (!id) throw new Error('视频库中存在缺少 id 的条目')
  const recommendation = isRecord(raw.recommendation)
    ? raw.recommendation
    : isRecord(raw.feed)
      ? raw.feed
      : isRecord(raw.recommended)
        ? raw.recommended
        : {}
  const watch = isRecord(raw.watch)
    ? raw.watch
    : isRecord(raw.viewed)
      ? raw.viewed
      : isRecord(raw.watchInfo)
        ? raw.watchInfo
        : {}
  return {
    ...raw,
    id,
    recommendation,
    watch,
  }
}

/** Accepts `{ videos: { id: item } }`, `{ videos: [item] }`, or a bare map. */
export function normalizeVideoLibrary(input) {
  if (!isRecord(input)) throw new Error('视频库根节点必须是 JSON 对象')
  const source = input.videos ?? input.items ?? input
  const videos = {}
  if (Array.isArray(source)) {
    for (const raw of source) {
      const item = normalizeItem(raw)
      if (videos[item.id]) throw new Error(`视频 id 重复：${item.id}`)
      videos[item.id] = item
    }
  } else if (isRecord(source)) {
    for (const [key, raw] of Object.entries(source)) {
      if (key === 'schemaVersion' || key === 'name' || key === 'description') continue
      if (!isRecord(raw)) continue
      const item = normalizeItem(raw, videoId(key))
      if (videos[item.id]) throw new Error(`视频 id 重复：${item.id}`)
      videos[item.id] = item
    }
  } else {
    throw new Error('视频库必须包含 videos 对象或数组')
  }
  if (Object.keys(videos).length === 0) throw new Error('视频库为空')
  return {
    schemaVersion: 1,
    name: typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '',
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 2000) : '',
    videos,
  }
}

export function loadVideoLibrary(file) {
  return normalizeVideoLibrary(readJsonStrict(file))
}

export function lookupVideo(library, id) {
  const key = videoId(id)
  if (!key) throw new Error('缺少视频 id')
  const found = library?.videos?.[key]
  if (!found) throw new Error(`视频库中找不到 id：${key}`)
  return found
}

/**
 * Resolve a trajectory entry against the library.
 *
 * - "some.video_id"                  -> library item as-is
 * - { id: "some.video_id" }          -> library item
 * - { id: "...", watch: {...} }      -> deep override on the library item
 * - { recommendation: {...}, ... }   -> fully inline non-model material
 */
export function resolveVideoEntry(library, entry, { fallbackId = '' } = {}) {
  if (typeof entry === 'string') return lookupVideo(library, entry)
  if (!isRecord(entry)) throw new Error(`轨迹视频条目必须是字符串或对象：${fallbackId}`)
  const reference = videoId(entry.videoId) || videoId(entry.id)
  if (reference) {
    const base = lookupVideo(library, reference)
    const overrides = isRecord(entry.overrides) ? entry.overrides : {}
    return mergeDeep(mergeDeep(base, entry), overrides)
  }
  const inline = normalizeItem({ ...entry, id: videoId(entry.id) || fallbackId || 'inline-video' })
  if (Object.keys(inline.recommendation).length === 0 && Object.keys(inline.watch).length === 0) {
    throw new Error(`内联视频 ${inline.id} 至少需要 recommendation 或 watch`)
  }
  return inline
}
