/**
 * Durable audit configuration and replay state.
 *
 * On-disk data is directory based: one file per base video (including its
 * sparse perturbations), and one file per base or perturbation trajectory.
 * Cursors are keyed by the final resolved trajectory fingerprint.
 */
import { join } from 'node:path'
import { clampInt, clampText, readJson, writeJson } from './util.js'

export const TOOL_MODES = Object.freeze(['recommend-only', 'all'])

export const DEFAULT_CONFIG = Object.freeze({
  /** recommend-only exposes one tool; all also exposes preview/run/status. */
  toolMode: 'recommend-only',
  /** Relative directories are resolved against the plugin home. */
  videoDirectory: 'videos',
  trajectoryDirectory: 'trajectories',
  /** Empty base id selects the first base trajectory folder. */
  baseTrajectoryId: '',
  /** Empty means replay the base trajectory without a perturbation overlay. */
  perturbationTrajectoryId: '',
})

const CONFIG_FILE = 'config.json'
const STATE_FILE = 'state.json'

export function paths(home) {
  return {
    home,
    config: join(home, CONFIG_FILE),
    state: join(home, STATE_FILE),
    log: join(home, 'bili-audit.log'),
    videos: join(home, DEFAULT_CONFIG.videoDirectory),
    trajectories: join(home, DEFAULT_CONFIG.trajectoryDirectory),
  }
}

export function sanitizeConfig(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const toolMode = TOOL_MODES.includes(raw.toolMode) ? raw.toolMode : DEFAULT_CONFIG.toolMode
  return {
    toolMode,
    videoDirectory: clampText(raw.videoDirectory, 500, DEFAULT_CONFIG.videoDirectory),
    trajectoryDirectory: clampText(raw.trajectoryDirectory, 500, DEFAULT_CONFIG.trajectoryDirectory),
    baseTrajectoryId: clampText(raw.baseTrajectoryId, 200, DEFAULT_CONFIG.baseTrajectoryId),
    perturbationTrajectoryId: clampText(
      raw.perturbationTrajectoryId,
      200,
      DEFAULT_CONFIG.perturbationTrajectoryId,
    ),
  }
}

export function loadConfig(home) {
  return sanitizeConfig(readJson(paths(home).config, DEFAULT_CONFIG))
}

export function saveConfig(home, patch = {}) {
  const current = loadConfig(home)
  const next = sanitizeConfig({ ...current, ...patch })
  writeJson(paths(home).config, next)
  return next
}

export function emptyState() {
  return {
    version: 4,
    cursors: {},
    events: [],
    selections: [],
  }
}

function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    id: clampText(raw.id, 80, ''),
    type: ['next', 'select', 'run'].includes(raw.type) ? raw.type : 'next',
    at: clampText(raw.at, 40, ''),
    trajectoryKey: clampText(raw.trajectoryKey, 80, ''),
    trajectoryId: clampText(raw.trajectoryId, 200, ''),
    batchId: clampText(raw.batchId, 200, ''),
    batchIndex: clampInt(raw.batchIndex, 0, 1_000_000, 0),
    source: clampText(raw.source, 40, ''),
    message: clampText(raw.message, 2000, ''),
  }
}

function sanitizeSelection(raw) {
  if (!raw || typeof raw !== 'object') return null
  const selected = Array.isArray(raw.selected)
    ? raw.selected.slice(0, 100).map((item) => {
        if (typeof item === 'string') return { videoId: clampText(item, 200, ''), reason: '' }
        return {
          videoId: clampText(item?.videoId ?? item?.id, 200, ''),
          reason: clampText(item?.reason, 1000, ''),
        }
      }).filter((item) => item.videoId)
    : []
  return {
    id: clampText(raw.id, 80, ''),
    at: clampText(raw.at, 40, ''),
    trajectoryKey: clampText(raw.trajectoryKey, 80, ''),
    trajectoryId: clampText(raw.trajectoryId, 200, ''),
    batchId: clampText(raw.batchId, 200, ''),
    batchIndex: clampInt(raw.batchIndex, 0, 1_000_000, 0),
    selected,
  }
}

export function loadState(home) {
  const stored = readJson(paths(home).state, null)
  if (!stored || typeof stored !== 'object') return emptyState()
  const state = emptyState()
  if (stored.cursors && typeof stored.cursors === 'object') {
    for (const [key, value] of Object.entries(stored.cursors).slice(0, 100)) {
      if (/^[A-Za-z0-9_-]{1,80}$/.test(key)) state.cursors[key] = clampInt(value, 0, 1_000_000, 0)
    }
  }
  if (Array.isArray(stored.events)) {
    state.events = stored.events.map(sanitizeEvent).filter(Boolean).slice(0, 200)
  }
  if (Array.isArray(stored.selections)) {
    state.selections = stored.selections.map(sanitizeSelection).filter(Boolean).slice(0, 100)
  }
  return state
}

export function saveState(home, state) {
  state.version = 4
  state.events = (state.events || []).slice(0, 200)
  state.selections = (state.selections || []).slice(0, 100)
  state.cursors = Object.fromEntries(Object.entries(state.cursors || {}).slice(0, 100))
  writeJson(paths(home).state, state)
}

export function appendEvent(state, event) {
  state.events.unshift(event)
  state.events = state.events.slice(0, 200)
}

export function appendSelection(state, selection) {
  state.selections.unshift(selection)
  state.selections = state.selections.slice(0, 100)
}
