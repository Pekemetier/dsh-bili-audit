/**
 * Local video library with reusable perturbation variants.
 *
 * A base video owns the shared recommendation/watch material. Each entry in
 * `perturbations` is a sparse patch on that base. Resolution expands patches to
 * concrete ids such as `why_food_eat.less_star`, while only the base content is
 * stored once. Legacy flat id-keyed videos remain supported.
 */
import { readJsonStrict } from './util.js'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function cleanVideoId(value) {
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
  const id = cleanVideoId(raw.id) || fallbackId
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

function expansionFor(raw, keyOrId) {
  if (!isRecord(raw)) throw new Error(`视频 ${keyOrId || '(缺少 id)'} 必须是对象`)
  const baseId = cleanVideoId(keyOrId) || cleanVideoId(raw.id)
  if (!baseId) throw new Error('视频库中存在缺少 id 的条目')
  const hasPerturbations = Object.hasOwn(raw, 'perturbations')
  if (!hasPerturbations) return [normalizeItem({ ...raw, id: baseId }, baseId)]

  const { perturbations, ...baseRaw } = raw
  if (!isRecord(perturbations)) throw new Error(`视频 ${baseId} 的 perturbations 必须是对象`)
  const base = normalizeItem({ ...baseRaw, id: baseId }, baseId)
  base.lineage = { baseId, perturbationId: '' }
  const items = [base]
  for (const [name, patch] of Object.entries(perturbations)) {
    const perturbationId = cleanVideoId(name)
    if (!perturbationId) throw new Error(`视频 ${baseId} 中存在空扰动代号`)
    if (!isRecord(patch)) throw new Error(`视频 ${baseId} 的扰动 ${perturbationId} 必须是对象`)
    if (Object.hasOwn(patch, 'perturbations')) {
      throw new Error(`视频 ${baseId} 的扰动 ${perturbationId} 不允许再嵌套 perturbations`)
    }
    const effectiveId = `${baseId}.${perturbationId}`
    const item = normalizeItem({ ...mergeDeep(baseRaw, patch), id: effectiveId }, effectiveId)
    item.lineage = { baseId, perturbationId }
    items.push(item)
  }
  return items
}

/** Accepts `{ videos: { id: item } }`, `{ videos: [item] }`, or a bare map. */
export function normalizeVideoLibrary(input) {
  if (!isRecord(input)) throw new Error('视频库根节点必须是 JSON 对象')
  const source = input.videos ?? input.items ?? input
  const videos = {}
  const add = (item) => {
    if (videos[item.id]) throw new Error(`视频 id 重复：${item.id}`)
    videos[item.id] = item
  }
  if (Array.isArray(source)) {
    for (const raw of source) {
      for (const item of expansionFor(raw, cleanVideoId(raw?.id))) add(item)
    }
  } else if (isRecord(source)) {
    for (const [key, raw] of Object.entries(source)) {
      if (key === 'schemaVersion' || key === 'name' || key === 'description') continue
      if (!isRecord(raw)) continue
      for (const item of expansionFor(raw, cleanVideoId(key))) add(item)
    }
  } else {
    throw new Error('视频库必须包含 videos 对象或数组')
  }
  if (Object.keys(videos).length === 0) throw new Error('视频库为空')
  return {
    schemaVersion: 2,
    name: typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '',
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 2000) : '',
    videos,
  }
}

export function loadVideoLibrary(file) {
  return normalizeVideoLibrary(readJsonStrict(file))
}

export function lookupVideo(library, id) {
  const key = cleanVideoId(id)
  if (!key) throw new Error('缺少视频 id')
  const found = library?.videos?.[key]
  if (!found) throw new Error(`视频库中找不到 id：${key}`)
  return found
}

/**
 * Resolve a trajectory entry against the library.
 *
 * - "some.video_id"                  -> expanded library item as-is
 * - { id: "some.video_id" }          -> library item
 * - { id: "...", watch: {...} }      -> deep override on the library item
 * - { recommendation: {...}, ... }   -> fully inline non-model material
 */
export function resolveVideoEntry(library, entry, { fallbackId = '' } = {}) {
  if (typeof entry === 'string') return lookupVideo(library, entry)
  if (!isRecord(entry)) throw new Error(`轨迹视频条目必须是字符串或对象：${fallbackId}`)
  const reference = cleanVideoId(entry.videoId) || cleanVideoId(entry.id)
  if (reference) {
    const base = lookupVideo(library, reference)
    const overrides = isRecord(entry.overrides) ? entry.overrides : {}
    const resolved = mergeDeep(mergeDeep(base, entry), overrides)
    resolved.id = base.id
    return resolved
  }
  const inline = normalizeItem({ ...entry, id: cleanVideoId(entry.id) || fallbackId || 'inline-video' })
  if (Object.keys(inline.recommendation).length === 0 && Object.keys(inline.watch).length === 0) {
    throw new Error(`内联视频 ${inline.id} 至少需要 recommendation 或 watch`)
  }
  return inline
}
