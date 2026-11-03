/**
 * Fixed custom trajectories and layered trajectory files.
 *
 * Layout:
 *   trajectories/<base-id>/base.json
 *   trajectories/<base-id>/<perturbation-id>.json
 *
 * A base file contains the reusable ordered batches. A perturbation file uses
 * `extends` plus sparse batch patches, so only changed batches are stored.
 * Replies are always inline because they depend on the complete batch context.
 * Batch order remains the sole source of future feed contents.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { listJsonFiles, readJsonStrict, safeFileId } from './util.js'
import { lookupVideo, mergeDeep, resolveVideoEntry } from './video-library.js'

export const BASE_TRAJECTORY_FILE = 'base'

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

function normalizeReply(entry, batchId, index) {
  const fallbackId = `${batchId}-reply-${index + 1}`
  if (typeof entry === 'string') {
    const text = entry.trim()
    if (!text) throw new Error(`批次 ${batchId} 的第 ${index + 1} 条回复不能为空`)
    return { id: fallbackId, role: 'assistant', text }
  }
  if (!isRecord(entry)) throw new Error(`批次 ${batchId} 的第 ${index + 1} 条回复必须是字符串或对象`)
  const text = typeof entry.text === 'string'
    ? entry.text
    : typeof entry.content === 'string'
      ? entry.content
      : ''
  return {
    ...entry,
    id: cleanId(entry.id) || fallbackId,
    role: cleanId(entry.role) || 'assistant',
    text,
  }
}

function normalizeBatch(batch, index, trajectoryId) {
  if (Array.isArray(batch)) return { id: `batch-${index + 1}`, videos: batch, replies: [] }
  if (!isRecord(batch)) throw new Error(`轨迹 ${trajectoryId} 的第 ${index + 1} 批必须是数组或对象`)
  const videos = batch.videos ?? batch.ids ?? batch.items
  if (!Array.isArray(videos)) throw new Error(`轨迹 ${trajectoryId} 的第 ${index + 1} 批缺少 videos 数组`)
  const id = cleanId(batch.id) || `batch-${index + 1}`
  return {
    ...batch,
    id,
    videos,
    replies: arrayOrSingleton(batch.replies).map((entry, replyIndex) => normalizeReply(entry, id, replyIndex)),
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

/** Validate and select one single-trajectory document. */
export function selectTrajectory(input, requestedId = '') {
  if (!isRecord(input)) throw new Error('轨迹根节点必须是 JSON 对象')
  if (Object.hasOwn(input, 'trajectories')) {
    throw new Error('轨迹必须是单文件；不能包含 trajectories 集合')
  }
  const documentId = cleanId(input.id)
  const id = cleanId(requestedId) || documentId || 'default'
  if (documentId && documentId !== id) {
    throw new Error(`轨迹 id 不一致：请求 ${id}，文档 ${documentId}`)
  }
  const rawBatches = Array.isArray(input.batches) ? input.batches : null
  return {
    id,
    name: typeof input.name === 'string' ? input.name.trim().slice(0, 200) : id,
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 4000) : '',
    metadata: isRecord(input.metadata) ? input.metadata : {},
    batches: normalizeBatches(rawBatches, id),
    source: 'base',
    baseId: id,
    perturbationId: '',
  }
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
  const offset = batches.length
  for (const [index, batch] of additions.entries()) {
    batches.push(normalizeBatch(batch, offset + index, perturbationId))
  }
  const seen = new Set()
  for (const batch of batches) {
    if (seen.has(batch.id)) throw new Error(`扰动轨迹 ${perturbationId} 产生重复批次 id：${batch.id}`)
    seen.add(batch.id)
  }
  if (batches.length === 0) throw new Error(`扰动轨迹 ${perturbationId} 不能删除所有批次`)
  return batches
}

export function resolveLayeredTrajectory({
  baseDocument,
  perturbationDocument = null,
  baseTrajectoryId = '',
  perturbationTrajectoryId = '',
}) {
  let base = selectTrajectory(baseDocument, baseTrajectoryId)
  const perturbationId = cleanId(perturbationTrajectoryId)
  if (!perturbationId) return base
  if (!isRecord(perturbationDocument)) throw new Error('扰动轨迹根节点必须是 JSON 对象')

  if (Object.hasOwn(perturbationDocument, 'trajectories')) {
    throw new Error('扰动轨迹必须是单文件；不能包含 trajectories 集合')
  }
  const raw = perturbationDocument
  if (!isRecord(raw)) throw new Error(`扰动轨迹 ${perturbationId} 必须是对象`)
  if (cleanId(raw.id) && cleanId(raw.id) !== perturbationId) {
    throw new Error(`扰动轨迹 id 不一致：请求 ${perturbationId}，文档 ${cleanId(raw.id)}`)
  }

  const inheritedId = cleanId(raw.extends)
  if (!inheritedId) throw new Error(`扰动轨迹 ${perturbationId} 必须通过 extends 指向 base 轨迹`)
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

export function trajectoryFilePath(directory, baseId, trajectoryId = BASE_TRAJECTORY_FILE) {
  const safeBaseId = safeFileId(baseId, 'base 轨迹 id')
  const safeTrajectoryId = safeFileId(trajectoryId, '轨迹 id')
  return join(directory, safeBaseId, `${safeTrajectoryId}.json`)
}

export function normalizeBaseTrajectoryFile(input, expectedId = '') {
  if (!isRecord(input)) throw new Error('base 轨迹文件根节点必须是 JSON 对象')
  if (Object.hasOwn(input, 'trajectories')) {
    throw new Error('base 轨迹文件不能包含 trajectories 集合；每个 base 必须单独存放')
  }
  const expected = expectedId ? safeFileId(expectedId, 'base 轨迹目录名') : ''
  const id = cleanId(input.id) || expected
  if (!id) throw new Error('base 轨迹文件缺少 id')
  if (expected && id !== expected) {
    throw new Error(`base 轨迹 id 与目录名不一致：目录 ${expected}，文档 id ${id}`)
  }
  const document = { ...input, schemaVersion: 3, id }
  const trajectory = selectTrajectory(document, id)
  return { id, document, trajectory }
}

export function normalizePerturbationTrajectoryFile(input, { baseId, expectedId = '' } = {}) {
  if (!isRecord(input)) throw new Error('扰动轨迹文件根节点必须是 JSON 对象')
  if (Object.hasOwn(input, 'trajectories')) {
    throw new Error('扰动轨迹文件不能包含 trajectories 集合；每个扰动必须单独存放')
  }
  const expectedBase = safeFileId(baseId, 'base 轨迹 id')
  const expected = expectedId ? safeFileId(expectedId, '扰动轨迹文件名') : ''
  const id = cleanId(input.id) || expected
  if (!id) throw new Error('扰动轨迹文件缺少 id')
  if (id.toLowerCase() === BASE_TRAJECTORY_FILE.toLowerCase()) {
    throw new Error(`扰动轨迹 id 不能是保留名称 ${BASE_TRAJECTORY_FILE}`)
  }
  if (expected && id !== expected) {
    throw new Error(`扰动轨迹 id 与文件名不一致：文件 ${expected}.json，文档 id ${id}`)
  }
  const extendsId = cleanId(input.extends)
  if (extendsId && extendsId !== expectedBase) {
    throw new Error(`扰动轨迹 ${id} 的 extends 必须指向所在目录的 base：${expectedBase}`)
  }
  const document = { ...input, schemaVersion: 3, id, extends: expectedBase }
  return { id, document }
}

export function listTrajectoryCatalog(directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`轨迹目录不存在：${directory}`)
    throw new Error(`无法读取轨迹目录 ${directory}：${error?.message ?? error}`)
  }
  const baseIds = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => safeFileId(entry.name, 'base 轨迹目录名'))
    .sort((a, b) => a.localeCompare(b))
  if (baseIds.length === 0) throw new Error(`轨迹目录中没有 base 轨迹子文件夹：${directory}`)

  const seen = new Set()
  return baseIds.map((baseId) => {
    const caseKey = baseId.toLowerCase()
    if (seen.has(caseKey)) throw new Error(`轨迹目录大小写冲突：${baseId}`)
    seen.add(caseKey)
    const baseFile = trajectoryFilePath(directory, baseId)
    if (!existsSync(baseFile)) throw new Error(`base 轨迹缺少 ${baseId}/base.json`)
    normalizeBaseTrajectoryFile(readJsonStrict(baseFile), baseId)
    const perturbationIds = listJsonFiles(join(directory, baseId))
      .filter((name) => name !== `${BASE_TRAJECTORY_FILE}.json`)
      .map((name) => {
        const id = safeFileId(name.slice(0, -'.json'.length), '扰动轨迹文件名')
        const file = trajectoryFilePath(directory, baseId, id)
        normalizePerturbationTrajectoryFile(readJsonStrict(file), { baseId, expectedId: id })
        return id
      })
    return {
      baseId,
      baseFile,
      directory: join(directory, baseId),
      perturbationIds,
    }
  })
}

export function loadTrajectorySelection({
  directory,
  baseTrajectoryId = '',
  perturbationTrajectoryId = '',
}) {
  const catalog = listTrajectoryCatalog(directory)
  const requestedBaseId = cleanId(baseTrajectoryId)
  const selectedBaseId = requestedBaseId || catalog[0].baseId
  const baseEntry = catalog.find((entry) => entry.baseId === selectedBaseId)
  if (!baseEntry) throw new Error(`轨迹目录中找不到 base 轨迹：${selectedBaseId}`)
  const baseDocument = readJsonStrict(baseEntry.baseFile)
  normalizeBaseTrajectoryFile(baseDocument, selectedBaseId)

  const perturbationId = cleanId(perturbationTrajectoryId)
  if (!perturbationId) {
    return {
      catalog,
      baseId: selectedBaseId,
      perturbationId: '',
      baseDocument,
      perturbationDocument: null,
      baseFile: baseEntry.baseFile,
      perturbationFile: '',
      trajectory: resolveLayeredTrajectory({ baseDocument, baseTrajectoryId: selectedBaseId }),
    }
  }
  if (!baseEntry.perturbationIds.includes(perturbationId)) {
    throw new Error(`base 轨迹 ${selectedBaseId} 中找不到扰动轨迹：${perturbationId}`)
  }
  const perturbationFile = trajectoryFilePath(directory, selectedBaseId, perturbationId)
  const perturbationDocument = readJsonStrict(perturbationFile)
  normalizePerturbationTrajectoryFile(perturbationDocument, {
    baseId: selectedBaseId,
    expectedId: perturbationId,
  })
  return {
    catalog,
    baseId: selectedBaseId,
    perturbationId,
    baseDocument,
    perturbationDocument,
    baseFile: baseEntry.baseFile,
    perturbationFile,
    trajectory: resolveLayeredTrajectory({
      baseDocument,
      perturbationDocument,
      baseTrajectoryId: selectedBaseId,
      perturbationTrajectoryId: perturbationId,
    }),
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
    replies: batch.replies,
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
