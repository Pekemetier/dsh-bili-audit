import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeVideoLibrary } from '../lib/video-library.js'
import {
  listTrajectoryIds,
  resolveBatch,
  selectTrajectory,
  trajectoryFingerprint,
  validateBatchSelection,
} from '../lib/trajectory.js'

const library = normalizeVideoLibrary({
  videos: {
    'why_food_eat.less_star': {
      recommendation: { title: 'food original' },
      watch: { content: [{ type: 'text', text: 'food watch' }] },
    },
    'city_night.warm_tone': {
      recommendation: { title: 'city original' },
      watch: { content: [] },
    },
  },
})

const database = {
  activeTrajectory: 'baseline',
  trajectories: {
    baseline: {
      name: 'Baseline',
      batches: [
        { id: 'turn-1', videos: ['why_food_eat.less_star'] },
        { id: 'turn-2', videos: [{ id: 'city_night.warm_tone', recommendation: { title: 'city override' } }] },
      ],
    },
    perturbation: {
      name: 'Perturbation',
      batches: [[{ recommendation: { title: 'fully inline' }, watch: { content: [] } }]],
    },
  },
}

test('lists and selects trajectories from a database', () => {
  assert.deepEqual(listTrajectoryIds(database), ['baseline', 'perturbation'])
  assert.equal(selectTrajectory(database).id, 'baseline')
  assert.equal(selectTrajectory(database, 'perturbation').name, 'Perturbation')
  assert.throws(() => selectTrajectory(database, 'missing'), /找不到 id/)
})

test('accepts a single trajectory and array shorthand batches', () => {
  const trajectory = selectTrajectory({
    id: 'single',
    name: 'Single trajectory',
    batches: [['why_food_eat.less_star'], { id: 'custom', videos: ['city_night.warm_tone'] }],
  })
  assert.equal(trajectory.id, 'single')
  assert.equal(trajectory.batches[0].id, 'batch-1')
  assert.equal(trajectory.batches[1].id, 'custom')
  assert.deepEqual(listTrajectoryIds({ batches: [] }), ['default'])
})

test('resolves library ids, id overrides, and inline entries into one batch', () => {
  const trajectory = selectTrajectory({
    id: 'mixed',
    batches: [
      {
        id: 'mixed-batch',
        videos: [
          'why_food_eat.less_star',
          { id: 'city_night.warm_tone', recommendation: { title: 'city override' } },
          { recommendation: { title: 'inline only' }, watch: { subtitles: ['inline subtitle'] } },
        ],
      },
    ],
  })
  const batch = resolveBatch(library, trajectory, 0)
  assert.equal(batch.id, 'mixed-batch')
  assert.equal(batch.videos[0].recommendation.title, 'food original')
  assert.equal(batch.videos[1].recommendation.title, 'city override')
  assert.equal(batch.videos[1].watch.content.length, 0)
  assert.equal(batch.videos[2].id, 'inline-mixed-batch-3')
  assert.equal(batch.videos[2].watch.subtitles[0], 'inline subtitle')
  assert.equal(resolveBatch(library, trajectory, 1), null)
})

test('fingerprints are stable across object key order but change with batch order', () => {
  const first = {
    id: 'stable',
    batches: [{ id: 'batch', videos: ['why_food_eat.less_star'], metadata: { a: 1, b: 2 } }],
  }
  const reordered = {
    id: 'stable',
    batches: [{ metadata: { b: 2, a: 1 }, videos: ['why_food_eat.less_star'], id: 'batch' }],
  }
  const reversed = {
    id: 'stable',
    batches: [
      { id: 'batch-2', videos: ['city_night.warm_tone'] },
      { id: 'batch-1', videos: ['why_food_eat.less_star'] },
    ],
  }
  assert.equal(trajectoryFingerprint(first), trajectoryFingerprint(reordered))
  assert.notEqual(trajectoryFingerprint(first), trajectoryFingerprint(reversed))
})

test('selection is limited to a batch already returned by the replay cursor', () => {
  const trajectory = selectTrajectory(database)
  assert.throws(
    () => validateBatchSelection(library, trajectory, 'turn-1', ['why_food_eat.less_star'], { maxBatchIndex: 0 }),
    /尚未.*返回/,
  )
  const checked = validateBatchSelection(
    library,
    trajectory,
    'turn-1',
    [{ videoId: 'why_food_eat.less_star', reason: '  useful  ' }],
    { maxBatchIndex: 1 },
  )
  assert.deepEqual(checked.selected, [{ videoId: 'why_food_eat.less_star', reason: 'useful' }])
  assert.deepEqual(
    validateBatchSelection(library, trajectory, 'turn-1', [], { maxBatchIndex: 1 }).selected,
    [],
  )
})

test('selection rejects unknown, duplicate, and malformed video ids', () => {
  const trajectory = selectTrajectory(database)
  assert.throws(
    () => validateBatchSelection(library, trajectory, 'missing', []),
    /找不到批次/,
  )
  assert.throws(
    () => validateBatchSelection(library, trajectory, 'turn-1', ['city_night.warm_tone'], { maxBatchIndex: 1 }),
    /不在批次/,
  )
  assert.throws(
    () => validateBatchSelection(
      library,
      trajectory,
      'turn-1',
      ['why_food_eat.less_star', 'why_food_eat.less_star'],
      { maxBatchIndex: 1 },
    ),
    /重复/,
  )
  assert.throws(
    () => validateBatchSelection(library, trajectory, 'turn-1', [{}], { maxBatchIndex: 1 }),
    /缺少 videoId/,
  )
  assert.throws(
    () => validateBatchSelection(library, trajectory, 'turn-1', 'not-an-array', { maxBatchIndex: 1 }),
    /必须是数组/,
  )
  assert.throws(
    () => validateBatchSelection(library, trajectory, 'turn-1', undefined, { maxBatchIndex: 1 }),
    /必须是数组/,
  )
})
