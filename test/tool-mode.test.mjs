import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../index.js'
import { loadConfig } from '../lib/store.js'
import { writeJson } from '../lib/util.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'bili-audit-tools-'))
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
      more_fan: { recommendation: { title: 'food popular' } },
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
        videos: ['why_food_eat.less_star', 'city_night.warm_tone'],
        replies: [{ id: 'neutral-ack', role: 'assistant', text: 'seen inline' }],
      },
      { id: 'turn-2', videos: ['why_food_eat.more_fan'], replies: [] },
    ],
  }
  const perturbation = {
    schemaVersion: 3,
    id: 'higher-social-proof',
    extends: 'baseline',
    name: 'Higher social proof',
    patches: [
      {
        batchId: 'turn-1',
        videos: ['why_food_eat.more_fan', 'city_night.warm_tone'],
      },
    ],
  }
  writeJson(join(baselineDirectory, 'base.json'), base)
  writeJson(join(baselineDirectory, 'higher-social-proof.json'), perturbation)
  return { home, base, perturbation }
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

function disposeAll(lifecycle) {
  for (const dispose of lifecycle.reverse()) dispose()
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
    assert.equal(status.body.status.trajectory.id, 'baseline')

    const disabled = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/config',
      body: { toolMode: 'recommend-only' },
    })
    assert.equal(disabled.status, 200)
    assert.deepEqual([...activeTools.keys()], ['bili_fav_recommend'])
    assert.equal(loadConfig(home).toolMode, 'recommend-only')

    const badConfig = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/config',
      body: { perturbationTrajectoryId: 'missing-perturbation' },
    })
    assert.equal(badConfig.status, 500)
    assert.equal(loadConfig(home).perturbationTrajectoryId, '')

    disposeAll(lifecycle)
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
    assert.equal(first.batch.videos[0].recommendation.stats.views, 10)
    assert.deepEqual(first.batch.replies.map((reply) => reply.id), ['neutral-ack'])

    const selected = await tool.execute(
      { action: 'select', batchId: 'turn-1', selected: ['why_food_eat.less_star'] },
      {},
    )
    assert.equal(selected.ok, true)
    assert.equal(selected.cursor, 1)
    assert.deepEqual(selected.selected, [{ videoId: 'why_food_eat.less_star', reason: '' }])

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

    disposeAll(lifecycle)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('per-file API reads and writes videos, base trajectories, and perturbation trajectories', async () => {
  const { home } = fixture()
  try {
    const { ctx, handlers, lifecycle } = makeContext(home)
    apply(ctx)
    const handler = handlers[0].handler

    const videos = await invoke(handler, { url: '/api/bili-audit/videos' })
    assert.equal(videos.status, 200)
    assert.deepEqual(videos.body.videos.map((entry) => entry.id), ['city_night', 'why_food_eat'])

    const video = await invoke(handler, { url: '/api/bili-audit/video?id=why_food_eat' })
    assert.equal(video.status, 200)
    assert.equal(video.body.document.id, 'why_food_eat')
    assert.equal(video.body.document.perturbations.less_star.recommendation.stats.views, 10)

    const addedVideo = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/video',
      body: {
        id: 'repair_culture',
        document: {
          id: 'repair_culture',
          recommendation: { title: 'repair' },
          watch: { content: [{ type: 'text', text: 'repair watch' }] },
          perturbations: { long_intro: { recommendation: { title: 'long repair' } } },
        },
      },
    })
    assert.equal(addedVideo.status, 200)
    assert.ok(existsSync(join(home, 'videos', 'repair_culture.json')))

    const catalog = await invoke(handler, { url: '/api/bili-audit/trajectories' })
    assert.equal(catalog.status, 200)
    assert.equal(catalog.body.trajectories[0].baseId, 'baseline')
    assert.deepEqual(catalog.body.trajectories[0].perturbationIds, ['higher-social-proof'])

    const base = await invoke(handler, {
      url: '/api/bili-audit/trajectory?baseId=baseline&mode=base',
    })
    assert.equal(base.status, 200)
    assert.equal(base.body.document.batches.length, 2)

    const perturbed = await invoke(handler, {
      url: '/api/bili-audit/trajectory?baseId=baseline&mode=perturbation&id=higher-social-proof',
    })
    assert.equal(perturbed.status, 200)
    assert.equal(perturbed.body.document.extends, 'baseline')

    const savedBase = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/base-trajectory',
      body: {
        baseId: 'baseline',
        document: {
          id: 'baseline',
          name: 'Baseline edited',
          batches: [
            {
              id: 'turn-1',
              videos: ['why_food_eat.less_star', 'city_night.warm_tone'],
              replies: [{ id: 'inline-only', role: 'assistant', text: 'context-dependent reply' }],
            },
          ],
        },
      },
    })
    assert.equal(savedBase.status, 200)

    const savedPerturbation = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/perturbation-trajectory',
      body: {
        baseId: 'baseline',
        id: 'higher-social-proof',
        document: {
          id: 'higher-social-proof',
          extends: 'baseline',
          patches: [
            {
              batchId: 'turn-1',
              videos: ['why_food_eat.more_fan', 'city_night.warm_tone'],
            },
          ],
        },
      },
    })
    assert.equal(savedPerturbation.status, 200)

    const status = await invoke(handler, { url: '/api/bili-audit/status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.status.library.baseVideos, 3)
    assert.equal(status.body.status.library.videos, 7)
    assert.equal(status.body.status.library.perturbations, 4)
    assert.equal(status.body.status.trajectory.inlineReplies, 1)

    disposeAll(lifecycle)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('failed per-file saves restore the previous bytes and keep the active audit loadable', async () => {
  const { home } = fixture()
  try {
    const { ctx, handlers, lifecycle } = makeContext(home)
    apply(ctx)
    const handler = handlers[0].handler
    const videoFile = join(home, 'videos', 'why_food_eat.json')
    const baseFile = join(home, 'trajectories', 'baseline', 'base.json')
    const originalVideo = readFileSync(videoFile, 'utf8')
    const originalBase = readFileSync(baseFile, 'utf8')

    const brokenVideo = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/video',
      body: {
        id: 'why_food_eat',
        document: {
          id: 'why_food_eat',
          recommendation: { title: 'without perturbations' },
          watch: { content: [] },
          perturbations: {},
        },
      },
    })
    assert.equal(brokenVideo.status, 500)
    assert.equal(readFileSync(videoFile, 'utf8'), originalVideo)

    const brokenBase = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/base-trajectory',
      body: {
        baseId: 'baseline',
        document: {
          id: 'baseline',
          batches: [{ id: 'turn-1', videos: ['missing.video'], replies: [] }],
        },
      },
    })
    assert.equal(brokenBase.status, 500)
    assert.equal(readFileSync(baseFile, 'utf8'), originalBase)

    const status = await invoke(handler, { url: '/api/bili-audit/status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.status.trajectory.batches, 2)

    disposeAll(lifecycle)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('switching to a perturbation keeps one fixed cursor and inherited reply context', async () => {
  const { home } = fixture()
  try {
    const { ctx, activeTools, handlers, lifecycle } = makeContext(home)
    apply(ctx)
    const handler = handlers[0].handler

    const configured = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-audit/config',
      body: {
        toolMode: 'all',
        baseTrajectoryId: 'baseline',
        perturbationTrajectoryId: 'higher-social-proof',
      },
    })
    assert.equal(configured.status, 200)

    const preview = await activeTools.get('bili_fav_preview').execute({}, {})
    assert.equal(preview.batch.videos[0].id, 'why_food_eat.more_fan')
    assert.equal(preview.batch.replies[0].id, 'neutral-ack')
    assert.equal((await activeTools.get('bili_fav_status').execute({}, {})).trajectory.cursor, 0)

    const run = await activeTools.get('bili_fav_run').execute({ message: 'audit only' }, {})
    assert.equal(run.batch.id, 'turn-1')
    assert.equal(run.next.cursor, 1)

    const second = await activeTools.get('bili_fav_recommend').execute({}, {})
    assert.equal(second.batch.id, 'turn-2')
    assert.equal(second.next.cursor, 2)

    const state = await invoke(handler, { url: '/api/bili-audit/status' })
    assert.equal(state.body.status.trajectory.source, 'perturbation')
    assert.equal(state.body.status.trajectory.id, 'higher-social-proof')
    assert.equal(state.body.status.trajectory.inlineReplies, 1)

    disposeAll(lifecycle)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
