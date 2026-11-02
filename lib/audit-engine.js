/**
 * Deterministic local replay engine.
 *
 * The cursor advances only when `next` (or the run alias) is called. It never
 * consults model wording, selected ids, preferences, or previous output. That is
 * the invariant that makes every future batch fixed.
 */
import { isAbsolute, resolve } from 'node:path'
import {
  appendEvent,
  appendSelection,
  loadConfig,
  loadState,
  saveState,
} from './store.js'
import { loadVideoLibrary, lookupVideo } from './video-library.js'
import { loadReplyLibrary } from './reply-library.js'
import {
  lookupTrajectoryVideo,
  resolveBatch,
  resolveLayeredTrajectory,
  trajectoryKey,
  validateBatchSelection,
} from './trajectory.js'
import { clampText, randomId, readJsonStrict } from './util.js'

export function resolveDataPath(home, configuredPath) {
  return isAbsolute(configuredPath) ? configuredPath : resolve(home, configuredPath)
}

export function loadAuditInputs({ home, config = loadConfig(home) }) {
  const libraryFile = resolveDataPath(home, config.libraryPath)
  const replyLibraryFile = resolveDataPath(home, config.replyLibraryPath)
  const baseTrajectoryFile = resolveDataPath(home, config.baseTrajectoryPath)
  const perturbationTrajectoryFile = resolveDataPath(home, config.perturbationTrajectoryPath)
  const library = loadVideoLibrary(libraryFile)
  const replyLibrary = loadReplyLibrary(replyLibraryFile)
  const baseTrajectoryDocument = readJsonStrict(baseTrajectoryFile)
  const perturbationTrajectoryDocument = readJsonStrict(perturbationTrajectoryFile)
  const trajectory = resolveLayeredTrajectory({
    baseDocument: baseTrajectoryDocument,
    perturbationDocument: perturbationTrajectoryDocument,
    baseTrajectoryId: config.baseTrajectoryId,
    perturbationTrajectoryId: config.perturbationTrajectoryId,
  })
  // Validate every non-model reference now. A saved database that points at a
  // missing video or reply must fail during the save request, not midway
  // through an audit replay.
  for (let index = 0; index < trajectory.batches.length; index += 1) {
    resolveBatch(library, trajectory, index, replyLibrary)
  }
  return {
    config,
    library,
    replyLibrary,
    trajectory,
    documents: {
      library: readJsonStrict(libraryFile),
      replies: readJsonStrict(replyLibraryFile),
      baseTrajectory: baseTrajectoryDocument,
      perturbationTrajectory: perturbationTrajectoryDocument,
    },
    files: {
      library: libraryFile,
      replyLibrary: replyLibraryFile,
      baseTrajectory: baseTrajectoryFile,
      perturbationTrajectory: perturbationTrajectoryFile,
    },
    key: trajectoryKey(trajectory),
  }
}

export function createAuditEngine({ home, config = loadConfig(home), log = () => {} }) {
  const loaded = loadAuditInputs({ home, config })
  const { library, replyLibrary, trajectory, key } = loaded
  const state = loadState(home)

  const cursor = () => {
    const value = Number(state.cursors[key])
    return Number.isInteger(value) && value >= 0 ? Math.min(value, trajectory.batches.length) : 0
  }

  const persist = () => saveState(home, state)

  function status() {
    const nextIndex = cursor()
    const activeEvents = state.events.filter((event) => event.trajectoryKey === key)
    const activeSelections = state.selections.filter((selection) => selection.trajectoryKey === key)
    return {
      ok: true,
      trajectory: {
        id: trajectory.id,
        name: trajectory.name,
        source: trajectory.source,
        baseId: trajectory.baseId,
        perturbationId: trajectory.perturbationId,
        fingerprint: key,
        batches: trajectory.batches.length,
        cursor: nextIndex,
        remaining: Math.max(0, trajectory.batches.length - nextIndex),
        nextBatchId: trajectory.batches[nextIndex]?.id || '',
        exhausted: nextIndex >= trajectory.batches.length,
      },
      library: {
        videos: Object.keys(library.videos).length,
        replies: Object.keys(replyLibrary.replies).length,
        file: loaded.files.library,
      },
      files: loaded.files,
      recentEvents: activeEvents.slice(0, 20),
      recentSelections: activeSelections.slice(0, 10),
    }
  }

  function peek() {
    const index = cursor()
    const batch = resolveBatch(library, trajectory, index, replyLibrary)
    if (!batch) {
      return {
        ok: false,
        exhausted: true,
        trajectory: status().trajectory,
        error: '轨迹已经播放完；请重置游标或加载新的轨迹。',
      }
    }
    return {
      ok: true,
      action: 'preview',
      batch,
      note: 'preview 只查看游标指向的固定批次，不推进、不记录选择；选择必须在 next/run 返回批次之后提交。',
    }
  }

  function next({ source = 'recommend', message = '' } = {}) {
    const index = cursor()
    const batch = resolveBatch(library, trajectory, index, replyLibrary)
    if (!batch) {
      return {
        ok: false,
        exhausted: true,
        trajectory: status().trajectory,
        error: '轨迹已经播放完；请重置游标或加载新的轨迹。',
      }
    }
    state.cursors[key] = index + 1
    appendEvent(state, {
      id: randomId('next'),
      type: source === 'run' ? 'run' : 'next',
      at: new Date().toISOString(),
      trajectoryKey: key,
      trajectoryId: trajectory.id,
      batchId: batch.id,
      batchIndex: index,
      source: clampText(source, 40, 'recommend'),
      // Recorded for audit only. It is never used to choose the next batch.
      message: clampText(message, 2000, ''),
    })
    persist()
    const nextIndex = cursor()
    log(`固定批次 ${index + 1}/${trajectory.batches.length} 已返回（${batch.id}）`)
    return {
      ok: true,
      action: source === 'run' ? 'run' : 'next',
      deterministic: true,
      batch,
      next: {
        cursor: nextIndex,
        remaining: Math.max(0, trajectory.batches.length - nextIndex),
        exhausted: nextIndex >= trajectory.batches.length,
      },
      selectionTool: {
        tool: 'bili_fav_recommend',
        action: 'select',
        batchId: batch.id,
        argumentShape: [{ videoId: batch.videos[0]?.id || '<batch video id>', reason: '可选理由' }],
      },
      note: '下一批内容只由轨迹游标决定；message 仅记录为审计元数据，不影响后续批次。',
    }
  }

  function lookup(id) {
    const video = lookupTrajectoryVideo(library, id)
    return { ok: true, action: 'lookup', video }
  }

  function select({ batchId, selected }) {
    const batchIdText = clampText(batchId, 200, '')
    if (!batchIdText) throw new Error('缺少 batchId')
    const checked = validateBatchSelection(library, trajectory, batchIdText, selected, {
      maxBatchIndex: cursor(),
    })
    const record = {
      id: randomId('selection'),
      at: new Date().toISOString(),
      trajectoryKey: key,
      trajectoryId: trajectory.id,
      batchId: checked.batch.id,
      batchIndex: checked.batch.index,
      selected: checked.selected,
    }
    appendSelection(state, record)
    const batchCursor = cursor()
    appendEvent(state, {
      id: randomId('select'),
      type: 'select',
      at: record.at,
      trajectoryKey: key,
      trajectoryId: trajectory.id,
      batchId: checked.batch.id,
      batchIndex: checked.batch.index,
      source: 'recommend',
      message: JSON.stringify(checked.selected).slice(0, 2000),
    })
    persist()
    log(`记录选择：${checked.selected.length} 条（${checked.batch.id}），游标不变（${batchCursor}）`)
    return {
      ok: true,
      action: 'select',
      batchId: checked.batch.id,
      selected: checked.selected,
      cursor: batchCursor,
      note: '选择不会推进轨迹；只有下一次 next/run 才会返回固定下一批。',
    }
  }

  function reset({ scope = 'active' } = {}) {
    if (scope === 'all') {
      state.cursors = {}
      state.events = []
      state.selections = []
    } else {
      delete state.cursors[key]
      state.events = state.events.filter((event) => event.trajectoryKey !== key)
      state.selections = state.selections.filter((selection) => selection.trajectoryKey !== key)
    }
    persist()
    return { ok: true, reset: scope, trajectory: status().trajectory }
  }

  return {
    config: loaded.config,
    files: loaded.files,
    documents: loaded.documents,
    library,
    replyLibrary,
    trajectory,
    status,
    peek,
    next,
    lookup,
    select,
    reset,
    lookupLibrary: lookupVideo,
  }
}

/** Convenience for tests and CLI-style callers. */
export function loadLibraryItem({ home, id, config = loadConfig(home) }) {
  const loaded = loadAuditInputs({ home, config })
  return lookupVideo(loaded.library, id)
}
