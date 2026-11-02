import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../index.js'
import { loadConfig } from '../lib/store.js'
import { writeJson } from '../lib/util.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bili-audit-tools-'))
  const library = {
    videos: {
      why_food_eat: {
        recommendation: { title: 'food baseline' },
        watch: { content: [{ type: 'text', text: 'food watch' }] },
        perturbations: {
          less_star: { recommendation: { stats: { views: 10 } } },
          more_fan: { recommendation: { title: 'food popular' } },
        },
      },
      city_night: {
        recommendation: { title: 'city' },
        watch: { content: [] },
        perturbations: {},
      },
    },
  }
  const replyLibrary = {
    replies: {
      'neutral-ack': { role: 'assistant', text: 'seen' },
      'preference-note': { role: 'user', text: 'prefer details' },
    },
  }
  const baseTrajectories = {
    activeTrajectory: 'baseline',
    trajectories: {
      baseline: {
        name: 'Baseline',
        batches: [
          { id: 'turn-1', videos: ['why_food_eat.less_star', 'city_night'], replies: ['neutral-ack'] },
          { id: 'turn-2', videos: ['why_food_eat.more_fan'], replies: [] },
        ],
      },
    },
  }
  const perturbationTrajectories = {
    trajectories: {
      higher_social_proof: {
        extends: 'baseline',
        patches: [
          { batchId: 'turn-1', videos: ['why_food_eat.more_fan', 'city_night'] },
        ],
      },
    },
  }
  writeJson(join(home, 'video-library.json'), library)
  writeJson(join(home, 'reply-library.json'), replyLibrary)
  writeJson(join(home, 'base-trajectories.json'), baseTrajectories)
  writeJson(join(home, 'perturbation-trajectories.json'), perturbationTrajectories)
  return { home, library, replyLibrary, baseTrajectories, perturbationTrajectories }
}

function makeContext(home) {
  const activeTools = new Map()
  const handlers = []
  const lifecycle = []
  const ctx = {
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name === 'connection') return undefined
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') lifecycle.push(dispose)
      return dispose
    },
    tools: {
      register(definition) {
        activeTools.set(definition.name, definition)
        return () => activeTools.delete(definition.name)
      },
    },
    webServer: {
      register(definition) {
        handlers.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, activeTools, handlers, lifecycle }
}

function invoke(handler, { method = 'GET', url = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = Readable.from(payload)
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:6123' }
    const res = {
      writableEnded: false,
      statusCode: 200,
      writeHead(status) {
        this.statusCode = status
      },
      end(data) {
        if (this.writableEnded) return
        this.writableEnded = true
        let json = null
        try {
          json = data ? JSON.parse(String(data)) : null
        } catch {
          json = null
        }
        resolve({ status: this.statusCode, body: json })
      },
    }
    try {
      handler(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

test('tool exposure switches between recommend-only and all modes at runtime', async () => {
  const { home } = fixture()
  try {
    const { ctx, activeTools, handlers, lifecycle } = makeContext(home)
    apply(ctx)
    assert.deepEqual([...activeTools.keys()], ['bili_fav_recommend'])

    const handler = handlers[0].handler
    const enabled = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/config',
      body: { toolMode: 'all' },
    })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.config.toolMode, 'all')
    assert.deepEqual([...activeTools.keys()].sort(), [
      'bili_fav_preview',
      'bili_fav_recommend',
      'bili_fav_run',
      'bili_fav_status',
    ])

    const status = await invoke(handler, { url: '/api/bili-audit/status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.toolChoiceRequired, true)

    const disabled = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/config',
      body: { toolMode: 'recommend-only' },
    })
    assert.equal(disabled.status, 200)
    assert.deepEqual([...activeTools.keys()], ['bili_fav_recommend'])
    assert.equal(loadConfig(home).toolMode, 'recommend-only')

    for (const dispose of lifecycle.reverse()) dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('recommend-only tool supports next, select, lookup, and deterministic replay', async () => {
  const { home } = fixture()
  try {
    const { ctx, activeTools, lifecycle } = makeContext(home)
    apply(ctx)
    const tool = activeTools.get('bili_fav_recommend')

    const first = await tool.execute({ message: 'ignore this preference' }, {})
    assert.equal(first.ok, true)
    assert.equal(first.deterministic, true)
    assert.equal(first.batch.id, 'turn-1')
    assert.equal(first.batch.videos[0].id, 'why_food_eat.less_star')

    const selected = await tool.execute(
      { action: 'select', batchId: 'turn-1', selected: ['why_food_eat.less_star'] },
      {},
    )
    assert.equal(selected.ok, true)
    assert.equal(selected.cursor, 1)

    const second = await tool.execute({ message: 'choose anything else' }, {})
    assert.equal(second.batch.id, 'turn-2')
    assert.equal(second.batch.videos[0].id, 'why_food_eat.more_fan')
    assert.equal(second.next.cursor, 2)

    const lookup = await tool.execute(
      { action: 'lookup', videoId: 'why_food_eat.less_star' },
      {},
    )
    assert.equal(lookup.ok, true)
    assert.equal(lookup.video.id, 'why_food_eat.less_star')
    assert.ok(lookup.video.recommendation)
    assert.ok(lookup.video.watch)

    for (const dispose of lifecycle.reverse()) dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all four database save endpoints validate and persist layered documents', async () => {
  const { home, library, replyLibrary, baseTrajectories, perturbationTrajectories } = fixture()
  try {
    const { ctx, handlers, lifecycle } = makeContext(home)
    apply(ctx)
    const handler = handlers[0].handler

    const videoResponse = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/video-library',
      body: library,
    })
    assert.equal(videoResponse.status, 200)

    const replyResponse = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/reply-library',
      body: replyLibrary,
    })
    assert.equal(replyResponse.status, 200)

    const baseResponse = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/base-trajectories',
      body: baseTrajectories,
    })
    assert.equal(baseResponse.status, 200)
    assert.equal(baseResponse.body.baseTrajectoryId, 'baseline')

    const perturbResponse = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/perturbation-trajectories',
      body: perturbationTrajectories,
    })
    assert.equal(perturbResponse.status, 200)

    const status = await invoke(handler, { url: '/api/bili-audit/status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.status.trajectory.id, 'baseline')
    assert.equal(status.body.status.library.videos, 4)
    assert.equal(status.body.status.library.replies, 2)

    for (const dispose of lifecycle.reverse()) dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('saved databases clear removed ids and fall back to valid entries', async () => {
  const { home } = fixture()
  try {
    const { ctx, handlers, lifecycle } = makeContext(home)
    apply(ctx)
    const handler = handlers[0].handler

    const selected = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/config',
      body: { baseTrajectoryId: 'baseline', perturbationTrajectoryId: 'higher_social_proof' },
    })
    assert.equal(selected.status, 200)

    const cleared = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/perturbation-trajectories',
      body: { trajectories: {} },
    })
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.perturbationTrajectoryId, '')
    assert.equal(cleared.body.switchedFromMissingId, 'higher_social_proof')

    const replacement = {
      activeTrajectory: 'replacement',
      trajectories: {
        replacement: {
          name: 'Replacement',
          batches: [{ id: 'only-batch', videos: ['why_food_eat.less_star'] }],
        },
      },
    }
    const saved = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/base-trajectories',
      body: replacement,
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.baseTrajectoryId, 'replacement')
    assert.equal(saved.body.switchedFromMissingId, 'baseline')
    assert.equal(loadConfig(home).baseTrajectoryId, 'replacement')

    const status = await invoke(handler, { url: '/api/bili-audit/status' })
    assert.equal(status.body.status.trajectory.id, 'replacement')
    assert.equal(status.body.status.trajectory.batches, 1)

    for (const dispose of lifecycle.reverse()) dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
