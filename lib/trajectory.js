/**
 * Fixed custom trajectories and layered trajectory databases.
 *
 * base documents contain the reusable ordered batches. Perturbation entries use
 * `extends` plus sparse batch patches, so only changed batches are recorded.
 * Batch order remains the sole source of future feed contents.
 */
import { createHash } from 'node:crypto'
import { readJsonStrict } from './util.js'
import { lookupVideo, mergeDeep, resolveVideoEntry } from './video-library.js'
import { resolveReplyEntry } from './reply-library.js'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

function arrayOrSingleton(value) {
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function normalizeBatch(batch, index, trajectoryId) {
  if (Array.isArray(batch)) return { id: `batch-${index + 1}`, videos: batch, replies: [] }
  if (!isRecord(batch)) throw new Error(`轨迹 ${trajectoryId} 的第 ${index + 1} 批必须是数组或对象`)
  const videos = batch.videos ?? batch.ids ?? batch.items
  if (!Array.isArray(videos)) throw new Error(`轨迹 ${trajectoryId} 的第 ${index + 1} 批缺少 videos 数组`)
  return {
    ...batch,
    id: cleanId(batch.id) || `batch-${index + 1}`,
    videos,
    replies: arrayOrSingleton(batch.replies ?? batch.replyIds),
  }
}

function normalizeBatches(rawBatches, trajectoryId) {
  if (!Array.isArray(rawBatches) || rawBatches.length === 0) {
    throw new Error(`轨迹 ${trajectoryId} 缺少非空 batches 数组`)
  }
  const batches = rawBatches.map((batch, index) => normalizeBatch(batch, index, trajectoryId))
  const seen = new Set()
  for (const batch of batches) {
    if (seen.has(batch.id)) throw new Error(`轨迹 ${trajectoryId} 的批次 id 重复：${batch.id}`)
    seen.add(batch.id)
  }
  return batches
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
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : id,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 4000) : '',
    metadata: isRecord(raw.metadata) ? raw.metadata : {},
    batches: normalizeBatches(rawBatches, id),
    source: 'base',
    baseId: id,
    perturbationId: '',
  }
}

export function loadTrajectory(file, trajectoryId = '') {
  return selectTrajectory(readJsonStrict(file), trajectoryId)
}

function applyPerturbation(inherited, raw, perturbationId) {
  let batches = inherited.batches.map((batch) => structuredClone(batch))
  const patches = raw.patches === undefined ? [] : raw.patches
  if (!Array.isArray(patches)) throw new Error(`扰动轨迹 ${perturbationId} 的 patches 必须是数组`)
  for (const [index, patch] of patches.entries()) {
    if (!isRecord(patch)) throw new Error(`扰动轨迹 ${perturbationId} 的第 ${index + 1} 个 patch 必须是对象`)
    const batchId = cleanId(patch.batchId)
    if (!batchId) throw new Error(`扰动轨迹 ${perturbationId} 的 patch 缺少 batchId`)
    const batchIndex = batches.findIndex((batch) => batch.id === batchId)
    if (batchIndex < 0) throw new Error(`扰动轨迹 ${perturbationId} 找不到要修改的批次：${batchId}`)
    if (patch.remove === true) {
      batches.splice(batchIndex, 1)
      continue
    }
    const { batchId: _batchId, remove: _remove, ...changes } = patch
    batches[batchIndex] = normalizeBatch(mergeDeep(batches[batchIndex], changes), batchIndex, perturbationId)
  }
  for (const value of arrayOrSingleton(raw.removeBatches)) {
    const batchId = cleanId(value)
    const index = batches.findIndex((batch) => batch.id === batchId)
    if (index >= 0) batches.splice(index, 1)
  }
  const additions = raw.addBatches === undefined ? [] : raw.addBatches
  if (!Array.isArray(additions)) throw new Error(`扰动轨迹 ${perturbationId} 的 addBatches 必须是数组`)
  for (const batch of additions) batches.push(normalizeBatch(batch, batches.length, perturbationId))
  if (batches.length === 0) throw new Error(`扰动轨迹 ${perturbationId} 没有留下任何批次`)
  const seen = new Set()
  for (const batch of batches) {
    if (seen.has(batch.id)) throw new Error(`扰动轨迹 ${perturbationId} 的批次 id 重复：${batch.id}`)
    seen.add(batch.id)
  }
  return batches
}

/**
 * Resolve the active layered trajectory.
 *
 * `perturbationDocument` may contain either full standalone trajectories or
 * sparse entries with `extends` and `patches`. With no perturbation id, the
 * selected base trajectory is returned unchanged.
 */
export function resolveLayeredTrajectory({
  baseDocument,
  perturbationDocument = null,
  baseTrajectoryId = '',
  perturbationTrajectoryId = '',
}) {
  let base = selectTrajectory(baseDocument, baseTrajectoryId)
  const perturbationId = cleanId(perturbationTrajectoryId)
  if (!perturbationId) return base
  if (!isRecord(perturbationDocument)) throw new Error('扰动轨迹数据库根节点必须是 JSON 对象')

  let raw = null
  if (isRecord(perturbationDocument.trajectories)) {
    if (!Object.hasOwn(perturbationDocument.trajectories, perturbationId)) {
      throw new Error(`扰动轨迹数据库中找不到 id：${perturbationId}`)
    }
    raw = perturbationDocument.trajectories[perturbationId]
  } else if (cleanId(perturbationDocument.id) === perturbationId) {
    raw = perturbationDocument
  } else if (perturbationDocument.id && cleanId(perturbationDocument.id) !== perturbationId) {
    throw new Error(`扰动轨迹数据库中找不到 id：${perturbationId}`)
  } else {
    raw = perturbationDocument
  }
  if (!isRecord(raw)) throw new Error(`扰动轨迹 ${perturbationId} 必须是对象`)

  if (!raw.extends) {
    const standalone = selectTrajectory({ id: perturbationId, ...raw }, perturbationId)
    standalone.source = 'perturbation'
    standalone.perturbationId = perturbationId
    return standalone
  }

  const inheritedId = cleanId(raw.extends)
  if (!inheritedId) throw new Error(`扰动轨迹 ${perturbationId} 的 extends 不能为空`)
  base = selectTrajectory(baseDocument, inheritedId)
  const batches = applyPerturbation(base, raw, perturbationId)
  return {
    id: perturbationId,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 200) : base.name,
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 4000) : base.description,
    metadata: mergeDeep(base.metadata, isRecord(raw.metadata) ? raw.metadata : {}),
    batches,
    source: 'perturbation',
    baseId: base.id,
    perturbationId,
  }
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
export function resolveBatch(library, trajectory, index, replyLibrary = null) {
  const batch = trajectory.batches[index]
  if (!batch) return null
  const videos = batch.videos.map((entry, itemIndex) => {
    const fallbackId = `inline-${batch.id}-${itemIndex + 1}`
    return resolveVideoEntry(library, entry, { fallbackId })
  })
  const replies = replyLibrary
    ? batch.replies.map((entry, replyIndex) =>
        resolveReplyEntry(replyLibrary, entry, { fallbackId: `inline-${batch.id}-reply-${replyIndex + 1}` }),
      )
    : []
  return {
    id: batch.id,
    index,
    total: trajectory.batches.length,
    metadata: batch.metadata && isRecord(batch.metadata) ? batch.metadata : {},
    videos,
    replies,
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
