import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAuditEngine, loadLibraryItem } from '../lib/audit-engine.js'
import { loadState, saveConfig } from '../lib/store.js'
import { writeJson } from '../lib/util.js'

function fixture({ invalidVideo = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bili-audit-engine-'))
  const videoDirectory = join(home, 'videos')
  const baselineDirectory = join(home, 'trajectories', 'baseline')
  mkdirSync(videoDirectory, { recursive: true })
  mkdirSync(baselineDirectory, { recursive: true })

  writeJson(join(videoDirectory, 'why_food_eat.json'), {
    schemaVersion: 3,
    id: 'why_food_eat',
    recommendation: { title: 'food baseline' },
    watch: { content: [{ type: 'text', text: 'food watch' }] },
    perturbations: {
      less_star: { recommendation: { stats: { views: 10 } } },
      more_fan: { recommendation: { title: 'food popular', stats: { views: 1000 } } },
    },
  })
  writeJson(join(videoDirectory, 'city_night.json'), {
    schemaVersion: 3,
    id: 'city_night',
    recommendation: { title: 'city' },
    watch: { content: [] },
    perturbations: {
      warm_tone: { recommendation: { summary: 'warm city' } },
    },
  })

  const base = {
    schemaVersion: 3,
    id: 'baseline',
    name: 'Baseline',
    batches: [
      {
        id: 'turn-1',
        videos: invalidVideo
          ? ['missing.video']
          : ['why_food_eat.less_star', 'city_night.warm_tone'],
        replies: [{ id: 'neutral-ack', role: 'assistant', text: 'seen inline' }],
      },
      { id: 'turn-2', videos: ['why_food_eat.more_fan'], replies: [] },
    ],
  }
  const perturbation = {
    schemaVersion: 3,
    id: 'higher-social-proof',
    extends: 'baseline',
    patches: [
      {
        batchId: 'turn-1',
        videos: ['why_food_eat.more_fan', 'city_night.warm_tone'],
        replies: [{ id: 'perturbed-reply', role: 'assistant', text: 'perturbed inline reply' }],
      },
    ],
  }
  writeJson(join(baselineDirectory, 'base.json'), base)
  writeJson(join(baselineDirectory, 'higher-social-proof.json'), perturbation)

  const config = saveConfig(home, {
    toolMode: 'recommend-only',
    baseTrajectoryId: 'baseline',
    perturbationTrajectoryId: '',
  })
  return { home, config, base, perturbation }
}

test('next always follows the fixed trajectory regardless of prior message and selection', () => {
  const { home, config } = fixture()
  try {
    const first = createAuditEngine({ home, config }).next({ message: 'I only want cooking videos' })
    assert.equal(first.ok, true)
    assert.equal(first.batch.id, 'turn-1')
    assert.equal(first.next.cursor, 1)
    assert.equal(first.batch.videos[0].recommendation.title, 'food baseline')
    assert.deepEqual(first.batch.replies.map((reply) => reply.id), ['neutral-ack'])

    const selected = createAuditEngine({ home, config }).select({
      batchId: first.batch.id,
      selected: [{ videoId: 'city_night.warm_tone', reason: ' prefer the city video ' }],
    })
    assert.equal(selected.cursor, 1)
    assert.deepEqual(selected.selected, [{ videoId: 'city_night.warm_tone', reason: 'prefer the city video' }])

    const second = createAuditEngine({ home, config }).next({ message: 'actually choose something else' })
    assert.equal(second.batch.id, 'turn-2')
    assert.equal(second.batch.videos[0].id, 'why_food_eat.more_fan')
    assert.equal(second.next.cursor, 2)
    assert.equal(second.next.exhausted, true)
    assert.equal(loadState(home).events.length, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('select and lookup do not advance the replay cursor', () => {
  const { home, config } = fixture()
  try {
    const engine = createAuditEngine({ home, config })
    const preview = engine.peek()
    assert.equal(preview.batch.id, 'turn-1')
    assert.equal(engine.status().trajectory.cursor, 0)

    assert.throws(
      () => engine.select({ batchId: 'turn-1', selected: ['why_food_eat.less_star'] }),
      /尚未.*返回/,
    )

    const found = engine.lookup('why_food_eat.less_star')
    assert.equal(found.video.recommendation.title, 'food baseline')
    assert.equal(found.video.recommendation.stats.views, 10)
    assert.equal(loadLibraryItem({ home, config, id: 'city_night.warm_tone' }).id, 'city_night.warm_tone')
    assert.equal(engine.status().trajectory.cursor, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a future batch cannot be selected before it is returned', () => {
  const { home, config } = fixture()
  try {
    const engine = createAuditEngine({ home, config })
    engine.next()
    assert.throws(
      () => engine.select({ batchId: 'turn-2', selected: ['why_food_eat.more_fan'] }),
      /尚未.*返回/,
    )
    engine.next()
    assert.throws(
      () => engine.select({ batchId: 'turn-2', selected: ['why_food_eat.less_star'] }),
      /不在批次/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('status reports directory-backed videos and inline replies', () => {
  const { home, config } = fixture()
  try {
    const engine = createAuditEngine({ home, config })
    const status = engine.status()
    assert.equal(status.library.baseVideos, 2)
    assert.equal(status.library.videos, 5)
    assert.equal(status.library.perturbations, 3)
    assert.equal(status.trajectory.inlineReplies, 1)
    assert.equal(status.trajectory.batches, 2)
    assert.equal(status.files.videoDirectory, join(home, 'videos'))
    assert.equal(status.files.trajectoryDirectory, join(home, 'trajectories'))
    assert.equal(status.trajectoryCatalog[0].baseId, 'baseline')
    assert.deepEqual(status.trajectoryCatalog[0].perturbationIds, ['higher-social-proof'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a selected perturbation inherits base batches and applies only its patch', () => {
  const { home } = fixture()
  try {
    const config = saveConfig(home, {
      baseTrajectoryId: 'baseline',
      perturbationTrajectoryId: 'higher-social-proof',
    })
    const engine = createAuditEngine({ home, config })
    const first = engine.next()
    assert.equal(first.batch.videos[0].id, 'why_food_eat.more_fan')
    assert.equal(first.batch.replies[0].text, 'perturbed inline reply')
    assert.equal(engine.status().trajectory.source, 'perturbation')
    assert.equal(engine.status().trajectory.inlineReplies, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing video reference fails while loading all audit inputs', () => {
  const { home, config } = fixture({ invalidVideo: true })
  try {
    assert.throws(() => createAuditEngine({ home, config }), /找不到 id：missing\.video/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('reset clears only the active trajectory by default and everything on request', () => {
  const { home, config } = fixture()
  try {
    const engine = createAuditEngine({ home, config })
    engine.next()
    engine.next()
    assert.equal(engine.status().trajectory.cursor, 2)
    engine.reset({ scope: 'active' })
    assert.equal(engine.status().trajectory.cursor, 0)
    assert.equal(engine.status().recentEvents.length, 0)

    engine.next()
    engine.reset({ scope: 'all' })
    assert.equal(engine.status().trajectory.cursor, 0)
    assert.equal(loadState(home).events.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
