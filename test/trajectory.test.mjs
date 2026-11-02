import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeReplyLibrary } from '../lib/reply-library.js'
import { normalizeVideoLibrary } from '../lib/video-library.js'
import {
  listTrajectoryIds,
  resolveBatch,
  resolveLayeredTrajectory,
  selectTrajectory,
  trajectoryFingerprint,
  validateBatchSelection,
} from '../lib/trajectory.js'

const library = normalizeVideoLibrary({
  videos: {
    why_food_eat: {
      recommendation: { title: 'food original' },
      watch: { content: [{ type: 'text', text: 'food watch' }] },
      perturbations: {
        less_star: { recommendation: { stats: { views: 10 } } },
        more_fan: { recommendation: { stats: { views: 1000 } } },
      },
    },
    city_night: {
      recommendation: { title: 'city original' },
      watch: { content: [] },
      perturbations: {
        warm_tone: { recommendation: { title: 'warm city' } },
      },
    },
  },
})

const replies = normalizeReplyLibrary({
  replies: {
    'neutral-ack': { role: 'assistant', text: 'seen' },
    'preference-note': { role: 'user', text: 'prefer details' },
  },
})

const baseDatabase = {
  activeTrajectory: 'baseline',
  trajectories: {
    baseline: {
      name: 'Baseline',
      metadata: { experiment: 'audit' },
      batches: [
        {
          id: 'turn-1',
          metadata: { condition: 'base' },
          videos: ['why_food_eat.less_star', 'city_night.warm_tone'],
          replies: ['neutral-ack'],
        },
        {
          id: 'turn-2',
          videos: [{ id: 'city_night.warm_tone', recommendation: { title: 'city override' } }],
          replies: ['neutral-ack', { replyId: 'preference-note', text: 'local override' }],
        },
        { id: 'turn-3', videos: ['why_food_eat.more_fan'] },
      ],
    },
  },
}

const perturbationDatabase = {
  trajectories: {
    higher_social_proof: {
      name: 'Higher social proof',
      extends: 'baseline',
      metadata: { condition: 'perturbed' },
      patches: [
        {
          batchId: 'turn-1',
          videos: ['why_food_eat.more_fan', 'city_night.warm_tone'],
          metadata: { condition: 'higher-social-proof' },
        },
        { batchId: 'turn-2', remove: true },
      ],
      addBatches: [{ id: 'turn-4', videos: ['why_food_eat.less_star'] }],
    },
  },
}

test('lists and selects trajectories from a database', () => {
  assert.deepEqual(listTrajectoryIds(baseDatabase), ['baseline'])
  assert.equal(selectTrajectory(baseDatabase).id, 'baseline')
  assert.throws(() => selectTrajectory(baseDatabase, 'missing'), /找不到 id/)
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

test('resolves video ids, local overrides, inline videos, and reusable replies', () => {
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
        replies: ['neutral-ack', { replyId: 'preference-note', text: 'more specific' }],
      },
    ],
  })
  const batch = resolveBatch(library, trajectory, 0, replies)
  assert.equal(batch.id, 'mixed-batch')
  assert.equal(batch.videos[0].recommendation.title, 'food original')
  assert.equal(batch.videos[1].recommendation.title, 'city override')
  assert.equal(batch.videos[2].id, 'inline-mixed-batch-3')
  assert.equal(batch.videos[2].watch.subtitles[0], 'inline subtitle')
  assert.equal(batch.replies[0].text, 'seen')
  assert.deepEqual(batch.replies[1], {
    id: 'preference-note',
    role: 'user',
    text: 'more specific',
  })
  assert.equal(resolveBatch(library, trajectory, 1), null)
})

test('perturbation trajectories inherit base batches and apply only sparse changes', () => {
  const base = resolveLayeredTrajectory({ baseDocument: baseDatabase })
  const perturbed = resolveLayeredTrajectory({
    baseDocument: baseDatabase,
    perturbationDocument: perturbationDatabase,
    perturbationTrajectoryId: 'higher_social_proof',
  })
  assert.equal(base.source, 'base')
  assert.equal(base.batches.length, 3)
  assert.equal(perturbed.source, 'perturbation')
  assert.equal(perturbed.baseId, 'baseline')
  assert.equal(perturbed.perturbationId, 'higher_social_proof')
  assert.deepEqual(perturbed.batches.map((batch) => batch.id), ['turn-1', 'turn-3', 'turn-4'])
  assert.deepEqual(perturbed.batches[0].videos, ['why_food_eat.more_fan', 'city_night.warm_tone'])
  assert.deepEqual(perturbed.batches[0].metadata, { condition: 'higher-social-proof' })
  assert.deepEqual(perturbed.batches[0].replies, ['neutral-ack'])
  assert.deepEqual(perturbed.batches[1].videos, ['why_food_eat.more_fan'])
  assert.deepEqual(perturbed.batches[2].videos, ['why_food_eat.less_star'])
  assert.deepEqual(perturbed.metadata, { experiment: 'audit', condition: 'perturbed' })
})

test('returns the selected base unchanged when no perturbation id is set', () => {
  const trajectory = resolveLayeredTrajectory({
    baseDocument: baseDatabase,
    perturbationDocument: perturbationDatabase,
    baseTrajectoryId: 'baseline',
    perturbationTrajectoryId: '',
  })
  assert.equal(trajectory.source, 'base')
  assert.deepEqual(trajectory.batches, baseDatabase.trajectories.baseline.batches.map((batch) => ({
    ...batch,
    replies: batch.replies || [],
  })))
})

test('fingerprints are stable across object key order but change with final content', () => {
  const first = {
    id: 'stable',
    batches: [{ id: 'batch', videos: ['why_food_eat.less_star'], metadata: { a: 1, b: 2 } }],
  }
  const reordered = {
    id: 'stable',
    batches: [{ metadata: { b: 2, a: 1 }, videos: ['why_food_eat.less_star'], id: 'batch' }],
  }
  const perturbed = resolveLayeredTrajectory({
    baseDocument: baseDatabase,
    perturbationDocument: perturbationDatabase,
    perturbationTrajectoryId: 'higher_social_proof',
  })
  assert.equal(trajectoryFingerprint(first), trajectoryFingerprint(reordered))
  assert.notEqual(trajectoryFingerprint(selectTrajectory(baseDatabase)), trajectoryFingerprint(perturbed))
})

test('selection is limited to a returned batch and accepts an explicit empty choice', () => {
  const trajectory = selectTrajectory(baseDatabase)
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
  const trajectory = selectTrajectory(baseDatabase)
  assert.throws(() => validateBatchSelection(library, trajectory, 'missing', []), /找不到批次/)
  assert.throws(
    () => validateBatchSelection(library, trajectory, 'turn-1', ['why_food_eat.more_fan'], { maxBatchIndex: 1 }),
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
})
