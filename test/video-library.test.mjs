import test from 'node:test'
import assert from 'node:assert/strict'

import {
  lookupVideo,
  mergeDeep,
  normalizeVideoLibrary,
  resolveVideoEntry,
} from '../lib/video-library.js'

const layeredLibrary = {
  name: 'test library',
  videos: {
    why_food_eat: {
      recommendation: {
        title: 'original title',
        stats: { views: 10, likes: 1 },
        tags: ['food', 'life'],
      },
      watch: {
        content: [{ type: 'text', text: 'original watch text' }],
        subtitles: ['original subtitle'],
      },
      perturbations: {
        less_star: {
          recommendation: { stats: { views: 3 } },
        },
        more_fan: {
          recommendation: {
            title: 'popular title',
            tags: ['popular'],
          },
          watch: { subtitles: ['perturbed subtitle'] },
        },
      },
    },
    city_night: {
      recommendation: { title: 'city' },
      watch: { content: [] },
      perturbations: {},
    },
  },
}

test('expands a base video and its sparse perturbation patches into mixed ids', () => {
  const library = normalizeVideoLibrary(layeredLibrary)
  assert.equal(library.schemaVersion, 2)
  assert.deepEqual(Object.keys(library.videos).sort(), [
    'city_night',
    'why_food_eat',
    'why_food_eat.less_star',
    'why_food_eat.more_fan',
  ])

  const base = library.videos.why_food_eat
  const lessStar = library.videos['why_food_eat.less_star']
  assert.equal(base.recommendation.title, 'original title')
  assert.deepEqual(base.lineage, { baseId: 'why_food_eat', perturbationId: '' })
  assert.equal(lessStar.recommendation.title, 'original title')
  assert.deepEqual(lessStar.recommendation.stats, { views: 3, likes: 1 })
  assert.deepEqual(lessStar.recommendation.tags, ['food', 'life'])
  assert.deepEqual(lessStar.lineage, { baseId: 'why_food_eat', perturbationId: 'less_star' })

  const moreFan = library.videos['why_food_eat.more_fan']
  assert.equal(moreFan.recommendation.title, 'popular title')
  assert.deepEqual(moreFan.recommendation.tags, ['popular'])
  assert.deepEqual(moreFan.watch.subtitles, ['perturbed subtitle'])
  assert.equal(moreFan.watch.content[0].text, 'original watch text')
})

test('keeps legacy flat mixed ids working', () => {
  const library = normalizeVideoLibrary({
    videos: {
      'repair_culture.no_intro': {
        recommendation: { title: 'repair' },
        watch: { subtitles: ['direct repair'] },
      },
    },
  })
  assert.equal(library.videos['repair_culture.no_intro'].id, 'repair_culture.no_intro')
})

test('accepts array libraries and copies explicit ids', () => {
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
  const library = normalizeVideoLibrary(layeredLibrary)
  assert.equal(lookupVideo(library, 'why_food_eat.less_star').id, 'why_food_eat.less_star')
  assert.throws(() => lookupVideo(library, 'missing.id'), /找不到 id/)
  assert.throws(() => lookupVideo(library, ''), /缺少视频 id/)
})

test('id references deep-merge overrides and keep the original id', () => {
  const library = normalizeVideoLibrary(layeredLibrary)
  const video = resolveVideoEntry(library, {
    id: 'why_food_eat.less_star',
    recommendation: { title: 'overridden title', stats: { likes: 5 } },
    watch: { note: 'extra watch note' },
  })
  assert.equal(video.id, 'why_food_eat.less_star')
  assert.equal(video.recommendation.title, 'overridden title')
  assert.deepEqual(video.recommendation.stats, { views: 3, likes: 5 })
  assert.equal(video.watch.content[0].text, 'original watch text')
  assert.equal(video.watch.note, 'extra watch note')
})

test('a video can be fully inline without entering the library', () => {
  const library = normalizeVideoLibrary(layeredLibrary)
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
  assert.throws(
    () => normalizeVideoLibrary({ videos: { base: { perturbations: { nested: { perturbations: {} } } } } }),
    /不允许再嵌套/,
  )
})
