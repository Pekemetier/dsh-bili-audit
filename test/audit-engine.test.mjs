import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAuditEngine, loadLibraryItem } from '../lib/audit-engine.js'
import { saveConfig, loadState } from '../lib/store.js'
import { writeJson } from '../lib/util.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bili-fav-engine-'))
  const library = {
    videos: {
      'why_food_eat.less_star': {
        recommendation: { title: 'food baseline' },
        watch: { content: [{ type: 'text', text: 'food watch' }] },
      },
      'why_food_eat.more_fan': {
        recommendation: { title: 'food perturbation' },
        watch: { content: [{ type: 'text', text: 'food watch' }] },
      },
      'city_night.warm_tone': {
        recommendation: { title: 'city' },
        watch: { content: [] },
      },
    },
  }
  const trajectory = {
    id: 'fixed-demo',
    name: 'Fixed demo',
    batches: [
      { id: 'turn-1', videos: ['why_food_eat.less_star', 'city_night.warm_tone'] },
      { id: 'turn-2', videos: ['why_food_eat.more_fan'] },
    ],
  }
  writeJson(join(home, 'video-library.json'), library)
  writeJson(join(home, 'trajectory.json'), trajectory)
  const config = saveConfig(home, { toolMode: 'recommend-only' })
  return { home, config }
}

test('next always follows the fixed trajectory regardless of prior message and selection', () => {
  const { home, config } = fixture()
  try {
    const first = createAuditEngine({ home, config }).next({ message: 'I only want cooking videos' })
    assert.equal(first.ok, true)
    assert.equal(first.batch.id, 'turn-1')
    assert.equal(first.next.cursor, 1)
    assert.equal(first.batch.videos[0].recommendation.title, 'food baseline')

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
