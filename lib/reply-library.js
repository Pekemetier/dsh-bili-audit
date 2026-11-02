/** Reusable local reply/context records referenced by trajectory batches. */
import { readJsonStrict } from './util.js'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanReplyId(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

function normalizeReply(raw, fallbackId = '') {
  if (!isRecord(raw)) throw new Error(`回复 ${fallbackId || '(缺少 id)'} 必须是对象`)
  const id = cleanReplyId(raw.id) || fallbackId
  if (!id) throw new Error('回复库中存在缺少 id 的条目')
  const text = typeof raw.text === 'string'
    ? raw.text
    : typeof raw.content === 'string'
      ? raw.content
      : ''
  return {
    ...raw,
    id,
    role: typeof raw.role === 'string' ? raw.role.trim().slice(0, 40) : 'assistant',
    text,
  }
}

/** Accepts a `replies` map/array, a bare map, or an empty reply database. */
export function normalizeReplyLibrary(input) {
  if (!isRecord(input)) throw new Error('回复库根节点必须是 JSON 对象')
  const source = input.replies ?? input.items
  const replies = {}
  const add = (item) => {
    if (replies[item.id]) throw new Error(`回复 id 重复：${item.id}`)
    replies[item.id] = item
  }
  if (Array.isArray(source)) {
    for (const raw of source) add(normalizeReply(raw))
  } else if (isRecord(source)) {
    for (const [key, raw] of Object.entries(source)) {
      if (key === 'schemaVersion' || key === 'name' || key === 'description') continue
      if (!isRecord(raw)) continue
      add(normalizeReply(raw, cleanReplyId(key)))
    }
  } else if (source === undefined) {
    const bare = Object.fromEntries(Object.entries(input).filter(([key]) => !['schemaVersion', 'name', 'description'].includes(key)))
    for (const [key, raw] of Object.entries(bare)) {
      if (isRecord(raw)) add(normalizeReply(raw, cleanReplyId(key)))
    }
  } else {
    throw new Error('回复库必须包含 replies 对象或数组')
  }
  return {
    schemaVersion: 1,
    name: typeof input.name === 'string' ? input.name.trim().slice(0, 200) : '',
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 2000) : '',
    replies,
  }
}

export function loadReplyLibrary(file) {
  return normalizeReplyLibrary(readJsonStrict(file))
}

export function lookupReply(library, id) {
  const key = cleanReplyId(id)
  if (!key) throw new Error('缺少回复 id')
  const found = library?.replies?.[key]
  if (!found) throw new Error(`回复库中找不到 id：${key}`)
  return found
}

export function resolveReplyEntry(library, entry, { fallbackId = '' } = {}) {
  if (typeof entry === 'string') return lookupReply(library, entry)
  if (!isRecord(entry)) throw new Error(`轨迹回复条目必须是字符串或对象：${fallbackId}`)
  const reference = cleanReplyId(entry.replyId) || cleanReplyId(entry.id)
  if (reference) {
    const base = lookupReply(library, reference)
    const { id: _id, replyId: _replyId, ...override } = entry
    return { ...base, ...override, id: base.id }
  }
  return normalizeReply({ ...entry, id: cleanReplyId(entry.id) || fallbackId || 'inline-reply' })
}
