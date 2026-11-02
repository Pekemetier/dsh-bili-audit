import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../index.js'
import { loadConfig } from '../lib/store.js'

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
  const home = mkdtempSync(join(tmpdir(), 'bili-fav-tools-'))
  try {
    const { ctx, activeTools, handlers, lifecycle } = makeContext(home)
    apply(ctx)
    assert.deepEqual([...activeTools.keys()], ['bili_fav_recommend'])

    const handler = handlers[0].handler
    const enabled = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-fav/config',
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

    const status = await invoke(handler, { url: '/api/bili-fav/status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.toolChoiceRequired, true)

    const disabled = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-fav/config',
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
  const home = mkdtempSync(join(tmpdir(), 'bili-fav-tools-'))
  try {
    const { ctx, activeTools, lifecycle } = makeContext(home)
    apply(ctx)
    const tool = activeTools.get('bili_fav_recommend')

    const first = await tool.execute({ message: 'ignore this preference' }, {})
    assert.equal(first.ok, true)
    assert.equal(first.deterministic, true)
    assert.equal(first.batch.id, 'turn-1')

    const selected = await tool.execute(
      { action: 'select', batchId: 'turn-1', selected: ['why_food_eat.less_star'] },
      {},
    )
    assert.equal(selected.ok, true)
    assert.equal(selected.cursor, 1)

    const second = await tool.execute({ message: 'choose anything else' }, {})
    assert.equal(second.batch.id, 'turn-2')
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

test('saving a trajectory database falls back when the configured id was removed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bili-fav-tools-'))
  try {
    const { ctx, handlers, lifecycle } = makeContext(home)
    apply(ctx)
    const handler = handlers[0].handler

    const selected = await invoke(handler, {
      method: 'POST',
      url: '/api/bili-fav/config',
      body: { trajectoryId: 'semantic-perturbation-demo' },
    })
    assert.equal(selected.status, 200)

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
      url: '/api/bili-fav/trajectory',
      body: { document: replacement },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.trajectoryId, 'replacement')
    assert.equal(saved.body.switchedFromMissingId, 'semantic-perturbation-demo')
    assert.equal(loadConfig(home).trajectoryId, 'replacement')

    const status = await invoke(handler, { url: '/api/bili-fav/status' })
    assert.equal(status.body.status.trajectory.id, 'replacement')
    assert.equal(status.body.status.trajectory.batches, 1)

    for (const dispose of lifecycle.reverse()) dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
