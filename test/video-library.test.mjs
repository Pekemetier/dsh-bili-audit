import test from 'node:test'
import assert from 'node:assert/strict'

import {
  lookupVideo,
  mergeDeep,
  normalizeVideoLibrary,
  resolveVideoEntry,
} from '../lib/video-library.js'

const baseLibrary = {
  name: 'test library',
  videos: {
    'why_food_eat.less_star': {
      recommendation: { title: 'original title', stats: { views: 10 } },
      watch: { content: [{ type: 'text', text: 'original watch text' }] },
    },
    'city_night.warm_tone': {
      recommendation: { title: 'city' },
      watch: { content: [] },
    },
  },
}

test('normalizes a map keyed by mixed video/perturbation ids', () => {
  const library = normalizeVideoLibrary(baseLibrary)
  assert.equal(library.name, 'test library')
  assert.deepEqual(Object.keys(library.videos).sort(), [
    'city_night.warm_tone',
    'why_food_eat.less_star',
  ])
  assert.equal(library.videos['why_food_eat.less_star'].id, 'why_food_eat.less_star')
  assert.equal(library.videos['why_food_eat.less_star'].recommendation.title, 'original title')
  assert.equal(library.videos['why_food_eat.less_star'].watch.content[0].text, 'original watch text')
})

test('normalizes array libraries and copies the explicit id', () => {
  const library = normalizeVideoLibrary({
    videos: [
      { id: 'repair_culture.no_intro', recommendation: { title: 'repair' } },
      { id: 'city_night.cold_tone', watch: { subtitles: ['cold'] } },
    ],
  })
  assert.deepEqual(Object.keys(library.videos), ['repair_culture.no_intro', 'city_night.cold_tone'])
  assert.deepEqual(library.videos['city_night.cold_tone'].watch, { subtitles: ['cold'] })
})

test('lookup rejects unknown and missing ids', () => {
  const library = normalizeVideoLibrary(baseLibrary)
  assert.equal(lookupVideo(library, 'why_food_eat.less_star').id, 'why_food_eat.less_star')
  assert.throws(() => lookupVideo(library, 'missing.id'), /找不到 id/)
  assert.throws(() => lookupVideo(library, ''), /缺少视频 id/)
})

test('id references deep-merge overrides and keep the original id', () => {
  const library = normalizeVideoLibrary(baseLibrary)
  const video = resolveVideoEntry(library, {
    id: 'why_food_eat.less_star',
    recommendation: { title: 'overridden title', stats: { likes: 5 } },
    watch: { note: 'extra watch note' },
  })
  assert.equal(video.id, 'why_food_eat.less_star')
  assert.equal(video.recommendation.title, 'overridden title')
  assert.equal(video.recommendation.stats.views, 10)
  assert.equal(video.recommendation.stats.likes, 5)
  assert.equal(video.watch.content[0].text, 'original watch text')
  assert.equal(video.watch.note, 'extra watch note')
})

test('a video can be fully inline without entering the library', () => {
  const library = normalizeVideoLibrary(baseLibrary)
  const video = resolveVideoEntry(
    library,
    {
      recommendation: { title: 'inline recommendation' },
      watch: { content: [{ type: 'text', text: 'inline watch' }] },
    },
    { fallbackId: 'inline-batch-1' },
  )
  assert.equal(video.id, 'inline-batch-1')
  assert.equal(video.recommendation.title, 'inline recommendation')
  assert.equal(video.watch.content[0].text, 'inline watch')
})

test('deep merge treats arrays as replacement values', () => {
  assert.deepEqual(mergeDeep({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } }), {
    a: [3],
    b: { c: 1, d: 2 },
  })
})

test('invalid libraries fail with actionable errors', () => {
  assert.throws(() => normalizeVideoLibrary({ videos: {} }), /视频库为空/)
  assert.throws(() => normalizeVideoLibrary({ videos: [{ title: 'missing id' }] }), /缺少 id/)
  assert.throws(
    () => normalizeVideoLibrary({ videos: [{ id: 'same' }, { id: 'same' }] }),
    /重复/,
  )
})
