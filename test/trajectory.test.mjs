import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listTrajectoryCatalog,
  loadTrajectorySelection,
  normalizeBaseTrajectoryFile,
  normalizePerturbationTrajectoryFile,
  resolveBatch,
  resolveLayeredTrajectory,
  selectTrajectory,
  trajectoryFingerprint,
  validateBatchSelection,
} from '../lib/trajectory.js'
import { normalizeVideoLibrary } from '../lib/video-library.js'
import { writeJson } from '../lib/util.js'

const library = normalizeVideoLibrary({
  videos: {
    why_food_eat: {
      recommendation: { title: 'food original' },
      watch: { content: [{ type: 'text', text: 'food watch' }] },
      perturbations: {
        less_star: { recommendation: { stats: { views: 3 } } },
        more_fan: { recommendation: { title: 'food popular', stats: { views: 1000 } } },
      },
    },
    city_night: {
      recommendation: { title: 'city' },
      watch: { content: [] },
      perturbations: {
        warm_tone: { recommendation: { summary: 'warm city' } },
      },
    },
  },
})

const baseDocument = {
  schemaVersion: 3,
  id: 'baseline',
  name: 'Baseline',
  metadata: { experiment: 'audit' },
  batches: [
    {
      id: 'turn-1',
      metadata: { condition: 'baseline' },
      videos: ['why_food_eat.less_star', 'city_night.warm_tone'],
      replies: [{ id: 'neutral-ack', role: 'assistant', text: 'seen' }],
    },
    {
      id: 'turn-2',
      videos: [{ id: 'why_food_eat.more_fan', recommendation: { title: 'override' } }],
      replies: [{ id: 'preference-note', role: 'user', text: 'prefer details' }],
    },
    { id: 'turn-3', videos: ['city_night'], replies: [] },
  ],
}

const perturbationDocument = {
  schemaVersion: 3,
  id: 'higher-social-proof',
  extends: 'baseline',
  metadata: { condition: 'perturbed' },
  patches: [
    {
      batchId: 'turn-1',
      videos: ['why_food_eat.more_fan', 'city_night.warm_tone'],
      metadata: { condition: 'higher-social-proof' },
      replies: [{ id: 'inline-perturbed', role: 'assistant', text: 'context-specific reply' }],
    },
    {
      batchId: 'turn-2',
      remove: true,
    },
  ],
  addBatches: [
    {
      id: 'turn-4',
      videos: ['why_food_eat.less_star'],
      replies: ['新批次的内联回复'],
    },
  ],
}

test('batch replies are normalized inline and resolved with video content', () => {
  const trajectory = selectTrajectory(baseDocument)
  const batch = resolveBatch(library, trajectory, 0)
  assert.equal(batch.id, 'turn-1')
  assert.equal(batch.videos[0].recommendation.title, 'food original')
  assert.deepEqual(batch.videos[0].recommendation.stats, { views: 3 })
  assert.equal(batch.videos[1].recommendation.summary, 'warm city')
  assert.deepEqual(batch.replies, [{ id: 'neutral-ack', role: 'assistant', text: 'seen' }])
  assert.equal(resolveBatch(library, trajectory, 9), null)
})

test('perturbation trajectories inherit base batches and store only changes', () => {
  const base = resolveLayeredTrajectory({ baseDocument, baseTrajectoryId: 'baseline' })
  const perturbed = resolveLayeredTrajectory({
    baseDocument,
    perturbationDocument,
    baseTrajectoryId: 'baseline',
    perturbationTrajectoryId: 'higher-social-proof',
  })
  assert.equal(base.source, 'base')
  assert.equal(base.batches.length, 3)
  assert.equal(perturbed.source, 'perturbation')
  assert.equal(perturbed.baseId, 'baseline')
  assert.equal(perturbed.perturbationId, 'higher-social-proof')
  assert.deepEqual(perturbed.batches.map((batch) => batch.id), ['turn-1', 'turn-3', 'turn-4'])
  assert.deepEqual(perturbed.batches[0].videos, ['why_food_eat.more_fan', 'city_night.warm_tone'])
  assert.deepEqual(perturbed.batches[0].metadata, { condition: 'higher-social-proof' })
  assert.equal(perturbed.batches[0].replies[0].text, 'context-specific reply')
  assert.deepEqual(perturbed.batches[1].videos, ['city_night'])
  assert.equal(perturbed.metadata.experiment, 'audit')
  assert.equal(perturbed.metadata.condition, 'perturbed')
})

test('single trajectory documents reject collection files and filename mismatches', () => {
  assert.throws(() => selectTrajectory({ trajectories: {} }), /不能包含 trajectories 集合/)
  assert.throws(() => normalizeBaseTrajectoryFile(baseDocument, 'other'), /目录名不一致/)
  assert.throws(
    () => normalizePerturbationTrajectoryFile({ ...perturbationDocument, extends: 'other' }, {
      baseId: 'baseline',
      expectedId: 'higher-social-proof',
    }),
    /必须指向所在目录的 base/,
  )
  assert.throws(
    () => normalizePerturbationTrajectoryFile({ id: 'base', extends: 'baseline', patches: [] }, {
      baseId: 'baseline',
      expectedId: 'base',
    }),
    /保留名称/,
  )
})

test('trajectory directories contain one base folder and one file per variant', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bili-audit-trajectories-'))
  try {
    const baseline = join(directory, 'baseline')
    mkdirSync(baseline, { recursive: true })
    writeJson(join(baseline, 'base.json'), baseDocument)
    writeJson(join(baseline, 'higher-social-proof.json'), perturbationDocument)

    const catalog = listTrajectoryCatalog(directory)
    assert.deepEqual(catalog.map((entry) => entry.baseId), ['baseline'])
    assert.deepEqual(catalog[0].perturbationIds, ['higher-social-proof'])

    const selected = loadTrajectorySelection({
      directory,
      baseTrajectoryId: 'baseline',
      perturbationTrajectoryId: 'higher-social-proof',
    })
    assert.equal(selected.trajectory.id, 'higher-social-proof')
    assert.equal(selected.trajectory.batches.length, 3)
    assert.equal(selected.baseFile, join(baseline, 'base.json'))
    assert.equal(selected.perturbationFile, join(baseline, 'higher-social-proof.json'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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
    baseDocument,
    perturbationDocument,
    baseTrajectoryId: 'baseline',
    perturbationTrajectoryId: 'higher-social-proof',
  })
  assert.equal(trajectoryFingerprint(selectTrajectory(first)), trajectoryFingerprint(selectTrajectory(reordered)))
  assert.notEqual(trajectoryFingerprint(selectTrajectory(baseDocument)), trajectoryFingerprint(perturbed))
})

test('selection is limited to a returned batch and accepts an explicit empty choice', () => {
  const trajectory = selectTrajectory(baseDocument)
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
  const trajectory = selectTrajectory(baseDocument)
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
