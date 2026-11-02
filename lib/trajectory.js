/**
 * Fixed custom trajectories and trajectory databases.
 *
 * A trajectory is an ordered list of batches. Each batch can contain video ids
 * from the local library, id references with local overrides, or fully inline
 * non-model material. Batch order is the sole source of future feed contents.
 */
import { createHash } from 'node:crypto'
import { readJsonStrict } from './util.js'
import { lookupVideo, resolveVideoEntry } from './video-library.js'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

/** List ids when the document is a trajectory database, otherwise `['default']`. */
export function listTrajectoryIds(input) {
  if (!isRecord(input) || !isRecord(input.trajectories)) return ['default']
  return Object.keys(input.trajectories).slice(0, 100)
}

/** Select one trajectory from either a single trajectory or a database document. */
export function selectTrajectory(input, requestedId = '') {
  if (!isRecord(input)) throw new Error('轨迹根节点必须是 JSON 对象')
  let id = cleanId(input.id) || 'default'
  let raw = input
  if (isRecord(input.trajectories)) {
    const ids = Object.keys(input.trajectories)
    if (ids.length === 0) throw new Error('轨迹数据库为空')
    id = cleanId(requestedId) || cleanId(input.activeTrajectory) || ids[0]
    if (!Object.hasOwn(input.trajectories, id)) throw new Error(`轨迹数据库中找不到 id：${id}`)
    raw = input.trajectories[id]
  }
  if (!isRecord(raw)) throw new Error(`轨迹 ${id} 必须是对象`)
  const rawBatches = Array.isArray(raw.batches) ? raw.batches : Array.isArray(input.batches) ? input.batches : null
  if (!rawBatches || rawBatches.length === 0) throw new Error(`轨迹 ${id} 缺少非空 batches 数组`)
  const batches = rawBatches.map((batch, index) => {
    if (Array.isArray(batch)) return { id: `batch-${index + 1}`, videos: batch }
    if (!isRecord(batch)) throw new Error(`轨迹 ${id} 的第 ${index + 1} 批必须是数组或对象`)
    const videos = batch.videos ?? batch.ids ?? batch.items
    if (!Array.isArray(videos)) throw new Error(`轨迹 ${id} 的第 ${index + 1} 批缺少 videos 数组`)
    return {
      ...batch,
      id: cleanId(batch.id) || `batch-${index + 1}`,
      videos,
    }
  })
  const seen = new Set()
  for (const batch of batches) {
    if (seen.has(batch.id)) throw new Error(`轨迹 ${id} 的批次 id 重复：${batch.id}`)
    seen.add(batch.id)
  }
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : id,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 4000) : '',
    metadata: isRecord(raw.metadata) ? raw.metadata : {},
    batches,
  }
}

export function loadTrajectory(file, trajectoryId = '') {
  return selectTrajectory(readJsonStrict(file), trajectoryId)
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  )
}

export function trajectoryFingerprint(trajectory) {
  const canonical = JSON.stringify(canonicalValue({ id: trajectory.id, batches: trajectory.batches }))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export function trajectoryKey(trajectory) {
  return `traj_${trajectoryFingerprint(trajectory)}`
}

/** Resolve all non-model material for a batch at replay time. */
export function resolveBatch(library, trajectory, index) {
  const batch = trajectory.batches[index]
  if (!batch) return null
  const videos = batch.videos.map((entry, itemIndex) => {
    const fallbackId = `inline-${batch.id}-${itemIndex + 1}`
    return resolveVideoEntry(library, entry, { fallbackId })
  })
  return {
    id: batch.id,
    index,
    total: trajectory.batches.length,
    metadata: batch.metadata && isRecord(batch.metadata) ? batch.metadata : {},
    videos,
  }
}

/**
 * Validate that a model-selected id belongs to a batch that has already been
 * returned. `maxBatchIndex` is normally the replay cursor: batch 0 is selectable
 * only after `next` has advanced the cursor to 1.
 */
export function validateBatchSelection(
  library,
  trajectory,
  batchId,
  selected,
  { maxBatchIndex = Number.POSITIVE_INFINITY } = {},
) {
  const batchIndex = trajectory.batches.findIndex((batch) => batch.id === batchId)
  if (batchIndex < 0) throw new Error(`当前轨迹中找不到批次：${batchId}`)
  if (batchIndex >= maxBatchIndex) throw new Error(`批次 ${batchId} 尚未通过 bili_fav_recommend 返回，不能提前选择`)
  const batch = resolveBatch(library, trajectory, batchIndex)
  const allowed = new Map(batch.videos.map((video) => [video.id, video]))
  if (!Array.isArray(selected)) throw new Error('selected 必须是数组；不选任何视频时请显式传 []')
  const normalized = []
  const seen = new Set()
  for (const item of selected) {
    const id = cleanId(typeof item === 'string' ? item : item?.videoId ?? item?.id)
    if (!id) throw new Error('selected 中存在缺少 videoId 的条目')
    if (!allowed.has(id)) throw new Error(`视频 ${id} 不在批次 ${batchId} 中`)
    if (seen.has(id)) throw new Error(`视频 ${id} 在 selected 中重复`)
    seen.add(id)
    normalized.push({
      videoId: id,
      reason: typeof item === 'object' ? String(item.reason || '').trim().slice(0, 1000) : '',
    })
  }
  return { batch, selected: normalized }
}

export function lookupTrajectoryVideo(library, id) {
  return lookupVideo(library, id)
}
