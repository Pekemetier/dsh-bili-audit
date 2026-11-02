/**
 * Minimal local-audit settings page.
 *
 * It edits the video library and custom trajectory as JSON, switches the tool
 * exposure mode, and resets the deterministic replay cursor. It never talks to
 * Bilibili or any other remote service.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-qq',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React
    const API = '/api/bili-fav'

    const CSS = `
[data-ba-page]{display:flex;flex-direction:column;gap:14px;max-width:920px;padding:2px 2px 28px;
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
[data-ba-select],[data-ba-textarea]{box-sizing:border-box;width:100%;border-radius:8px;font:inherit;
  color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);}
[data-ba-select]{padding:7px 9px;font-size:12px;}
[data-ba-textarea]{padding:9px;min-height:270px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:17px;resize:vertical;}
[data-ba-select]:focus,[data-ba-textarea]:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
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

    function Panel() {
      const [status, setStatus] = useState(null)
      const [libraryText, setLibraryText] = useState('')
      const [trajectoryText, setTrajectoryText] = useState('')
      const [toolMode, setToolMode] = useState('recommend-only')
      const [trajectoryId, setTrajectoryId] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)

      const load = useCallback(async (clearNotice = true) => {
        setBusy('load')
        try {
          const data = await getJson('/status')
          setStatus(data)
          setLibraryText(pretty(data.libraryDocument))
          setTrajectoryText(pretty(data.trajectoryDocument))
          setToolMode(data.config?.toolMode || 'recommend-only')
          setTrajectoryId(data.config?.trajectoryId || '')
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
          await postJson('/config', { toolMode, trajectoryId })
          setNotice({ type: 'ok', text: '工具模式与轨迹选择已保存。' })
        })

      const saveLibrary = () =>
        run('library', async () => {
          const document = JSON.parse(libraryText)
          await postJson('/library', { document })
          setNotice({ type: 'ok', text: '视频库已保存；轨迹 fingerprint 未变，游标不会被重置。' })
        })

      const saveTrajectory = () =>
        run('trajectory', async () => {
          const document = JSON.parse(trajectoryText)
          await postJson('/trajectory', { document })
          setNotice({ type: 'ok', text: '轨迹已保存；内容变化会生成新 fingerprint，并从第 1 批开始。' })
        })

      const reset = (scope) =>
        run(`reset-${scope}`, async () => {
          await postJson('/reset', { scope })
          setNotice({ type: 'ok', text: scope === 'all' ? '所有轨迹游标已重置。' : '当前轨迹游标已重置。' })
        })

      const trajectory = status?.status?.trajectory
      const library = status?.status?.library
      const events = status?.status?.recentEvents || []
      const selections = status?.status?.recentSelections || []

      return h(
        'div',
        { 'data-ba-page': '' },
        h(
          'div',
          null,
          h('div', { 'data-ba-title': '' }, '推荐流选择审计', h('span', { 'data-ba-badge': '' }, `v${status?.version || '?'}`)),
          h('div', { 'data-ba-sub': '' }, '完全离线的固定轨迹回放：模型只负责选择，非模型内容来自本地视频库和自定义轨迹。'),
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
            h('div', { 'data-ba-stat': '' }, h('b', null, library?.videos ?? 0), h('span', null, '视频库条目')),
            h('div', { 'data-ba-stat': '' }, h('b', null, status?.status?.recentSelections?.length ?? 0), h('span', null, '选择记录')),
          ),
          h('div', { 'data-ba-note': '' }, `当前轨迹：${trajectory?.name || trajectory?.id || '—'} · fingerprint ${trajectory?.fingerprint || '—'}`),
          h('div', { 'data-ba-note': '' }, status?.prompt || ''),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, status?.files?.library || ''),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, status?.files?.trajectory || ''),
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
              h('span', { 'data-ba-note': '' }, '轨迹数据库中的 active id（单轨迹可留空）'),
              h('input', {
                'data-ba-select': '',
                value: trajectoryId,
                placeholder: 'semantic-perturbation-demo',
                onChange: (event) => setTrajectoryId(event.target.value),
              }),
            ),
          ),
          h(
            'div',
            { 'data-ba-row': '' },
            h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveConfig }, '保存模式'),
            h('button', { 'data-ba-btn': '', disabled: Boolean(busy), onClick: () => reset('active') }, '重置当前轨迹游标'),
            h('button', { 'data-ba-btn': '', 'data-danger': '', disabled: Boolean(busy), onClick: () => reset('all') }, '重置全部'),
            h('button', { 'data-ba-btn': '', disabled: Boolean(busy), onClick: () => load() }, '重新读取'),
          ),
          h('div', { 'data-ba-note': '' }, 'recommend-only 时模型无需在多个工具间选择，直接调用 bili_fav_recommend。'),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '视频库 JSON'),
          h('div', { 'data-ba-note': '' }, '视频条目 id 形如 why_food_eat.less_star；recommendation 与 watch 可自由存文字、图片描述、字幕等 agent 可读内容。'),
          h('textarea', {
            'data-ba-textarea': '',
            value: libraryText,
            spellCheck: false,
            onChange: (event) => setLibraryText(event.target.value),
          }),
          h(
            'div',
            { 'data-ba-row': '' },
            h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveLibrary }, '保存视频库'),
          ),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '自定义轨迹 JSON'),
          h('div', { 'data-ba-note': '' }, 'batches 的顺序就是未来固定弹出的顺序。每条可直接写视频 id，也可以用 recommendation/watch 覆盖或完整内联。'),
          h('textarea', {
            'data-ba-textarea': '',
            value: trajectoryText,
            spellCheck: false,
            onChange: (event) => setTrajectoryText(event.target.value),
          }),
          h(
            'div',
            { 'data-ba-row': '' },
            h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveTrajectory }, '保存轨迹'),
          ),
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
                    `${event.at || ''} · ${event.type} · ${event.batchId || ''} · cursor metadata ${event.batchIndex ?? ''}${event.message ? ` · ${event.message}` : ''}`,
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
                  id: 'bili-fav',
                  order: 40,
                  label: '推荐流选择审计',
                },
                () => h(Panel),
              ),
            ),
          'bili-fav: audit settings page',
        )
      },
    }
  },
})
