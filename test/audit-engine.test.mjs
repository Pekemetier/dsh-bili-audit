import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAuditEngine, loadLibraryItem } from '../lib/audit-engine.js'
import { loadState, saveConfig } from '../lib/store.js'
import { writeJson } from '../lib/util.js'

function fixture({ invalidVideo = false, invalidReply = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bili-audit-engine-'))
  const library = {
    videos: {
      why_food_eat: {
        recommendation: { title: 'food baseline' },
        watch: { content: [{ type: 'text', text: 'food watch' }] },
        perturbations: {
          less_star: { recommendation: { stats: { views: 10 } } },
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
  }
  const replyLibrary = {
    replies: {
      'neutral-ack': { role: 'assistant', text: 'seen' },
    },
  }
  const baseTrajectories = {
    activeTrajectory: 'baseline',
    trajectories: {
      baseline: {
        name: 'Baseline',
        batches: [
          {
            id: 'turn-1',
            videos: ['why_food_eat.less_star', 'city_night.warm_tone'],
            replies: ['neutral-ack'],
          },
          { id: 'turn-2', videos: ['why_food_eat.more_fan'], replies: [] },
        ],
      },
      alternative: {
        name: 'Alternative',
        batches: [{ id: 'alt-1', videos: ['city_night.warm_tone'], replies: [] }],
      },
    },
  }
  const perturbationTrajectories = {
    trajectories: {
      higher_social_proof: {
        extends: 'baseline',
        patches: [
          {
            batchId: 'turn-1',
            videos: ['why_food_eat.more_fan', 'city_night.warm_tone'],
          },
        ],
      },
    },
  }
  if (invalidVideo) {
    baseTrajectories.trajectories.baseline.batches[0].videos = ['missing.video']
  }
  if (invalidReply) {
    baseTrajectories.trajectories.baseline.batches[0].replies = ['missing-reply']
  }
  writeJson(join(home, 'video-library.json'), library)
  writeJson(join(home, 'reply-library.json'), replyLibrary)
  writeJson(join(home, 'base-trajectories.json'), baseTrajectories)
  writeJson(join(home, 'perturbation-trajectories.json'), perturbationTrajectories)
  const config = saveConfig(home, {
    toolMode: 'recommend-only',
    baseTrajectoryId: 'baseline',
    perturbationTrajectoryId: '',
  })
  return { home, config, library, replyLibrary, baseTrajectories, perturbationTrajectories }
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
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the base and perturbation layers use separate deterministic fingerprints', () => {
  const { home, config } = fixture()
  try {
    const baseEngine = createAuditEngine({ home, config })
    const baseFirst = baseEngine.next({ message: 'base first' })
    assert.equal(baseFirst.batch.videos[0].recommendation.title, 'food baseline')
    assert.equal(baseEngine.status().trajectory.source, 'base')

    const perturbedConfig = saveConfig(home, {
      ...config,
      perturbationTrajectoryId: 'higher_social_proof',
    })
    const perturbedEngine = createAuditEngine({ home, config: perturbedConfig })
    const perturbedStatus = perturbedEngine.status()
    assert.equal(perturbedStatus.trajectory.source, 'perturbation')
    assert.equal(perturbedStatus.trajectory.baseId, 'baseline')
    assert.equal(perturbedStatus.trajectory.perturbationId, 'higher_social_proof')
    assert.equal(perturbedStatus.trajectory.cursor, 0)
    assert.notEqual(perturbedStatus.trajectory.fingerprint, baseEngine.status().trajectory.fingerprint)

    const perturbedFirst = perturbedEngine.next({ message: 'perturbed first' })
    assert.equal(perturbedFirst.batch.id, 'turn-1')
    assert.equal(perturbedFirst.batch.videos[0].recommendation.title, 'food popular')

    const alternativeConfig = saveConfig(home, {
      ...config,
      baseTrajectoryId: 'alternative',
      perturbationTrajectoryId: '',
    })
    const alternative = createAuditEngine({ home, config: alternativeConfig }).next()
    assert.equal(alternative.batch.id, 'alt-1')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the cursor is deterministic across engine instances and persists audit events', () => {
  const { home, config } = fixture()
  try {
    const firstEngine = createAuditEngine({ home, config })
    firstEngine.next({ message: 'first' })
    firstEngine.next({ message: 'second' })

    const status = createAuditEngine({ home, config }).status()
    assert.equal(status.trajectory.cursor, 2)
    assert.equal(status.trajectory.remaining, 0)
    assert.equal(status.trajectory.exhausted, true)
    assert.equal(status.recentEvents.length, 2)
    assert.deepEqual(status.recentEvents.map((event) => event.message), ['second', 'first'])

    const exhausted = createAuditEngine({ home, config }).next({ message: 'third' })
    assert.equal(exhausted.ok, false)
    assert.equal(exhausted.exhausted, true)
    assert.equal(createAuditEngine({ home, config }).status().trajectory.cursor, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('reset clears only the active trajectory state by default', () => {
  const { home, config } = fixture()
  try {
    const engine = createAuditEngine({ home, config })
    const shown = engine.next()
    engine.select({ batchId: shown.batch.id, selected: [] })
    assert.equal(engine.status().recentEvents.length, 2)
    assert.equal(engine.status().recentSelections.length, 1)

    const reset = engine.reset()
    assert.equal(reset.trajectory.cursor, 0)
    assert.equal(createAuditEngine({ home, config }).status().recentEvents.length, 0)
    assert.equal(loadState(home).selections.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all video and reply references are validated before replay starts', () => {
  const missingVideo = fixture({ invalidVideo: true })
  try {
    assert.throws(
      () => createAuditEngine({ home: missingVideo.home, config: missingVideo.config }),
      /视频库中找不到 id：missing\.video/,
    )
  } finally {
    rmSync(missingVideo.home, { recursive: true, force: true })
  }

  const missingReply = fixture({ invalidReply: true })
  try {
    assert.throws(
      () => createAuditEngine({ home: missingReply.home, config: missingReply.config }),
      /回复库中找不到 id：missing-reply/,
    )
  } finally {
    rmSync(missingReply.home, { recursive: true, force: true })
  }
})
