import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BiliCrawlError,
  RequestPacer,
  crawlBilibili,
  readExistingVideos,
  writeCrawledVideos,
} from '../scripts/crawl-bilibili.mjs'
import { readJsonStrict, writeJson } from '../lib/util.js'
import { videoFilePath } from '../lib/video-library.js'

const WBI_IMG = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'
const WBI_SUB = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return JSON.stringify(payload)
    },
  }
}

function feedItem({ bvid, aid, cid, title }) {
  return {
    goto: 'av',
    bvid,
    id: aid,
    cid,
    title,
    pic: '//i0.hdslb.com/bfs/archive/example.jpg',
    duration: 120,
    pubdate: 1_700_000_000,
    owner: { name: 'tester', mid: 42 },
    stat: {
      view: 1000,
      like: 100,
      danmaku: 10,
      reply: 20,
      favorite: 30,
      coin: 40,
      share: 5,
    },
    rcmd_reason: '因为你常看测试',
    track_id: 'track-1',
  }
}

function detailFor({ bvid, id, aid = id, cid, title }) {
  return {
    aid,
    cid,
    bvid,
    title,
    desc: `${title}的描述`,
    pic: '//i0.hdslb.com/bfs/archive/detail.jpg',
    duration: 120,
    pubdate: 1_700_000_000,
    owner: { name: 'tester', mid: 42 },
    tname: '测试',
    stat: {
      view: 1100,
      like: 110,
      danmaku: 11,
      reply: 21,
      favorite: 31,
      coin: 41,
      share: 6,
    },
  }
}

test('request pacer enforces the 1000ms hard floor and spaces requests', async () => {
  assert.throws(() => new RequestPacer({ minIntervalMs: 999 }), /不得低于 1000ms/)

  let now = 0
  const sleeps = []
  const pacer = new RequestPacer({
    minIntervalMs: 1000,
    jitterMs: 0,
    now: () => now,
    sleepImpl: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
  })
  await pacer.wait()
  await pacer.wait()
  await pacer.wait()
  assert.deepEqual(sleeps, [1000, 1000])
})

test('crawler returns sparse per-video records and never sends cookies to the subtitle CDN', async () => {
  const calls = []
  const item = feedItem({ bvid: 'BV1xx411c7mD', aid: 100, cid: 200, title: '测试视频' })
  const detail = detailFor(item)
  const fetchImpl = async (input, options) => {
    const url = String(input)
    calls.push({ url, options })
    if (url.includes('/x/web-interface/nav')) {
      return jsonResponse({ code: 0, data: { wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB } } })
    }
    if (url.includes('/x/web-interface/wbi/index/top/feed/rcmd')) {
      return jsonResponse({ code: 0, data: { item: [item] } })
    }
    if (url.includes('/x/web-interface/view')) {
      return jsonResponse({ code: 0, data: detail })
    }
    if (url.includes('/x/tag/archive/tags')) {
      return jsonResponse({ code: 0, data: [{ tag_name: '标签一' }, { tag_name: '标签二' }] })
    }
    if (url.includes('/x/player/wbi/v2')) {
      return jsonResponse({
        code: 0,
        data: {
          subtitle: {
            subtitles: [{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/one.json' }],
          },
        },
      })
    }
    if (url.includes('aisubtitle.hdslb.com')) {
      return jsonResponse({ body: [{ content: '第一行字幕' }, { content: '第二行字幕' }] })
    }
    throw new Error(`unexpected mock URL: ${url}`)
  }

  const result = await crawlBilibili({
    fetchImpl,
    pages: 1,
    ps: 1,
    maxVideos: 1,
    intervalMs: 1000,
    jitterMs: 0,
    withSubtitles: true,
    cookie: 'SESSDATA=secret-cookie',
    now: () => 0,
    sleepImpl: async () => {},
    random: () => 0,
    logger: { info() {}, warn() {} },
  })

  assert.equal(result.added, 1)
  assert.equal(result.skipped, 0)
  assert.equal('document' in result, false)
  const record = result.records[0]
  assert.equal(record.id, 'video-bv1xx411c7md')
  assert.deepEqual(record.perturbations, {})
  assert.equal(record.recommendation.title, '测试视频')
  assert.deepEqual(record.recommendation.tags, undefined)
  assert.deepEqual(record.watch.tags, ['标签一', '标签二'])
  assert.deepEqual(record.watch.subtitles, ['第一行字幕', '第二行字幕'])
  assert.equal(record.watch.subtitle.available, true)
  assert.ok(calls.every((call) => call.options.redirect === 'error'))

  const subtitleCall = calls.find((call) => call.url.includes('aisubtitle.hdslb.com'))
  assert.ok(subtitleCall)
  assert.equal(subtitleCall.options.headers.Cookie, undefined)
  assert.ok(
    calls
      .filter((call) => call.url !== subtitleCall.url)
      .every((call) => call.options.headers.Cookie === 'SESSDATA=secret-cookie'),
  )
})

test('412 and 429 stop immediately without retrying', async () => {
  for (const status of [412, 429]) {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return jsonResponse({ code: -412, message: 'blocked' }, status)
    }
    await assert.rejects(
      crawlBilibili({
        fetchImpl,
        intervalMs: 1000,
        jitterMs: 0,
        now: () => 0,
        sleepImpl: async () => {},
        random: () => 0,
        logger: { info() {}, warn() {} },
      }),
      (error) => error instanceof BiliCrawlError && error.fatal && error.status === status,
    )
    assert.equal(calls, 1)
  }
})

test('5xx responses are retried at most twice with backoff', async () => {
  let feedCalls = 0
  const sleeps = []
  const item = feedItem({ bvid: 'BV1retry00001', aid: 101, cid: 201, title: '重试视频' })
  const detail = detailFor(item)
  const fetchImpl = async (input) => {
    const url = String(input)
    if (url.includes('/x/web-interface/nav')) {
      return jsonResponse({ code: 0, data: { wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB } } })
    }
    if (url.includes('/x/web-interface/wbi/index/top/feed/rcmd')) {
      feedCalls += 1
      if (feedCalls < 3) return jsonResponse({ code: -1 }, 503)
      return jsonResponse({ code: 0, data: { item: [item] } })
    }
    if (url.includes('/x/web-interface/view')) return jsonResponse({ code: 0, data: detail })
    if (url.includes('/x/tag/archive/tags')) return jsonResponse({ code: 0, data: [] })
    throw new Error(`unexpected mock URL: ${url}`)
  }

  const result = await crawlBilibili({
    fetchImpl,
    pages: 1,
    ps: 1,
    maxVideos: 1,
    intervalMs: 1000,
    jitterMs: 0,
    now: () => 0,
    sleepImpl: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0,
    logger: { info() {}, warn() {} },
  })

  assert.equal(feedCalls, 3)
  assert.equal(result.added, 1)
  assert.ok(sleeps.includes(800))
  assert.ok(sleeps.includes(1600))
})

test('resume skips known BVIDs and writes new videos without altering existing perturbations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bili-audit-crawl-'))
  try {
    const existingRecord = {
      schemaVersion: 3,
      id: 'video-bvold000001',
      bvid: 'BVOLD000001',
      recommendation: { title: '已有视频' },
      watch: { content: [] },
      perturbations: {
        manual: { recommendation: { title: '人工扰动' } },
      },
    }
    writeJson(videoFilePath(directory, existingRecord.id), existingRecord)
    const existingRecords = readExistingVideos(directory)
    assert.equal(existingRecords.length, 1)
    assert.equal(existingRecords[0].id, existingRecord.id)

    const oldItem = feedItem({ bvid: 'BVOLD000001', aid: 300, cid: 400, title: '已有视频' })
    const newItem = feedItem({ bvid: 'BVNEW000001', aid: 301, cid: 401, title: '新视频' })
    const newDetail = detailFor(newItem)
    const requested = []
    const fetchImpl = async (input) => {
      const url = String(input)
      requested.push(url)
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({ code: 0, data: { wbi_img: { img_url: WBI_IMG, sub_url: WBI_SUB } } })
      }
      if (url.includes('/x/web-interface/wbi/index/top/feed/rcmd')) {
        return jsonResponse({ code: 0, data: { item: [oldItem, newItem] } })
      }
      if (url.includes('/x/web-interface/view') && url.includes('BVNEW000001')) {
        return jsonResponse({ code: 0, data: newDetail })
      }
      if (url.includes('/x/tag/archive/tags') && url.includes('BVNEW000001')) {
        return jsonResponse({ code: 0, data: [{ tag_name: '新标签' }] })
      }
      throw new Error(`unexpected mock URL: ${url}`)
    }

    const result = await crawlBilibili({
      fetchImpl,
      pages: 1,
      ps: 2,
      maxVideos: 2,
      intervalMs: 1000,
      jitterMs: 0,
      existingRecords,
      now: () => 0,
      sleepImpl: async () => {},
      random: () => 0,
      logger: { info() {}, warn() {} },
    })

    assert.equal(result.added, 1)
    assert.equal(result.skipped, 1)
    assert.equal(requested.some((url) => url.includes('BVOLD000001')), false)
    assert.equal(requested.some((url) => url.includes('BVNEW000001')), true)

    const written = writeCrawledVideos(directory, result.records)
    assert.equal(written.length, 1)
    assert.equal(written[0], videoFilePath(directory, 'video-bvnew000001'))
    assert.ok(existsSync(videoFilePath(directory, 'video-bvnew000001')))

    const preserved = readJsonStrict(videoFilePath(directory, 'video-bvold000001'))
    assert.deepEqual(preserved.perturbations, existingRecord.perturbations)
    const added = readJsonStrict(videoFilePath(directory, 'video-bvnew000001'))
    assert.deepEqual(added.perturbations, {})
    assert.equal(added.watch.tags[0], '新标签')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('file collisions with a different BVID are rejected even under force', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bili-audit-crawl-'))
  try {
    const file = videoFilePath(directory, 'video-bv1collision')
    writeJson(file, {
      schemaVersion: 3,
      id: 'video-bv1collision',
      bvid: 'BVOCUPIED001',
      recommendation: { title: 'occupied' },
      watch: { content: [] },
      perturbations: { manual: { recommendation: { title: 'keep me' } } },
    })

    assert.throws(
      () => writeCrawledVideos(
        directory,
        [{
          schemaVersion: 3,
          id: 'video-bv1collision',
          bvid: 'BVNEW001',
          recommendation: { title: 'collision' },
          watch: { content: [] },
          perturbations: {},
        }],
        { force: true },
      ),
      /文件名冲突/,
    )
    assert.equal(readJsonStrict(file).bvid, 'BVOCUPIED001')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
