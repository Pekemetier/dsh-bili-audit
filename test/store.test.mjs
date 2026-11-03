import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_CONFIG,
  emptyState,
  loadConfig,
  loadState,
  paths,
  sanitizeConfig,
  saveConfig,
  saveState,
} from '../lib/store.js'

test('config defaults to directory-backed videos and trajectories', () => {
  assert.deepEqual(sanitizeConfig({}), {
    toolMode: 'recommend-only',
    videoDirectory: 'videos',
    trajectoryDirectory: 'trajectories',
    baseTrajectoryId: '',
    perturbationTrajectoryId: '',
  })
  assert.equal(DEFAULT_CONFIG.toolMode, 'recommend-only')
})

test('config sanitization drops old aggregate database paths and unrelated settings', () => {
  const config = sanitizeConfig({
    toolMode: 'not-a-mode',
    libraryPath: 'old.json',
    replyLibraryPath: 'replies.json',
    baseTrajectoryPath: 'base.json',
    perturbationTrajectoryPath: 'perturb.json',
    videoDirectory: 'v'.repeat(600),
    trajectoryDirectory: 't'.repeat(600),
    baseTrajectoryId: 'a'.repeat(300),
    perturbationTrajectoryId: 'z'.repeat(300),
    folderName: 'old favorite folder',
    deliveryMode: 'qq',
    qqInbound: true,
  })
  assert.equal(config.toolMode, 'recommend-only')
  assert.equal(config.videoDirectory.length, 500)
  assert.equal(config.trajectoryDirectory.length, 500)
  assert.equal(config.baseTrajectoryId.length, 200)
  assert.equal(config.perturbationTrajectoryId.length, 200)
  for (const key of [
    'libraryPath',
    'replyLibraryPath',
    'baseTrajectoryPath',
    'perturbationTrajectoryPath',
    'folderName',
    'deliveryMode',
    'qqInbound',
  ]) {
    assert.equal(key in config, false)
  }
})

test('config and state round-trip through the plugin home', () => {
  const home = mkdtempSync(join(tmpdir(), 'bili-audit-store-'))
  try {
    const saved = saveConfig(home, {
      toolMode: 'all',
      baseTrajectoryId: 'baseline',
      perturbationTrajectoryId: 'higher-social-proof',
    })
    assert.deepEqual(loadConfig(home), saved)
    assert.equal(saved.toolMode, 'all')
    assert.equal(saved.baseTrajectoryId, 'baseline')
    assert.equal(saved.perturbationTrajectoryId, 'higher-social-proof')
    assert.equal(paths(home).videos, join(home, 'videos'))
    assert.equal(paths(home).trajectories, join(home, 'trajectories'))

    const state = emptyState()
    assert.equal(state.version, 4)
    state.cursors.traj_valid123 = 7
    state.events.push({
      id: 'event-1',
      type: 'next',
      at: '2026-01-01T00:00:00.000Z',
      trajectoryKey: 'traj_valid123',
      trajectoryId: 'higher-social-proof',
      batchId: 'turn-1',
      batchIndex: 0,
      source: 'recommend',
      message: 'audit note',
    })
    state.selections.push({
      id: 'selection-1',
      at: '2026-01-01T00:00:01.000Z',
      trajectoryKey: 'traj_valid123',
      trajectoryId: 'higher-social-proof',
      batchId: 'turn-1',
      batchIndex: 0,
      selected: [{ videoId: 'why_food_eat.less_star', reason: 'clear explanation' }],
    })
    saveState(home, state)
    const loaded = loadState(home)
    assert.equal(loaded.cursors.traj_valid123, 7)
    assert.equal(loaded.events[0].message, 'audit note')
    assert.equal(loaded.selections[0].selected[0].videoId, 'why_food_eat.less_star')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('state loading rejects malformed keys and sanitizes records', () => {
  const home = mkdtempSync(join(tmpdir(), 'bili-audit-store-'))
  try {
    saveState(home, {
      version: 999,
      cursors: {
        'bad key!': 3,
        traj_ok: 4.9,
        ['traj_' + 'x'.repeat(100)]: 2,
      },
      events: [
        {
          id: 'e'.repeat(200),
          type: 'favorite',
          at: 'a'.repeat(100),
          trajectoryKey: 'traj_ok',
          trajectoryId: 't'.repeat(300),
          batchId: 'b'.repeat(300),
          batchIndex: -10,
          source: 's'.repeat(100),
          message: 'm'.repeat(3000),
        },
        null,
      ],
      selections: [
        {
          id: 's1',
          selected: [
            { videoId: 'why_food_eat.less_star', reason: 'r'.repeat(2000) },
            { reason: 'missing id' },
            'city_night.warm_tone',
          ],
        },
      ],
      legacyCredentials: { cookie: 'must not survive' },
    })
    const loaded = loadState(home)
    assert.deepEqual(loaded.cursors, { traj_ok: 4 })
    assert.equal(loaded.events.length, 1)
    assert.equal(loaded.events[0].type, 'next')
    assert.equal(loaded.events[0].batchIndex, 0)
    assert.equal(loaded.events[0].message.length, 2000)
    assert.equal(loaded.selections[0].selected.length, 2)
    assert.equal(loaded.selections[0].selected[0].reason.length, 1000)
    assert.equal('legacyCredentials' in loaded, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
