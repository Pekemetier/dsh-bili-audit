import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listVideoFiles,
  loadVideoLibrary,
  lookupVideo,
  mergeDeep,
  normalizeVideoFile,
  normalizeVideoLibrary,
  resolveVideoEntry,
  videoFilePath,
} from '../lib/video-library.js'
import { writeJson } from '../lib/util.js'

const layeredLibrary = {
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
          recommendation: { title: 'popular title', tags: ['popular'] },
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
  assert.equal(library.schemaVersion, 3)
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

test('loads one video file per base video from a directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bili-audit-videos-'))
  try {
    mkdirSync(directory, { recursive: true })
    writeJson(join(directory, 'why_food_eat.json'), {
      schemaVersion: 3,
      id: 'why_food_eat',
      ...layeredLibrary.videos.why_food_eat,
    })
    writeJson(join(directory, 'city_night.json'), {
      schemaVersion: 3,
      id: 'city_night',
      ...layeredLibrary.videos.city_night,
    })
    const files = listVideoFiles(directory)
    assert.deepEqual(files.map((entry) => entry.id), ['city_night', 'why_food_eat'])

    const library = loadVideoLibrary(directory)
    assert.equal(library.baseVideoCount, 2)
    assert.equal(Object.keys(library.videos).length, 4)
    assert.equal(library.videos['why_food_eat.more_fan'].recommendation.title, 'popular title')
    assert.equal(library.sourceFiles.why_food_eat, join(directory, 'why_food_eat.json'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('single video files enforce a safe filename id and reject collections', () => {
  const checked = normalizeVideoFile(
    { schemaVersion: 3, id: 'repair_culture', recommendation: { title: 'repair' } },
    'repair_culture',
  )
  assert.equal(checked.id, 'repair_culture')
  assert.equal(checked.document.schemaVersion, 3)
  assert.throws(
    () => normalizeVideoFile({ id: 'other', recommendation: {} }, 'repair_culture'),
    /文件名不一致/,
  )
  assert.throws(() => normalizeVideoFile({ videos: { repair: { recommendation: {} } } }), /不能包含 videos/)
  assert.throws(() => videoFilePath('videos', 'CON'), /保留文件名/)
  assert.throws(() => videoFilePath('videos', '../escape'), /不能用于文件名/)
  assert.throws(() => videoFilePath('videos', 'bad/name'), /不能用于文件名/)
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
    () => normalizeVideoLibrary({ videos: [{ id: 'duplicate' }, { id: 'duplicate' }] }),
    /id 重复/,
  )
})
