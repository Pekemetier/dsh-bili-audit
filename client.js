/**
 * Settings page for the local layered recommendation-selection audit.
 *
 * Four JSON databases are edited independently: videos with sparse
 * perturbation patches, reusable replies, base trajectories, and sparse
 * perturbation trajectories. The page never talks to Bilibili or an LLM.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-audit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React
    const API = '/api/bili-audit'

    const CSS = `
[data-ba-page]{display:flex;flex-direction:column;gap:14px;max-width:980px;padding:2px 2px 28px;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;}
[data-ba-title]{display:flex;align-items:center;gap:8px;font-size:17px;line-height:24px;font-weight:600;}
[data-ba-badge]{font-size:10px;line-height:16px;font-weight:500;padding:1px 6px;border-radius:5px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}
[data-ba-sub],[data-ba-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);}
[data-ba-card]{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));}
[data-ba-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-ba-grid]{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
[data-ba-field]{display:flex;flex-direction:column;gap:5px;min-width:0;}
[data-ba-label]{font-size:12px;font-weight:600;}
[data-ba-select],[data-ba-input],[data-ba-textarea]{box-sizing:border-box;width:100%;border-radius:8px;font:inherit;
  color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);}
[data-ba-select],[data-ba-input]{height:32px;padding:5px 9px;font-size:12px;}
[data-ba-textarea]{padding:9px;min-height:250px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:17px;resize:vertical;}
[data-ba-select]:focus,[data-ba-input]:focus,[data-ba-textarea]:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
[data-ba-btn]{height:30px;padding:0 12px;border-radius:8px;font:inherit;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);}
[data-ba-btn][data-primary]{color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base));
  background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}
[data-ba-btn][data-danger]{color:var(--dsw-alias-state-error-primary);}
[data-ba-btn]:disabled{opacity:.45;cursor:default;}
[data-ba-msg]{padding:8px 10px;border-radius:8px;font-size:11px;line-height:17px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}
[data-ba-error]{color:var(--dsw-alias-state-error-primary);}
[data-ba-stats]{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:8px;}
[data-ba-stat]{padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);}
[data-ba-stat b]{display:block;font-size:16px;line-height:22px;}
[data-ba-stat span]{font-size:10px;color:var(--dsw-alias-label-secondary);}
[data-ba-code]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;word-break:break-all;
  color:var(--dsw-alias-label-secondary);}
[data-ba-events]{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px;max-height:190px;overflow:auto;}
[data-ba-events] li{padding:6px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:10px;}
@media(max-width:640px){[data-ba-grid],[data-ba-stats]{grid-template-columns:1fr;}}
`

    async function asJson(response) {
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      return data
    }

    const getJson = (path) => fetch(API + path, { credentials: 'same-origin' }).then(asJson)
    const postJson = (path, body) =>
      fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(asJson)

    function pretty(value) {
      return JSON.stringify(value, null, 2)
    }

    function parseDocument(text, label) {
      try {
        return JSON.parse(text)
      } catch (error) {
        throw new Error(`${label}不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    function Panel() {
      const [status, setStatus] = useState(null)
      const [libraryText, setLibraryText] = useState('')
      const [replyText, setReplyText] = useState('')
      const [baseText, setBaseText] = useState('')
      const [perturbationText, setPerturbationText] = useState('')
      const [toolMode, setToolMode] = useState('recommend-only')
      const [baseId, setBaseId] = useState('')
      const [perturbationId, setPerturbationId] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)

      const load = useCallback(async (clearNotice = true) => {
        setBusy('load')
        try {
          const data = await getJson('/status')
          setStatus(data)
          setLibraryText(pretty(data.libraryDocument))
          setReplyText(pretty(data.replyLibraryDocument))
          setBaseText(pretty(data.baseTrajectoryDocument))
          setPerturbationText(pretty(data.perturbationTrajectoryDocument))
          setToolMode(data.config?.toolMode || 'recommend-only')
          setBaseId(data.config?.baseTrajectoryId || '')
          setPerturbationId(data.config?.perturbationTrajectoryId || '')
          if (clearNotice) setNotice(null)
        } catch (error) {
          setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const run = async (name, task) => {
        setBusy(name)
        try {
          await task()
          await load(false)
        } catch (error) {
          setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const saveConfig = () =>
        run('config', async () => {
          await postJson('/config', {
            toolMode,
            baseTrajectoryId: baseId.trim(),
            perturbationTrajectoryId: perturbationId.trim(),
          })
          setNotice({ type: 'ok', text: '工具模式与 base/扰动轨迹选择已保存。' })
        })

      const saveDatabase = (name, endpoint, text, label, successText) =>
        run(name, async () => {
          const document = parseDocument(text, label)
          await postJson(endpoint, { document })
          setNotice({ type: 'ok', text: successText })
        })

      const saveLibrary = () =>
        saveDatabase('library', '/video-library', libraryText, '视频库', '视频（含扰动）数据库已保存。')

      const saveReplies = () =>
        saveDatabase('replies', '/reply-library', replyText, '回复数据库', '回复数据库已保存。')

      const saveBase = () =>
        saveDatabase(
          'base',
          '/base-trajectories',
          baseText,
          'base 轨迹数据库',
          'base 轨迹数据库已保存；轨迹内容变化后会从新 fingerprint 的游标开始。',
        )

      const savePerturbation = () =>
        saveDatabase(
          'perturbation',
          '/perturbation-trajectories',
          perturbationText,
          '扰动轨迹数据库',
          '扰动轨迹数据库已保存；未写出的批次与字段会继承 base。',
        )

      const reset = (scope) =>
        run(`reset-${scope}`, async () => {
          await postJson('/reset', { scope })
          setNotice({ type: 'ok', text: scope === 'all' ? '所有轨迹游标与审计记录已重置。' : '当前轨迹游标与审计记录已重置。' })
        })

      const trajectory = status?.status?.trajectory
      const library = status?.status?.library
      const events = status?.status?.recentEvents || []
      const selections = status?.status?.recentSelections || []
      const baseIds = status?.baseTrajectoryIds || []
      const perturbationIds = status?.perturbationTrajectoryIds || []

      return h(
        'div',
        { 'data-ba-page': '' },
        h(
          'div',
          null,
          h('div', { 'data-ba-title': '' }, '推荐流选择审计', h('span', { 'data-ba-badge': '' }, `v${status?.version || '?'}`)),
          h('div', { 'data-ba-sub': '' }, '运行时只回放本地数据。模型凭据由 DSH provider 管理，不写入这里；采集脚本只在显式运行且限速时访问 B站。'),
        ),
        notice ? h('div', { 'data-ba-msg': '', 'data-ba-error': notice.type === 'error' ? '' : undefined }, notice.text) : null,
        h(
          'div',
          { 'data-ba-card': '' },
          h(
            'div',
            { 'data-ba-stats': '' },
            h('div', { 'data-ba-stat': '' }, h('b', null, trajectory?.cursor ?? 0), h('span', null, '已返回批次')),
            h('div', { 'data-ba-stat': '' }, h('b', null, trajectory?.remaining ?? 0), h('span', null, '剩余批次')),
            h('div', { 'data-ba-stat': '' }, h('b', null, library?.videos ?? 0), h('span', null, '展开后视频条目')),
            h('div', { 'data-ba-stat': '' }, h('b', null, library?.replies ?? 0), h('span', null, '回复条目')),
          ),
          h('div', { 'data-ba-note': '' }, `当前解析轨迹：${trajectory?.name || trajectory?.id || '—'} · ${trajectory?.source || '—'} · fingerprint ${trajectory?.fingerprint || '—'}`),
          h('div', { 'data-ba-note': '' }, status?.prompt || ''),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, `视频库：${status?.files?.library || ''}`),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, `回复库：${status?.files?.replyLibrary || ''}`),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, `base 轨迹：${status?.files?.baseTrajectory || ''}`),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, `扰动轨迹：${status?.files?.perturbationTrajectory || ''}`),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '工具暴露模式'),
          h(
            'div',
            { 'data-ba-grid': '' },
            h(
              'label',
              { 'data-ba-field': '' },
              h('span', { 'data-ba-note': '' }, 'toolMode'),
              h(
                'select',
                { 'data-ba-select': '', value: toolMode, onChange: (event) => setToolMode(event.target.value) },
                h('option', { value: 'recommend-only' }, '只允许 bili_fav_recommend'),
                h('option', { value: 'all' }, '允许 recommend / preview / run / status'),
              ),
            ),
            h(
              'label',
              { 'data-ba-field': '' },
              h('span', { 'data-ba-note': '' }, 'base 轨迹 id（留空则用 activeTrajectory 或第一个）'),
              h('input', {
                'data-ba-input': '',
                list: 'ba-base-ids',
                value: baseId,
                placeholder: baseIds[0] || 'baseline',
                onChange: (event) => setBaseId(event.target.value),
              }),
              h('datalist', { id: 'ba-base-ids' }, baseIds.map((id) => h('option', { key: id, value: id }))),
            ),
            h(
              'label',
              { 'data-ba-field': '' },
              h('span', { 'data-ba-note': '' }, '扰动轨迹 id（留空则不应用扰动）'),
              h('input', {
                'data-ba-input': '',
                list: 'ba-perturbation-ids',
                value: perturbationId,
                placeholder: perturbationIds[0] || 'higher-social-proof',
                onChange: (event) => setPerturbationId(event.target.value),
              }),
              h('datalist', { id: 'ba-perturbation-ids' }, perturbationIds.map((id) => h('option', { key: id, value: id }))),
            ),
          ),
          h(
            'div',
            { 'data-ba-row': '' },
            h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveConfig }, '保存模式与轨迹'),
            h('button', { 'data-ba-btn': '', disabled: Boolean(busy), onClick: () => reset('active') }, '重置当前轨迹游标'),
            h('button', { 'data-ba-btn': '', 'data-danger': '', disabled: Boolean(busy), onClick: () => reset('all') }, '重置全部'),
            h('button', { 'data-ba-btn': '', disabled: Boolean(busy), onClick: () => load() }, '重新读取'),
          ),
          h('div', { 'data-ba-note': '' }, 'recommend-only 时模型无需选择工具，直接调用 bili_fav_recommend；all 时额外暴露 preview、run、status。'),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '1 · 视频（含扰动）数据库'),
          h('div', { 'data-ba-note': '' }, '基础视频保存共享的 recommendation/watch；perturbations 仅写增量，展开 id 为 <基础id>.<扰动代号>。'),
          h('textarea', {
            'data-ba-textarea': '',
            value: libraryText,
            spellCheck: false,
            onChange: (event) => setLibraryText(event.target.value),
          }),
          h('div', { 'data-ba-row': '' }, h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveLibrary }, '保存视频库')),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '2 · 回复数据库'),
          h('div', { 'data-ba-note': '' }, '保存可复用的非模型回复/上下文。轨迹批次只写 reply id，需要局部修改时再写覆盖字段。'),
          h('textarea', {
            'data-ba-textarea': '',
            value: replyText,
            spellCheck: false,
            onChange: (event) => setReplyText(event.target.value),
          }),
          h('div', { 'data-ba-row': '' }, h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveReplies }, '保存回复库')),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '3 · base 轨迹数据库'),
          h('div', { 'data-ba-note': '' }, 'batches 顺序就是固定未来流。视频和回复尽量只写数据库 id；局部覆盖直接写在对应条目中。'),
          h('textarea', {
            'data-ba-textarea': '',
            value: baseText,
            spellCheck: false,
            onChange: (event) => setBaseText(event.target.value),
          }),
          h('div', { 'data-ba-row': '' }, h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveBase }, '保存 base 轨迹')),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '4 · 扰动轨迹数据库'),
          h('div', { 'data-ba-note': '' }, '使用 extends + patches/removeBatches/addBatches 只记录变化；对象深合并，数组整体替换。'),
          h('textarea', {
            'data-ba-textarea': '',
            value: perturbationText,
            spellCheck: false,
            onChange: (event) => setPerturbationText(event.target.value),
          }),
          h('div', { 'data-ba-row': '' }, h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: savePerturbation }, '保存扰动轨迹')),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '最近固定批次事件'),
          events.length
            ? h(
                'ul',
                { 'data-ba-events': '' },
                events.map((event) =>
                  h(
                    'li',
                    { key: event.id },
                    `${event.at || ''} · ${event.type} · ${event.batchId || ''} · batch ${event.batchIndex ?? ''}${event.message ? ` · ${event.message}` : ''}`,
                  ),
                ),
              )
            : h('div', { 'data-ba-note': '' }, '还没有调用记录。'),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '最近模型选择'),
          selections.length
            ? h(
                'ul',
                { 'data-ba-events': '' },
                selections.map((selection) =>
                  h(
                    'li',
                    { key: selection.id },
                    `${selection.at || ''} · ${selection.batchId || ''} · ${
                      selection.selected?.length
                        ? selection.selected
                            .map((item) => `${item.videoId}${item.reason ? `：${item.reason}` : ''}`)
                            .join('；')
                        : '未选择任何视频'
                    }`,
                  ),
                ),
              )
            : h('div', { 'data-ba-note': '' }, '还没有选择记录。'),
        ),
        h('div', { 'data-ba-note': '', 'data-ba-code': '' }, status?.logTail || ''),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        ctx.effect(
          () =>
            slots.inject('settings.section', () =>
              slots.register(
                {
                  name: 'settings.section',
                  id: 'bili-audit',
                  order: 40,
                  label: '推荐流选择审计',
                },
                () => h(Panel),
              ),
            ),
          'bili-audit: audit settings page',
        )
      },
    }
  },
})
